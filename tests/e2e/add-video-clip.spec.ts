import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY } from "../../src/i18n/config";

/**
 * Adding a video to an open project, the way a user does it.
 *
 * The first point in the multi-clip work where a sequence of two recordings can
 * be built by hand rather than by writing a project file: pick a video, see it in
 * the strip, export both, and switch between them without either losing its edits.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(__dirname, "../../dist-electron/main.js");
const SILENT_TAKE = path.join(__dirname, "../fixtures/sample.webm");
// Deliberately outside the recordings folder, so it has to be copied in.
const PICKED_VIDEO = path.join(__dirname, "../fixtures/sample-with-audio.webm");
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
					"io.modelcontextprotocol/clientInfo": { name: "add-video-e2e", version: "1" },
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

test("a picked video joins the project, exports, and keeps edits apart when switching", async () => {
	test.setTimeout(420_000);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-add-video-e2e-"));
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
	let recordingsDir = "";
	let editorWindow: Awaited<ReturnType<typeof app.waitForEvent>> | null = null;

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		await app.evaluate(({ ipcMain }) => {
			(globalThis as Record<string, unknown>)["__dirtyReports"] = [];
			ipcMain.on("set-has-unsaved-changes", (_event, hasChanges: boolean) => {
				((globalThis as Record<string, unknown>)["__dirtyReports"] as boolean[]).push(hasChanges);
			});
		});

		const resolvedUserData = await app.evaluate(({ app: electronApp }) =>
			electronApp.getPath("userData"),
		);
		const endpoint = JSON.parse(
			fs.readFileSync(path.join(resolvedUserData, "mcp.json"), "utf-8"),
		) as McpEndpoint;

		recordingsDir = path.join(resolvedUserData, "recordings");
		fs.mkdirSync(recordingsDir, { recursive: true });
		const takeOne = path.join(recordingsDir, "take-1.webm");
		fs.copyFileSync(SILENT_TAKE, takeOne);
		created.push(takeOne);

		await hudWindow.evaluate(
			([localeKey, promptKey]: [string, string]) => {
				localStorage.setItem(localeKey, "en");
				localStorage.setItem(promptKey, "1");
			},
			[LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY] as [string, string],
		);
		await hudWindow.evaluate(
			(videoPath: string) => window.electronAPI.setCurrentVideoPath(videoPath),
			takeOne,
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

		const waitForOpen = async () => {
			const deadline = Date.now() + 60_000;
			let summary = await call(endpoint, "get_project");
			while (summary.open !== true && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				summary = await call(endpoint, "get_project");
			}
			expect(summary.open).toBe(true);
			return summary;
		};
		const firstSummary = await waitForOpen();
		const durationMs = (firstSummary.source as { durationMs: number }).durationMs;

		// An edit on the first take, to see whether it survives switching away and back.
		await call(endpoint, "apply_commands", {
			commands: [{ op: "add_zoom", startMs: 200, endMs: 900, scale: 2 }],
		});

		// The native file dialog cannot be driven, so it answers with the fixture.
		await app.evaluate(({ dialog }, picked: string) => {
			dialog.showOpenDialog = (async () => ({
				canceled: false,
				filePaths: [picked],
			})) as unknown as typeof dialog.showOpenDialog;
		}, PICKED_VIDEO);

		await editorWindow.getByTestId("testId-add-video-clip").click();

		// It shows up in the strip under its copied name.
		await expect(editorWindow.getByText(/sample-with-audio/).first()).toBeVisible({
			timeout: 15_000,
		});
		const copies = fs.readdirSync(recordingsDir).filter((name) => name.startsWith("imported-"));
		expect(copies, "a video from outside the recordings folder should be copied in").toHaveLength(
			1,
		);
		const copied = path.join(recordingsDir, copies[0]);
		created.push(copied);
		expect(fs.readFileSync(copied).equals(fs.readFileSync(PICKED_VIDEO))).toBe(true);

		await expect
			.poll(
				async () => {
					const reports = (await app.evaluate(
						() => (globalThis as Record<string, unknown>)["__dirtyReports"],
					)) as boolean[];
					return reports[reports.length - 1] ?? false;
				},
				{ timeout: 15_000, message: "adding a video did not mark the project as changed" },
			)
			.toBe(true);

		// Both takes go out: silence for the first, the tone for the second.
		let state = await call(endpoint, "export_video", { fileName: "added.mp4", format: "mp4" });
		const exportDeadline = Date.now() + 300_000;
		while (state.status === "running" && Date.now() < exportDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			state = await call(endpoint, "export_video");
		}
		expect(state.status, `export ended as ${JSON.stringify(state)}`).toBe("ready");
		const exportedPath = state.path as string;
		created.push(exportedPath);

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
					first: peak(data, decoded.sampleRate, 0, 1.8),
					second: peak(data, decoded.sampleRate, 2.3, 3.8),
				};
			} catch (error) {
				return { duration: 0, first: 0, second: 0, error: String(error) };
			} finally {
				await context.close();
			}
		}, bytes);
		expect(audio, "the export has no decodable audio track").not.toHaveProperty("error");
		expect(audio.duration).toBeGreaterThan(3.5);
		expect(audio.duration).toBeLessThan(4.6);
		expect(audio.first, "the tone played over the first take").toBeLessThan(0.02);
		expect(audio.second, "the added video's sound is missing").toBeGreaterThan(0.05);

		const mediaPath = async () =>
			((await call(endpoint, "get_project")).media as { screenVideoPath: string }).screenVideoPath;
		const zoomCount = async () =>
			((await call(endpoint, "get_project")).regions as { zooms: unknown[] }).zooms.length;

		// Switch to the added take: its video loads, and the first take's zoom does not follow.
		await editorWindow.getByTestId("testId-clip-clip-2").click();
		await expect.poll(mediaPath, { timeout: 15_000 }).toBe(copied);
		await waitForOpen();
		expect(await zoomCount(), "the first take's zoom leaked into the second").toBe(0);

		// And back: the zoom is still there.
		await editorWindow.getByTestId("testId-clip-clip-1").click();
		await expect.poll(mediaPath, { timeout: 15_000 }).toBe(takeOne);
		await waitForOpen();
		expect(await zoomCount(), "switching away and back lost the first take's zoom").toBe(1);
		expect(durationMs).toBeGreaterThan(0);
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
