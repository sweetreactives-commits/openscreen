import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY } from "../../src/i18n/config";

/**
 * Card clips can be made, edited and saved from the editor.
 *
 * Everything under this had tests before the UI existed — the model, the split,
 * the export. None of it proved a user could actually produce a card, which is
 * the only thing that makes the feature real.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(__dirname, "../../dist-electron/main.js");
const TEST_VIDEO = path.join(__dirname, "../fixtures/sample.webm");

test("an intro card can be added, titled and saved with the project", async () => {
	test.setTimeout(240_000);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-cards-e2e-"));
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

	let editorWindow: Awaited<ReturnType<typeof app.firstWindow>> | undefined;
	let testVideoInRecordings = "";

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		// What the editor says about its own state, rather than what the UI implies.
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
		testVideoInRecordings = path.join(recordingsDir, "cards-sample.webm");
		fs.mkdirSync(recordingsDir, { recursive: true });
		fs.copyFileSync(TEST_VIDEO, testVideoInRecordings);

		// Pinned locale: this clicks a button found by its English label.
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
		await editorWindow.waitForTimeout(3_000);

		// The strip is there before any card exists, or nobody would find the feature.
		const addIntro = editorWindow.getByTestId("testId-add-intro-card");
		await expect(addIntro).toBeVisible();
		await expect(editorWindow.getByTestId("testId-card-editor")).toBeHidden();

		await addIntro.click();

		// Adding selects the new card, so its editor opens without a second click.
		const cardEditor = editorWindow.getByTestId("testId-card-editor");
		await expect(cardEditor).toBeVisible({ timeout: 10_000 });

		await editorWindow.getByTestId("testId-card-title-input").fill("Hello there");
		await editorWindow.getByTestId("testId-card-title-input").blur();

		// The card shows its own title in the strip rather than the placeholder.
		await expect(editorWindow.getByText("Hello there").first()).toBeVisible();

		// And the card reached the project itself, not just the screen. Dirtiness is
		// computed by serialising the project, so the editor could only report a
		// change if the card is in what it would write to disk.
		await expect
			.poll(
				async () => {
					const reports = (await app.evaluate(
						() => (globalThis as Record<string, unknown>)["__dirtyReports"],
					)) as boolean[];
					return reports[reports.length - 1] ?? false;
				},
				{ timeout: 15_000, message: "adding a card never reached the saved project" },
			)
			.toBe(true);

		// Removing it puts the project back exactly as it was, which only holds if
		// the clip list round-trips through the snapshot cleanly.
		await editorWindow.getByRole("button", { name: "Remove card" }).click();
		await expect(editorWindow.getByTestId("testId-card-editor")).toBeHidden();
		await expect
			.poll(
				async () => {
					const reports = (await app.evaluate(
						() => (globalThis as Record<string, unknown>)["__dirtyReports"],
					)) as boolean[];
					return reports[reports.length - 1] ?? true;
				},
				{ timeout: 15_000, message: "removing the card left the project looking edited" },
			)
			.toBe(false);
	} finally {
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
