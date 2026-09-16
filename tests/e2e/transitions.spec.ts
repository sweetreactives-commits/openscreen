import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type Page, test } from "@playwright/test";
import { LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY } from "../../src/i18n/config";

/**
 * A cut is smoothed over in the editor, not only in the export.
 *
 * The export side is checked in the browser suite, frame by frame. What only the
 * real app can show is the other half: the player jumping a trim mid-playback,
 * noticing that it did, and holding the picture from before the cut long enough
 * to fade it out. Nothing else in the app can report that a jump happened.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(__dirname, "../../dist-electron/main.js");
const TAKE = path.join(__dirname, "../fixtures/sample.webm");

async function overlayOpacity(editor: Page, testId: string): Promise<number> {
	return editor.evaluate((id: string) => {
		const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
		return Number(element?.style.opacity ?? "0");
	}, testId);
}

test("playing through a cut fades out the frame before it", async () => {
	test.setTimeout(240_000);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-transitions-e2e-"));
	const app = await electron.launch({
		args: [
			MAIN_JS,
			"--no-sandbox",
			"--enable-unsafe-swiftshader",
			"--autoplay-policy=no-user-gesture-required",
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
		const recordingsDir = path.join(resolvedUserData, "recordings");
		fs.mkdirSync(recordingsDir, { recursive: true });
		const take = path.join(recordingsDir, "cut.webm");
		const projectPath = path.join(recordingsDir, "cut.openscreen");
		fs.copyFileSync(TAKE, take);
		created.push(take, projectPath);

		// A two-second take with half a second cut out of the middle, dissolved.
		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				version: 4,
				clips: [
					{
						id: "clip-1",
						media: { screenVideoPath: take },
						editor: { trimRegions: [{ id: "trim-1", startMs: 700, endMs: 1_200 }] },
					},
				],
				editor: { transitionStyle: "dissolve", transitionMs: 600 },
			}),
		);

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
		const editor = editorWindow;
		await editor.waitForLoadState("domcontentloaded");
		await expect(editor.getByTestId("testId-export-panel-button")).toBeVisible({ timeout: 60_000 });

		// Nothing is being smoothed over before playback starts.
		expect(await overlayOpacity(editor, "testId-transition-frozen")).toBe(0);

		// Play from the start and watch the cut go by. Started through the app's own
		// play button, so nothing races the player's seek handling.
		await editor.getByTestId("testId-play-pause-button").click();

		let sawHeldFrame = 0;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			sawHeldFrame = Math.max(
				sawHeldFrame,
				await overlayOpacity(editor, "testId-transition-frozen"),
			);
			if (sawHeldFrame > 0.2) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(sawHeldFrame, "the cut went by with nothing held over it").toBeGreaterThan(0.2);

		// And it clears itself rather than staying up over the rest of the video.
		await expect
			.poll(() => overlayOpacity(editor, "testId-transition-frozen"), {
				timeout: 15_000,
				message: "the held frame never faded away",
			})
			.toBe(0);
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
