import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type Page, test } from "@playwright/test";
import { LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY } from "../../src/i18n/config";

/**
 * Watching the whole sequence plays through a card and across a seam between takes.
 *
 * The stepping logic is unit-tested on its own. What only the real app can show is
 * that the pieces hand over to each other: the card's counted clock gives way to
 * the first take's video, that video reaching its end mounts the second take's
 * player, and that player actually plays — not just that an id changed.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(__dirname, "../../dist-electron/main.js");
const TAKE_ONE = path.join(__dirname, "../fixtures/sample.webm");
const TAKE_TWO = path.join(__dirname, "../fixtures/sample-with-audio.webm");

async function previewState(editor: Page) {
	return editor.evaluate(() => {
		const root = document.querySelector<HTMLElement>('[data-testid="testId-sequence-preview"]');
		const video = root?.querySelector<HTMLVideoElement>("video.hidden") ?? null;
		return {
			clipId: root?.dataset.clipId ?? null,
			timelineMs: Number(root?.dataset.timelineMs ?? -1),
			playing: root?.dataset.playing === "true",
			videoSrc: video?.currentSrc ?? video?.src ?? "",
			videoTime: video?.currentTime ?? 0,
			videoPaused: video?.paused ?? true,
		};
	});
}

test("watching the sequence plays a card, then one take, then the next", async () => {
	test.setTimeout(240_000);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-sequence-preview-e2e-"));
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
		const takeOne = path.join(recordingsDir, "take-one.webm");
		const takeTwo = path.join(recordingsDir, "take-two.webm");
		const projectPath = path.join(recordingsDir, "watch.openscreen");
		fs.copyFileSync(TAKE_ONE, takeOne);
		fs.copyFileSync(TAKE_TWO, takeTwo);
		created.push(takeOne, takeTwo, projectPath);

		// A one-second intro card, then two two-second takes.
		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				version: 4,
				clips: [
					{ id: "card-1", media: null, durationMs: 1_000, title: "Intro card" },
					{ id: "clip-1", media: { screenVideoPath: takeOne }, editor: {} },
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
		await expect(editor.getByTestId("testId-clip-clip-2")).toBeVisible({ timeout: 60_000 });

		await editor.getByTestId("testId-watch-sequence").click();
		const preview = editor.getByTestId("testId-sequence-preview");
		await expect(preview).toBeVisible();
		// Both takes' lengths are known once playing is possible.
		await expect(editor.getByTestId("testId-sequence-play")).toBeEnabled({ timeout: 30_000 });
		await expect(editor.getByTestId("testId-sequence-segment-clip-2")).toBeVisible();
		await expect(preview).toHaveAttribute("data-clip-id", "card-1");
		await expect(editor.getByTestId("testId-sequence-card")).toBeVisible();

		await editor.getByTestId("testId-sequence-play").click();

		// Watch it play to the end, noting every clip on screen and whether the second
		// take's own video was really running.
		const seen: string[] = [];
		let secondTakePlayed = false;
		const deadline = Date.now() + 60_000;
		let state = await previewState(editor);
		while (Date.now() < deadline) {
			state = await previewState(editor);
			if (state.clipId && seen[seen.length - 1] !== state.clipId) seen.push(state.clipId);
			if (
				state.clipId === "clip-2" &&
				state.videoSrc.includes("take-two") &&
				!state.videoPaused &&
				state.videoTime > 0.5
			) {
				secondTakePlayed = true;
			}
			if (!state.playing && seen.length > 1) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		expect(seen, `clips on screen, in order: ${seen.join(" → ")}`).toEqual([
			"card-1",
			"clip-1",
			"clip-2",
		]);
		expect(secondTakePlayed, "the second take never actually played").toBe(true);
		expect(state.playing, "playback did not stop at the end").toBe(false);
		// One second of card and two two-second takes.
		expect(state.timelineMs).toBeGreaterThan(4_500);
		expect(state.timelineMs).toBeLessThanOrEqual(5_100);

		// Seeking back into the card shows the card again.
		const bar = editor.getByTestId("testId-sequence-bar");
		const box = await bar.boundingBox();
		if (!box) throw new Error("the sequence bar has no box");
		await editor.mouse.click(box.x + box.width * 0.05, box.y + box.height / 2);
		await expect(preview).toHaveAttribute("data-clip-id", "card-1");
		await expect(editor.getByTestId("testId-sequence-card")).toBeVisible();

		// And into the middle of the first take shows that take's video, paused.
		await editor.mouse.click(box.x + box.width * 0.4, box.y + box.height / 2);
		await expect(preview).toHaveAttribute("data-clip-id", "clip-1");
		await expect.poll(async () => (await previewState(editor)).videoSrc).toContain("take-one");

		await editor.getByTestId("testId-sequence-close").click();
		await expect(preview).toHaveCount(0);
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
