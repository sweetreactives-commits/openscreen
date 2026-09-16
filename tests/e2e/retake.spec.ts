import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type Page, test } from "@playwright/test";
import { LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY } from "../../src/i18n/config";

/**
 * Recording another take for a project that was never saved.
 *
 * This is the whole point of the multi-clip work, and the hardest part of it to
 * believe without running it: the editor window is destroyed on the way to the
 * recorder, so everything the user had — the take, its edits, the project itself —
 * has to survive outside that window and come back with the new take appended.
 *
 * It replaces the guard that used to stand here ("going back to recording asks
 * about unsaved edits first"). The guard existed because the trip to the recorder
 * threw unsaved work away; now nothing is thrown away, so the stronger claim is
 * tested instead — the work comes back.
 *
 * The capture itself is not driven: no e2e in this project records a screen. What
 * stands in for it is the same handoff the recorder performs when it stops —
 * setCurrentRecordingSession, then switchToEditor — so everything after the
 * capture is the real path.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(__dirname, "../../dist-electron/main.js");
const TAKE_ONE = path.join(__dirname, "../fixtures/sample.webm");
const TAKE_TWO = path.join(__dirname, "../fixtures/sample-with-audio.webm");
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
					"io.modelcontextprotocol/clientInfo": { name: "retake-e2e", version: "1" },
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

test("a take recorded from the editor joins the project, and the first take keeps its edits", async () => {
	test.setTimeout(420_000);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-retake-e2e-"));
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
	let editorWindow: Page | null = null;

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		const resolvedUserData = await app.evaluate(({ app: electronApp }) =>
			electronApp.getPath("userData"),
		);
		const endpoint = JSON.parse(
			fs.readFileSync(path.join(resolvedUserData, "mcp.json"), "utf-8"),
		) as McpEndpoint;
		const stashFile = path.join(resolvedUserData, "retake-pending.openscreen");

		const recordingsDir = path.join(resolvedUserData, "recordings");
		fs.mkdirSync(recordingsDir, { recursive: true });
		const takeOne = path.join(recordingsDir, "take-one.webm");
		const takeTwo = path.join(recordingsDir, "take-two.webm");
		fs.copyFileSync(TAKE_ONE, takeOne);
		fs.copyFileSync(TAKE_TWO, takeTwo);
		created.push(takeOne, takeTwo);

		// Pin the locale: this clicks a button by its English name.
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
		const zoomCount = async () =>
			((await call(endpoint, "get_project")).regions as { zooms: unknown[] }).zooms.length;

		await waitForOpen();
		// An edit on the first take. The project has never been saved, so this is the
		// work that used to be destroyed by the trip to the recorder.
		await call(endpoint, "apply_commands", {
			commands: [{ op: "add_zoom", startMs: 200, endMs: 900, scale: 2 }],
		});
		expect(await zoomCount()).toBe(1);

		await editorWindow.getByRole("button", { name: "Return to Recorder" }).click();
		await expect(editorWindow.getByText(/added to this project/)).toBeVisible();
		await editorWindow.getByRole("button", { name: "Confirm" }).click();

		// The editor is gone and the project is waiting on disk in its place.
		await expect.poll(() => fs.existsSync(stashFile), { timeout: 15_000 }).toBe(true);
		const parked = JSON.parse(fs.readFileSync(stashFile, "utf-8"));
		expect(parked.clips, "the parked project has no clips").toHaveLength(1);

		// The recorder window is rebuilt from scratch, and the editor's dying window
		// can still be around for a moment, so take whichever live window is not the
		// editor rather than the next one to appear.
		let recorderWindow: Page | null = null;
		const recorderDeadline = Date.now() + 30_000;
		while (Date.now() < recorderDeadline) {
			recorderWindow =
				app.windows().find((w) => !w.isClosed() && !w.url().includes("windowType=editor")) ?? null;
			if (recorderWindow) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		if (!recorderWindow) throw new Error("the recorder never came back");
		await recorderWindow.waitForLoadState("domcontentloaded");

		// What the recorder does when a capture stops. Switching is its own call and
		// its own catch: it destroys the very window making it.
		await recorderWindow.evaluate(
			(videoPath: string) =>
				window.electronAPI.setCurrentRecordingSession({
					screenVideoPath: videoPath,
					createdAt: Date.now(),
				}),
			takeTwo,
		);
		try {
			await recorderWindow.evaluate(() => window.electronAPI.switchToEditor());
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
			timeout: 30_000,
		});
		const editor = editorWindow;
		await editor.waitForLoadState("domcontentloaded");
		await expect(editor.getByTestId("testId-export-panel-button")).toBeVisible({ timeout: 60_000 });

		// Both takes are in the project, and the new one is the one being edited.
		await expect(editor.getByTestId("testId-clip-clip-1")).toBeVisible({ timeout: 30_000 });
		await expect(editor.getByTestId("testId-clip-clip-2")).toBeVisible();
		await expect(editor.getByTestId("testId-clip-clip-2")).toBeDisabled();
		await expect(editor.getByTestId("testId-clip-clip-1")).toHaveText(/take-one/);

		// The parked copy is consumed, not left behind for the next recording to find.
		expect(fs.existsSync(stashFile), "the parked project outlived its retake").toBe(false);

		await waitForOpen();
		// The new take is untouched, and the first take's zoom waited for it.
		expect(await zoomCount(), "the new take arrived with edits on it").toBe(0);
		await editor.getByTestId("testId-clip-clip-1").click();
		await expect
			.poll(zoomCount, { timeout: 30_000, message: "the first take's edits were lost" })
			.toBe(1);
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

/**
 * The same trip, for a project that already lives in a file.
 *
 * Nothing needs parking then — the file on disk says it all — but the editor has
 * to come back pointed at that same file, or the first save after a retake would
 * quietly ask for a new one.
 */
