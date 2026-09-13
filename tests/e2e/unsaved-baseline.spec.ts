import fs from "node:fs";
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

	const app = await electron.launch({
		args: [MAIN_JS, "--no-sandbox", "--enable-unsafe-swiftshader"],
		env: { ...process.env, HEADLESS: process.env["HEADLESS"] ?? "true" },
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
