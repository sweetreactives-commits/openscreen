import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY } from "../../src/i18n/config";

/**
 * Sound survives an export with a speed change, in the real app.
 *
 * Speed regions send the audio through a real-time pass — the recording is
 * played through a media element so the pitch survives, and what comes out is
 * recorded. No test had ever exported with a speed region at all, in any
 * environment, and in the headless browser suite that pass never gets past
 * resuming its AudioContext. This asks whether Electron behaves any better,
 * which the whole multi-clip audio design depends on.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(__dirname, "../../dist-electron/main.js");
const TEST_VIDEO = path.join(__dirname, "../fixtures/sample-with-audio.webm");
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
					"io.modelcontextprotocol/clientInfo": { name: "speed-audio-e2e", version: "1" },
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

test("an export with a speed region keeps its sound", async () => {
	test.setTimeout(420_000);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-speed-audio-e2e-"));
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

	let testVideoInRecordings = "";
	let exportedPath = "";
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
		testVideoInRecordings = path.join(recordingsDir, "speed-audio-sample.webm");
		fs.mkdirSync(recordingsDir, { recursive: true });
		fs.copyFileSync(TEST_VIDEO, testVideoInRecordings);

		await hudWindow.evaluate(
			([localeKey, promptKey]: [string, string]) => {
				localStorage.setItem(localeKey, "en");
				localStorage.setItem(promptKey, "1");
			},
			[LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY] as [string, string],
		);
		await hudWindow.evaluate(
			(videoPath: string) => window.electronAPI.setCurrentVideoPath(videoPath),
			testVideoInRecordings,
		);
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

		const durationMs = (summary.source as { durationMs: number }).durationMs;
		await call(endpoint, "apply_commands", {
			commands: [{ op: "set_speed", startMs: 0, endMs: durationMs, speed: 2 }],
		});

		let state = await call(endpoint, "export_video", { fileName: "speed.mp4", format: "mp4" });
		const exportDeadline = Date.now() + 240_000;
		while (state.status === "running" && Date.now() < exportDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			state = await call(endpoint, "export_video");
		}
		expect(state.status, `export ended as ${JSON.stringify(state)}`).toBe("ready");
		exportedPath = state.path as string;

		// Decoded in the app's own renderer, which has what Node lacks: an audio decoder.
		const bytes = fs.readFileSync(exportedPath).toString("base64");
		const audio = await editorWindow.evaluate(async (base64: string) => {
			const binary = atob(base64);
			const buffer = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);

			const context = new AudioContext();
			try {
				const decoded = await context.decodeAudioData(buffer.buffer);
				const data = decoded.getChannelData(0);
				let peak = 0;
				for (let i = 0; i < Math.min(data.length, Math.round(decoded.sampleRate * 0.5)); i++) {
					peak = Math.max(peak, Math.abs(data[i]));
				}
				return { duration: decoded.duration, peak };
			} catch (error) {
				return { duration: 0, peak: 0, error: String(error) };
			} finally {
				await context.close();
			}
		}, bytes);

		expect(audio, "the exported file has no decodable audio track").not.toHaveProperty("error");
		// Two seconds of tone at double speed is about one second of sound.
		expect(audio.duration).toBeGreaterThan(0.6);
		expect(audio.duration).toBeLessThan(1.6);
		expect(audio.peak, "the sped-up export came out silent").toBeGreaterThan(0.05);
	} finally {
		await editorWindow
			?.evaluate(() => window.electronAPI.setHasUnsavedChanges(false))
			.catch(() => {
				// Already gone; closing is about to happen anyway.
			});
		await app.close().catch(() => {
			// Already gone; the run is over either way.
		});
		for (const file of [testVideoInRecordings, exportedPath]) {
			if (file && fs.existsSync(file)) fs.unlinkSync(file);
		}
	}
});