test("a retake on a saved project appends to it and saves back to the same file", async () => {
	test.setTimeout(420_000);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-retake-saved-e2e-"));
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
		},
	});

	const created: string[] = [];
	let editorWindow: Page | null = null;

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		const resolvedUserData = await app.evaluate(({ app: electronApp }) =>
			electronApp.getPath("userData"),
		);
		const stashFile = path.join(resolvedUserData, "retake-pending.openscreen");
		const recordingsDir = path.join(resolvedUserData, "recordings");
		fs.mkdirSync(recordingsDir, { recursive: true });
		const takeOne = path.join(recordingsDir, "take-one.webm");
		const takeTwo = path.join(recordingsDir, "take-two.webm");
		const projectPath = path.join(recordingsDir, "saved.openscreen");
		fs.copyFileSync(TAKE_ONE, takeOne);
		fs.copyFileSync(TAKE_TWO, takeTwo);
		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				version: 4,
				clips: [{ id: "clip-1", media: { screenVideoPath: takeOne }, editor: {} }],
				editor: {},
			}),
		);
		created.push(takeOne, takeTwo, projectPath);

		await hudWindow.evaluate(
			([localeKey, promptKey]: [string, string]) => {
				localStorage.setItem(localeKey, "en");
				localStorage.setItem(promptKey, "1");
			},
			[LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY] as [string, string],
		);
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
		await editorWindow.waitForLoadState("domcontentloaded");
		await expect(editorWindow.getByTestId("testId-export-panel-button")).toBeVisible({
			timeout: 60_000,
		});

		await editorWindow.getByRole("button", { name: "Return to Recorder" }).click();
		await editorWindow.getByRole("button", { name: "Confirm" }).click();

		let recorderWindow: Page | null = null;
		const recorderDeadline = Date.now() + 30_000;
		while (Date.now() < recorderDeadline) {
			recorderWindow =
				app.windows().find((w) => !w.isClosed() && !w.url().includes("windowType=editor")) ?? null;
			if (recorderWindow) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		if (!recorderWindow) throw new Error("the recorder never came back");
		await recorderWindow.waitForLoadState("domcontentloaded");

		// A saved project with nothing unsaved on it is already on disk: no copy needed.
		expect(fs.existsSync(stashFile), "a project that needed no parking was parked anyway").toBe(
			false,
		);

		await recorderWindow.evaluate(
			(videoPath: string) =>
				window.electronAPI.setCurrentRecordingSession({
					screenVideoPath: videoPath,
					createdAt: Date.now(),
				}),
			takeTwo,
		);
		try {
			await recorderWindow.evaluate(() => window.electronAPI.switchToEditor());
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
			timeout: 30_000,
		});
		const editor = editorWindow;
		await editor.waitForLoadState("domcontentloaded");
		await expect(editor.getByTestId("testId-clip-clip-2")).toBeVisible({ timeout: 60_000 });

		// Saving goes back to the file the project came from, with both takes in it.
		// Asking where to save would mean the editor had lost track of where it came
		// from, so the dialog is watched rather than left to hang a headless run.
		await app.evaluate(({ dialog }) => {
			(globalThis as Record<string, unknown>)["__saveDialogs"] = 0;
			dialog.showSaveDialog = (async () => {
				(globalThis as Record<string, unknown>)["__saveDialogs"] =
					((globalThis as Record<string, unknown>)["__saveDialogs"] as number) + 1;
				return { canceled: true, filePath: undefined };
			}) as unknown as typeof dialog.showSaveDialog;
		});

		await editor.getByRole("button", { name: "Save Project" }).click();
		await expect
			.poll(() => JSON.parse(fs.readFileSync(projectPath, "utf-8")).clips?.length ?? 0, {
				timeout: 20_000,
				message: "the retake never reached the project file",
			})
			.toBe(2);
		expect(
			await app.evaluate(() => (globalThis as Record<string, unknown>)["__saveDialogs"]),
			"the editor asked where to save a project it already had a file for",
		).toBe(0);
		const saved = JSON.parse(fs.readFileSync(projectPath, "utf-8"));
		expect(
			saved.clips.map((clip: { media?: { screenVideoPath?: string } }) =>
				path.basename(clip.media?.screenVideoPath ?? ""),
			),
		).toEqual(["take-one.webm", "take-two.webm"]);
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

