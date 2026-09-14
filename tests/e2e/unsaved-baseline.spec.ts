import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY } from "../../src/i18n/config";
import { PREFS_KEY } from "../../src/lib/userPreferences";

/**
 * A recording nobody has edited must not report unsaved changes.
 *
 * The baseline the editor compares against is captured in an async effect, after
 * the user's preferences have already been applied to the editor state. Building
 * it from the defaults instead of the live state compared the user's own padding
 * and aspect ratio against factory values, so simply opening a recording asked
 * them to save on the way out.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(__dirname, "../../dist-electron/main.js");
const TEST_VIDEO = path.join(__dirname, "../fixtures/sample.webm");

test("a freshly opened recording is not dirty when preferences differ from defaults", async () => {
	test.setTimeout(180_000);

	// Its own profile: this spec seeds user preferences, which would otherwise
	// reach whatever else runs against the same userData directory.
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-mcp-e2e-"));
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

	let testVideoInRecordings = "";

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		// Watch what the editor reports, rather than guessing from the UI.
		await app.evaluate(({ ipcMain }) => {
			(globalThis as Record<string, unknown>)["__dirtyReports"] = [];
			ipcMain.on("set-has-unsaved-changes", (_event, hasChanges: boolean) => {
				((globalThis as Record<string, unknown>)["__dirtyReports"] as boolean[]).push(hasChanges);
			});
		});

		const userDataDir = await app.evaluate(({ app: electronApp }) =>
			electronApp.getPath("userData"),
		);
		const recordingsDir = path.join(userDataDir, "recordings");
		testVideoInRecordings = path.join(recordingsDir, "baseline-sample.webm");
		fs.mkdirSync(recordingsDir, { recursive: true });
		fs.copyFileSync(TEST_VIDEO, testVideoInRecordings);

		// A returning user whose padding and aspect ratio are not the factory ones.
		await hudWindow.evaluate(
			([prefsKey, localeKey, promptKey]: [string, string, string]) => {
				localStorage.setItem(localeKey, "en");
				localStorage.setItem(promptKey, "1");
				localStorage.setItem(
					prefsKey,
					JSON.stringify({ padding: 12, aspectRatio: "4:3", exportQuality: "best" }),
				);
			},
			[PREFS_KEY, LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY] as [string, string, string],
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

		const editorWindow = await app.waitForEvent("window", {
			predicate: (w) => w.url().includes("windowType=editor"),
			timeout: 15_000,
		});
		await editorWindow.waitForLoadState("domcontentloaded");
		await expect(editorWindow.getByTestId("testId-export-panel-button")).toBeVisible({
			timeout: 60_000,
		});
		// Let preferences hydrate and the baseline settle.
		await editorWindow.waitForTimeout(4_000);

		const reports = (await app.evaluate(
			() => (globalThis as Record<string, unknown>)["__dirtyReports"],
		)) as boolean[];

		expect(reports.length, "the editor never reported its state").toBeGreaterThan(0);
		expect(
			reports[reports.length - 1],
			`nobody edited anything, yet the editor reported: ${JSON.stringify(reports)}`,
		).toBe(false);
	} finally {
		await app.close().catch(() => {
			// Already gone; the run is over either way.
		});
		if (testVideoInRecordings && fs.existsSync(testVideoInRecordings)) {
			fs.unlinkSync(testVideoInRecordings);
		}
	}
});

/**
 * "Back to recording" must not throw unsaved work away.
 *
 * The button hands the app to the recorder, and the main process force-closes
 * the editor window to do it — which deliberately skips the unsaved-changes
 * guard that the window's own close button relies on. So nothing stood between
 * an edited project and its destruction, while the confirmation reassured the
 * user that "your current session has been saved": true of the recorded video,
 * false of every edit layered on top of it.
 */
test("going back to recording asks about unsaved edits first", async () => {
	// Longer than its neighbour: this one waits for the editor, then for an edit
	// to register, before it can assert anything.
	test.setTimeout(240_000);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-record-guard-e2e-"));
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

	let testVideoInRecordings = "";
	// Hoisted so the teardown can reach it: it has to clear the dirty flag before
	// the app can close.
	let editorWindow: Awaited<ReturnType<typeof app.firstWindow>> | undefined;

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		// Watch what the editor reports about its own dirtiness, rather than
		// inferring it from the UI.
		await app.evaluate(({ ipcMain }) => {
			(globalThis as Record<string, unknown>)["__dirtyReports"] = [];
			ipcMain.on("set-has-unsaved-changes", (_event, hasChanges: boolean) => {
				((globalThis as Record<string, unknown>)["__dirtyReports"] as boolean[]).push(hasChanges);
			});
		});

		const resolvedUserData = await app.evaluate(({ app: electronApp }) =>
			electronApp.getPath("userData"),
		);
		const recordingsDir = path.join(resolvedUserData, "recordings");
		testVideoInRecordings = path.join(recordingsDir, "record-guard-sample.webm");
		fs.mkdirSync(recordingsDir, { recursive: true });
		fs.copyFileSync(TEST_VIDEO, testVideoInRecordings);

		// Pin the locale: this asserts on a dialog, and the machine's own language
		// would otherwise decide whether the test passes.
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
		await editorWindow.waitForLoadState("domcontentloaded");
		await expect(editorWindow.getByTestId("testId-export-panel-button")).toBeVisible({
			timeout: 60_000,
		});
		// Let preferences hydrate, so the dirty baseline has settled before editing.
		await editorWindow.waitForTimeout(4_000);

		// Make the project dirty: "z" adds a zoom region.
		await editorWindow.locator("body").click({ position: { x: 400, y: 200 } });
		await editorWindow.keyboard.press("z");

		// Wait for the editor to actually say it is dirty; pressing the key and
		// hoping would make the rest of this test prove nothing.
		await expect
			.poll(
				async () => {
					const reports = (await app.evaluate(
						() => (globalThis as Record<string, unknown>)["__dirtyReports"],
					)) as boolean[];
					return reports[reports.length - 1] ?? false;
				},
				{ timeout: 15_000, message: "the editor never reported unsaved changes after an edit" },
			)
			.toBe(true);

		await editorWindow.getByRole("button", { name: "Return to Recorder" }).click();

		// This is the bug itself: the old build answered an edited project with a
		// dialog claiming the session was saved, then discarded the edits anyway.
		await expect(
			editorWindow.getByText("Your current session has been saved."),
			"the editor offered to leave without mentioning the unsaved edits",
		).not.toBeVisible();

		// What should appear instead.
		await expect(editorWindow.getByTestId("testId-unsaved-changes-dialog")).toBeVisible({
			timeout: 10_000,
		});
		await expect(editorWindow.getByText("Save & Record")).toBeVisible();

		// And nothing has been torn down behind it: the editor is still here.
		expect(editorWindow.isClosed()).toBe(false);
	} finally {
		// This test leaves the project deliberately dirty, so the editor's own
		// close guard would hold app.close() until the worker teardown timeout —
		// with nobody in a headless run to answer the prompt.
		await editorWindow
			?.evaluate(() => window.electronAPI.setHasUnsavedChanges(false))
			.catch(() => {
				// Already gone; closing is about to happen anyway.
			});
		await app.close().catch(() => {
			// Already gone; the run is over either way.
		});
		if (testVideoInRecordings && fs.existsSync(testVideoInRecordings)) {
			fs.unlinkSync(testVideoInRecordings);
		}
	}
});
