import { describe, expect, it } from "vitest";
import sampleVideoUrl from "../../../tests/fixtures/sample.webm?url";
import smallVideoUrl from "../../../tests/fixtures/sample-small.webm?url";
import { BackgroundLoadError } from "../wallpaper";
import { GifExporter } from "./gifExporter";
import type { ExportProgress } from "./types";

describe("GifExporter (real browser)", () => {
	it("exports a valid GIF blob from a real video", async () => {
		const progressEvents: ExportProgress[] = [];

		const exporter = new GifExporter({
			videoUrl: sampleVideoUrl,
			width: 320,
			height: 180,
			frameRate: 15,
			loop: true,
			sizePreset: "medium",
			wallpaper: "#1a1a2e",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
			onProgress: (p) => progressEvents.push(p),
		});

		const result = await exporter.export();

		expect(result.success, result.error).toBe(true);
		expect(result.blob).toBeInstanceOf(Blob);

		const buf = await result.blob!.arrayBuffer();
		const header = new TextDecoder().decode(new Uint8Array(buf, 0, 6));
		expect(header).toMatch(/^GIF8[79]a/);

		expect(result.blob!.size).toBeGreaterThan(1024);

		expect(progressEvents.length).toBeGreaterThan(0);

		const finalizing = progressEvents.filter((p) => p.phase === "finalizing");
		expect(finalizing.length).toBeGreaterThan(0);
		expect(finalizing.at(-1)!.percentage).toBe(100);
	});

	it("exports successfully with an image wallpaper (served by Vite dev server)", async () => {
		const exporter = new GifExporter({
			videoUrl: sampleVideoUrl,
			width: 320,
			height: 180,
			frameRate: 15,
			loop: true,
			sizePreset: "medium",
			wallpaper: "/wallpapers/wallpaper1.jpg",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		});

		const result = await exporter.export();
		expect(result.success, result.error).toBe(true);
		expect(result.blob!.size).toBeGreaterThan(1024);
	});

	it("throws BackgroundLoadError when wallpaper fails to load (no silent black fallback)", async () => {
		const exporter = new GifExporter({
			videoUrl: sampleVideoUrl,
			width: 320,
			height: 180,
			frameRate: 15,
			loop: true,
			sizePreset: "medium",
			wallpaper: "/wallpapers/does-not-exist.jpg",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		});

		const rejection = exporter.export();
		await expect(rejection).rejects.toBeInstanceOf(BackgroundLoadError);
		await expect(rejection).rejects.toMatchObject({
			url: expect.stringContaining("does-not-exist"),
		});
	});
});

describe("GifExporter with card clips (real browser)", () => {
	const base = {
		videoUrl: sampleVideoUrl,
		width: 320,
		height: 180,
		frameRate: 15 as const,
		loop: true,
		sizePreset: "medium" as const,
		wallpaper: "#1a1a2e",
		zoomRegions: [],
		showShadow: false,
		shadowIntensity: 0,
		showBlur: false,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
	};

	it("renders a title card into the file rather than dropping it", async () => {
		const plainProgress: ExportProgress[] = [];
		const plain = await new GifExporter({
			...base,
			onProgress: (p) => plainProgress.push(p),
		}).export();

		const cardProgress: ExportProgress[] = [];
		const withCard = await new GifExporter({
			...base,
			cards: { before: [{ durationMs: 1_000, title: "Hello there" }], after: [] },
			onProgress: (p) => cardProgress.push(p),
		}).export();

		expect(plain.success, plain.error).toBe(true);
		expect(withCard.success, withCard.error).toBe(true);

		// A second of card at 15fps is 15 more frames than the recording alone.
		const plainTotal = plainProgress.at(-1)?.totalFrames ?? 0;
		const cardTotal = cardProgress.at(-1)?.totalFrames ?? 0;
		expect(cardTotal - plainTotal).toBe(15);

		// And those frames are really in the file: identical bytes would mean the
		// card was counted and then never drawn.
		expect(withCard.blob!.size).not.toBe(plain.blob!.size);
	});

	it("puts an outro after the recording and counts both ends", async () => {
		const progress: ExportProgress[] = [];
		const result = await new GifExporter({
			...base,
			cards: {
				before: [{ durationMs: 400, title: "Intro" }],
				after: [{ durationMs: 400, title: "Thanks for watching" }],
			},
			onProgress: (p) => progress.push(p),
		}).export();

		expect(result.success, result.error).toBe(true);

		// Progress never overshoots: the card frames were in the budget from the start.
		expect(Math.max(...progress.map((p) => p.percentage))).toBeLessThanOrEqual(100);
		expect(progress.at(-1)?.percentage).toBe(100);
	});

	it("draws a card with no title at all, rather than failing on it", async () => {
		const result = await new GifExporter({
			...base,
			cards: { before: [{ durationMs: 400 }], after: [] },
		}).export();

		expect(result.success, result.error).toBe(true);
		expect(result.blob!.size).toBeGreaterThan(1024);
	});
});

describe("GifExporter with several recordings (real browser)", () => {
	const crop = { x: 0, y: 0, width: 1, height: 1 };

	it("renders every recording and the card between them, in order", async () => {
		const progress: ExportProgress[] = [];
		const result = await new GifExporter({
			videoUrl: sampleVideoUrl,
			width: 320,
			height: 180,
			frameRate: 15,
			loop: true,
			sizePreset: "medium",
			wallpaper: "#1a1a2e",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: crop,
			sequence: [
				{
					kind: "recording",
					recording: { videoUrl: sampleVideoUrl, zoomRegions: [], cropRegion: crop },
				},
				{ kind: "card", card: { durationMs: 1_000, title: "Next" } },
				{
					kind: "recording",
					recording: { videoUrl: smallVideoUrl, zoomRegions: [], cropRegion: crop },
				},
			],
			onProgress: (p) => progress.push(p),
		}).export();

		expect(result.success, result.error).toBe(true);
		// Two two-second recordings and a one-second card, at 15fps.
		expect(progress.at(-1)?.totalFrames).toBe(75);
		expect(Math.max(...progress.map((p) => p.percentage))).toBeLessThanOrEqual(100);
	});
});
