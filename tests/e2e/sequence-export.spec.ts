import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY } from "../../src/i18n/config";

/**
 * A project with several recordings exports all of them, from the editor itself.
 *
 * The exporters were proven on sequences in the browser suite, handed their clips
 * directly. That says nothing about whether the editor hands them over: a project
 * file with two takes has to load, keep the second take's media and edits, and
 * come out of an ordinary export as one video with both takes' sound in place.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(__dirname, "../../dist-electron/main.js");
const SILENT_TAKE = path.join(__dirname, "../fixtures/sample.webm");
const TONE_TAKE = path.join(__dirname, "../fixtures/sample-with-audio.webm");
const PROTOCOL_VERSION = "2026-07-28";

interface McpEndpoint {
	url: string;
	token: string;
}

async function call(endpoint: McpEndpoint, name: string, args: Record<string, unknown> = {}) {
	const response = await fetch(endpoint.url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${endpoint.token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": PROTOCOL_VERSION,
			"Mcp-Method": "tools/call",
			"Mcp-Name": name,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: Math.floor(Math.random() * 1e9),
			method: "tools/call",
			params: {
				name,
				arguments: args,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
					"io.modelcontextprotocol/clientInfo": { name: "sequence-export-e2e", version: "1" },
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
	});
	const body = (await response.json()) as {
		result?: { isError?: boolean; content?: Array<{ text: string }>; structuredContent?: unknown };
	};
	expect(body.result?.isError, `${name} failed: ${body.result?.content?.[0]?.text}`).toBeFalsy();
	return body.result?.structuredContent as Record<string, unknown>;
}

test("a two-take project exports both takes with their sound in place", async () => {
	test.setTimeout(420_000);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-sequence-e2e-"));
	const app = await electron.launch({
		args: [
			MAIN_JS,
			"--no-sandbox",
			"--enable-unsafe-swiftshader",
			`--user-data-dir=${userDataDir}`,
		],
		env: {
			ELECTRON_USER_DATA_DIR: userDataDir,
			...process.env,
			HEADLESS: process.env["HEADLESS"] ?? "true",
			OPENSCREEN_MCP: "full",
		},
	});

	const created: string[] = [];
	let editorWindow: Awaited<ReturnType<typeof app.waitForEvent>> | null = null;

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		const resolvedUserData = await app.evaluate(({ app: electronApp }) =>
			electronApp.getPath("userData"),
		);
		const endpoint = JSON.parse(
			fs.readFileSync(path.join(resolvedUserData, "mcp.json"), "utf-8"),
		) as McpEndpoint;

		const recordingsDir = path.join(resolvedUserData, "recordings");
		fs.mkdirSync(recordingsDir, { recursive: true });
		const takeOne = path.join(recordingsDir, "take-1.webm");
		const takeTwo = path.join(recordingsDir, "take-2.webm");
		const projectPath = path.join(recordingsDir, "two-takes.openscreen");
		fs.copyFileSync(SILENT_TAKE, takeOne);
		fs.copyFileSync(TONE_TAKE, takeTwo);
		created.push(takeOne, takeTwo, projectPath);

		// A silent take, a one-second card, then a take with a tone.
		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				version: 4,
				clips: [
					{ id: "clip-1", media: { screenVideoPath: takeOne }, editor: {} },
					{ id: "card-1", media: null, durationMs: 1_000, title: "Take two" },
					{ id: "clip-2", media: { screenVideoPath: takeTwo }, editor: {} },
				],
				editor: {},
			}),
		);

		await hudWindow.evaluate(
			([localeKey, promptKey]: [string, string]) => {
				localStorage.setItem(localeKey, "en");
				localStorage.setItem(promptKey, "1");
			},
			[LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY] as [string, string],
		);
		// Makes it the current project; the editor opens whatever is current.
		const opened = await hudWindow.evaluate(
			(file: string) => window.electronAPI.loadProjectFileFromPath(file),
			projectPath,
		);
		expect(opened.success, JSON.stringify(opened)).toBe(true);

		try {
			await hudWindow.evaluate(() => window.electronAPI.switchToEditor());
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!/closed|destroyed|target page|target closed/i.test(error.message)
			) {
				throw error;
			}
		}

		editorWindow = await app.waitForEvent("window", {
			predicate: (w) => w.url().includes("windowType=editor"),
			timeout: 15_000,
		});
		// WebCodecs may not be registered on first load, and the render needs it.
		await editorWindow.reload();
		await editorWindow.waitForLoadState("domcontentloaded");
		await expect(editorWindow.getByTestId("testId-export-panel-button")).toBeVisible({
			timeout: 60_000,
		});

		const openDeadline = Date.now() + 60_000;
		let summary = await call(endpoint, "get_project");
		while (summary.open !== true && Date.now() < openDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			summary = await call(endpoint, "get_project");
		}
		expect(summary.open).toBe(true);

		// Both takes and the card are in the strip, so the second take survived loading.
		await expect(editorWindow.getByText("Take two").first()).toBeVisible();

		let state = await call(endpoint, "export_video", { fileName: "sequence.mp4", format: "mp4" });
		const exportDeadline = Date.now() + 300_000;
		while (state.status === "running" && Date.now() < exportDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			state = await call(endpoint, "export_video");
		}
		expect(state.status, `export ended as ${JSON.stringify(state)}`).toBe("ready");
		const exportedPath = state.path as string;
		created.push(exportedPath);

		// Decoded in the app's own renderer, which has what Node lacks: an audio decoder.
		const bytes = fs.readFileSync(exportedPath).toString("base64");
		const audio = await editorWindow.evaluate(async (base64: string) => {
			const binary = atob(base64);
			const buffer = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);

			const peak = (data: Float32Array, rate: number, from: number, to: number) => {
				let loudest = 0;
				for (
					let i = Math.floor(from * rate);
					i < Math.min(data.length, Math.ceil(to * rate));
					i++
				) {
					loudest = Math.max(loudest, Math.abs(data[i]));
				}
				return loudest;
			};

			const context = new AudioContext();
			try {
				const decoded = await context.decodeAudioData(buffer.buffer);
				const data = decoded.getChannelData(0);
				return {
					duration: decoded.duration,
					beforeTone: peak(data, decoded.sampleRate, 0, 2.8),
					tone: peak(data, decoded.sampleRate, 3.3, 4.8),
				};
			} catch (error) {
				return { duration: 0, beforeTone: 0, tone: 0, error: String(error) };
			} finally {
				await context.close();
			}
		}, bytes);

		expect(audio, "the export has no decodable audio track").not.toHaveProperty("error");
		// Two two-second takes and a one-second card.
		expect(audio.duration).toBeGreaterThan(4.5);
		expect(audio.duration).toBeLessThan(5.6);
		expect(audio.beforeTone, "the tone started before its own take").toBeLessThan(0.02);
		expect(audio.tone, "the second take's sound never made it into the export").toBeGreaterThan(
			0.05,
		);
	} finally {
		await editorWindow
			?.evaluate(() => window.electronAPI.setHasUnsavedChanges(false))
			.catch(() => {
				// Already gone; closing is about to happen anyway.
			});
		await app.close().catch(() => {
			// Already gone; the run is over either way.
		});
		for (const file of created) {
			if (file && fs.existsSync(file)) fs.unlinkSync(file);
		}
	}
});
