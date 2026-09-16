import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type Page, test } from "@playwright/test";
import { LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY } from "../../src/i18n/config";

/**
 * The join between two clips is smoothed over while watching the sequence.
 *
 * The export side is checked in the browser suite, frame by frame. What only the
 * real app can show is the other half, and it is the harder one: the player of
 * the outgoing clip is torn down at the join, so the picture has to be copied out
 * of it before it goes and faded by a clock of its own — nothing else is running
 * during the gap while the next player mounts.
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

test("playing across a clip boundary holds the picture before it", async () => {
	test.setTimeout(240_000);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-clip-transitions-e2e-"));
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
		const take = path.join(recordingsDir, "joined.webm");
		const projectPath = path.join(recordingsDir, "joined.openscreen");
		fs.copyFileSync(TAKE, take);
		created.push(take, projectPath);

		// A short intro card, then a take: the card gives way one second in, and that
		// join is the one nothing in the player itself can smooth over.
		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				version: 4,
				clips: [
					{ id: "card-1", media: null, durationMs: 1_000, title: "Intro card" },
					{ id: "clip-1", media: { screenVideoPath: take }, editor: {} },
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
		await expect(editor.getByTestId("testId-clip-clip-1")).toBeVisible({ timeout: 60_000 });

		await editor.getByTestId("testId-watch-sequence").click();
		const preview = editor.getByTestId("testId-sequence-preview");
		await expect(preview).toBeVisible();
		await expect(editor.getByTestId("testId-sequence-play")).toBeEnabled({ timeout: 30_000 });
		await expect(preview).toHaveAttribute("data-clip-id", "card-1");

		// Nothing is being smoothed over before playback starts.
		expect(await overlayOpacity(editor, "testId-clip-transition-frozen")).toBe(0);

		await editor.getByTestId("testId-sequence-play").click();

		let heldOverTheJoin = 0;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const state = await editor.evaluate(() => {
				const root = document.querySelector<HTMLElement>('[data-testid="testId-sequence-preview"]');
				const frozen = document.querySelector<HTMLElement>(
					'[data-testid="testId-clip-transition-frozen"]',
				);
				return {
					clipId: root?.dataset.clipId ?? null,
					opacity: Number(frozen?.style.opacity ?? "0"),
				};
			});
			// Only once the recording is on screen: that is the card being held over it.
			if (state.clipId === "clip-1") heldOverTheJoin = Math.max(heldOverTheJoin, state.opacity);
			if (heldOverTheJoin > 0.2) break;
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
		expect(heldOverTheJoin, "the clip boundary went by with nothing held over it").toBeGreaterThan(
			0.2,
		);

		// And it clears itself rather than staying up over the rest of the video.
		await expect
			.poll(() => overlayOpacity(editor, "testId-clip-transition-frozen"), {
				timeout: 15_000,
				message: "the held picture never faded away",
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