/**
 * The same trip, started by an agent rather than by the user.
 *
 * start_recording used to be refused outright while the editor held unsaved work,
 * on the grounds that switching to the recorder would destroy it. Since the
 * retake work that is no longer true for the user, and this proves it is no
 * longer true for an agent either: it edits a project that has never been saved,
 * asks to record, and finds its own edit waiting when the take comes back.
 */
test("an agent's recording keeps the project it was editing", async () => {
	test.setTimeout(420_000);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-retake-agent-e2e-"));
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
	let editorWindow: Page | null = null;
	let hudWindow: Page | null = null;

	try {
		hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		const resolvedUserData = await app.evaluate(({ app: electronApp }) =>
			electronApp.getPath("userData"),
		);
		const endpoint = JSON.parse(
			fs.readFileSync(path.join(resolvedUserData, "mcp.json"), "utf-8"),
		) as McpEndpoint;
		const stashFile = path.join(resolvedUserData, "retake-pending.openscreen");
		const recordingsDir = path.join(resolvedUserData, "recordings");
		fs.mkdirSync(recordingsDir, { recursive: true });
		const takeOne = path.join(recordingsDir, "agent-take-one.webm");
		const takeTwo = path.join(recordingsDir, "agent-take-two.webm");
		fs.copyFileSync(TAKE_ONE, takeOne);
		fs.copyFileSync(TAKE_TWO, takeTwo);
		created.push(takeOne, takeTwo);

		// The approval dialog is the one guard a test may not click through, so it is
		// answered in the main process instead. Everything else runs for real.
		await app.evaluate(({ dialog }) => {
			const globals = globalThis as Record<string, unknown>;
			globals["__recordPrompts"] = 0;
			globals["__realMessageBox"] = dialog.showMessageBox;
			dialog.showMessageBox = (async () => {
				globals["__recordPrompts"] = (globals["__recordPrompts"] as number) + 1;
				return { response: 1, checkboxChecked: false };
			}) as unknown as typeof dialog.showMessageBox;
		});
		await hudWindow.evaluate(() => window.electronAPI.setMcpAllowRecording(true));

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
		const zoomCount = async () =>
			((await call(endpoint, "get_project")).regions as { zooms: unknown[] }).zooms.length;

		await waitForOpen();
		// The agent's own edit, on a project that has never been saved: exactly the
		// state that used to make its next call impossible.
		await call(endpoint, "apply_commands", {
			commands: [{ op: "add_zoom", startMs: 200, endMs: 900, scale: 2 }],
		});
		expect(await zoomCount()).toBe(1);

		// `call` fails the test on a refusal, quoting it — so getting past this line is
		// the assertion that the recording was not refused.
		await call(endpoint, "start_recording");
		// Put the real one back the moment it has served its purpose: a stub left in
		// place answers every later dialog too, including any raised while windows
		// are being torn down.
		await app.evaluate(({ dialog }) => {
			const globals = globalThis as Record<string, unknown>;
			dialog.showMessageBox = globals["__realMessageBox"] as typeof dialog.showMessageBox;
		});
		expect(
			await app.evaluate(() => (globalThis as Record<string, unknown>)["__recordPrompts"]),
			"the user was not asked",
		).toBe(1);

		// The project is waiting on disk, with the agent's edit in it.
		await expect.poll(() => fs.existsSync(stashFile), { timeout: 15_000 }).toBe(true);
		const parked = JSON.parse(fs.readFileSync(stashFile, "utf-8"));
		expect(parked.clips, "the parked project has no clips").toHaveLength(1);
		expect(
			parked.clips[0].editor?.zoomRegions ?? parked.editor?.zoomRegions,
			"the agent's edit was not parked with the project",
		).toHaveLength(1);

		let recorderWindow: Page | null = null;
		const recorderDeadline = Date.now() + 30_000;
		while (Date.now() < recorderDeadline) {
			recorderWindow =
				app.windows().find((w) => !w.isClosed() && !w.url().includes("windowType=editor")) ?? null;
			if (recorderWindow) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		if (!recorderWindow) throw new Error("the recorder never came back");
		await recorderWindow.waitForLoadState("domcontentloaded");

		await recorderWindow.evaluate(
			(videoPath: string) =>
				window.electronAPI.setCurrentRecordingSession({
					screenVideoPath: videoPath,
					createdAt: Date.now(),
				}),
			takeTwo,
		);
		try {
			await recorderWindow.evaluate(() => window.electronAPI.switchToEditor());
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
			timeout: 30_000,
		});
		const editor = editorWindow;
		await editor.waitForLoadState("domcontentloaded");
		await expect(editor.getByTestId("testId-clip-clip-2")).toBeVisible({ timeout: 60_000 });

		await waitForOpen();
		expect(await zoomCount(), "the new take arrived with edits on it").toBe(0);
		await editor.getByTestId("testId-clip-clip-1").click();
		await expect
			.poll(zoomCount, {
				timeout: 30_000,
				message: "the agent's edit was lost to its own recording",
			})
			.toBe(1);
	} finally {
		await hudWindow
			?.evaluate(() => window.electronAPI.setMcpAllowRecording(false))
			.catch(() => {
				// Window already gone; the setting stays as the next run finds it.
			});
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
