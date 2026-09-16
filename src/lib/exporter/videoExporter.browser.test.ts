import { describe, expect, it } from "vitest";
import sampleVideoUrl from "../../../tests/fixtures/sample.webm?url";
import smallVideoUrl from "../../../tests/fixtures/sample-small.webm?url";
import audioVideoUrl from "../../../tests/fixtures/sample-with-audio.webm?url";
import { BackgroundLoadError } from "../wallpaper";
import type { ExportProgress } from "./types";
import { VideoExporter } from "./videoExporter";

describe("VideoExporter (real browser)", () => {
	it("exports a valid MP4 blob from a real video", async () => {
		const progressEvents: ExportProgress[] = [];

		const exporter = new VideoExporter({
			videoUrl: sampleVideoUrl,
			width: 320,
			height: 180,
			frameRate: 15,
			bitrate: 1_000_000,
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
		const bytes = new Uint8Array(buf);
		const ftyp = new TextDecoder().decode(bytes.slice(4, 8));
		expect(ftyp).toBe("ftyp");

		expect(result.blob!.size).toBeGreaterThan(1024);

		expect(progressEvents.length).toBeGreaterThan(0);

		const finalizing = progressEvents.filter((p) => p.phase === "finalizing");
		expect(finalizing.length).toBeGreaterThan(0);
		expect(finalizing.at(-1)!.percentage).toBe(100);
	});

	it("exports successfully with an image wallpaper (served by Vite dev server)", async () => {
		const exporter = new VideoExporter({
			videoUrl: sampleVideoUrl,
			width: 320,
			height: 180,
			frameRate: 15,
			bitrate: 1_000_000,
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
		const exporter = new VideoExporter({
			videoUrl: sampleVideoUrl,
			width: 320,
			height: 180,
			frameRate: 15,
			bitrate: 1_000_000,
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

// Speed-region audio is deliberately not tested here. That path plays the audio
// through a media element in real time, and in this headless browser the
// AudioContext never leaves "suspended" — resume() does not settle, with or
// without an autoplay flag. Electron has no such problem, so the path is covered
// by tests/e2e/speed-audio-export.spec.ts instead.
describe("VideoExporter audio with card clips (real browser)", () => {
	const base = {
		videoUrl: audioVideoUrl,
		width: 320,
		height: 180,
		frameRate: 15,
		bitrate: 1_000_000,
		wallpaper: "#1a1a2e",
		zoomRegions: [],
		showShadow: false,
		shadowIntensity: 0,
		showBlur: false,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
	};

	/** Loudest sample in a window, so "is there sound here" is one number. */
	function peak(buffer: AudioBuffer, fromSec: number, toSec: number): number {
		const data = buffer.getChannelData(0);
		const from = Math.max(0, Math.floor(fromSec * buffer.sampleRate));
		const to = Math.min(data.length, Math.ceil(toSec * buffer.sampleRate));

		let loudest = 0;
		for (let i = from; i < to; i++) loudest = Math.max(loudest, Math.abs(data[i]));
		return loudest;
	}

	async function decodeExportedAudio(blob: Blob): Promise<AudioBuffer> {
		const ctx = new AudioContext();
		try {
			return await ctx.decodeAudioData(await blob.arrayBuffer());
		} finally {
			await ctx.close();
		}
	}

	it("carries the recording's sound through with no card in front", async () => {
		const result = await new VideoExporter(base).export();
		expect(result.success, result.error).toBe(true);

		const audio = await decodeExportedAudio(result.blob!);
		// The fixture is a 440Hz tone from the first sample.
		expect(peak(audio, 0, 0.5)).toBeGreaterThan(0.05);
	});

	it("holds the sound back by exactly as long as the intro card lasts", async () => {
		const result = await new VideoExporter({
			...base,
			cards: { before: [{ durationMs: 1_000, title: "Hello" }], after: [] },
		}).export();
		expect(result.success, result.error).toBe(true);

		const audio = await decodeExportedAudio(result.blob!);

		// A second of silence while the card is on screen...
		expect(peak(audio, 0, 0.8)).toBeLessThan(0.02);
		// ...and the tone once the recording starts. Without the shift it would have
		// played over the card and finished a second early.
		expect(peak(audio, 1.2, 1.8)).toBeGreaterThan(0.05);
	});
});

describe("VideoExporter sequences of several recordings (real browser)", () => {
	const crop = { x: 0, y: 0, width: 1, height: 1 };
	const recording = (videoUrl: string) => ({
		kind: "recording" as const,
		recording: { videoUrl, zoomRegions: [], cropRegion: crop },
	});
	const base = {
		videoUrl: sampleVideoUrl,
		width: 320,
		height: 180,
		frameRate: 15,
		bitrate: 1_000_000,
		wallpaper: "#1a1a2e",
		zoomRegions: [],
		showShadow: false,
		shadowIntensity: 0,
		showBlur: false,
		cropRegion: crop,
	};

	function peak(buffer: AudioBuffer, fromSec: number, toSec: number): number {
		const data = buffer.getChannelData(0);
		const from = Math.max(0, Math.floor(fromSec * buffer.sampleRate));
		const to = Math.min(data.length, Math.ceil(toSec * buffer.sampleRate));
		let loudest = 0;
		for (let i = from; i < to; i++) loudest = Math.max(loudest, Math.abs(data[i]));
		return loudest;
	}

	it("renders every recording one after another, at different sizes", async () => {
		const progress: ExportProgress[] = [];
		const result = await new VideoExporter({
			...base,
			// 640x480 then 320x180: the renderer has to re-fit the second source rather
			// than draw it with the first one's dimensions.
			sequence: [recording(sampleVideoUrl), recording(smallVideoUrl)],
			onProgress: (p) => progress.push(p),
		}).export();

		expect(result.success, result.error).toBe(true);
		// Two two-second recordings at 15fps.
		expect(progress.at(-1)?.totalFrames).toBe(60);
		expect(Math.max(...progress.map((p) => p.percentage))).toBeLessThanOrEqual(100);
	});

	/** Pixels of the exported video at a moment, read back through a video element. */
	async function frameAt(blob: Blob, timeSec: number): Promise<Uint8ClampedArray> {
		const url = URL.createObjectURL(blob);
		const video = document.createElement("video");
		video.muted = true;
		video.src = url;
		try {
			await new Promise<void>((resolve, reject) => {
				video.onloadeddata = () => resolve();
				video.onerror = () => reject(new Error("could not load the exported video"));
			});
			video.currentTime = timeSec;
			await new Promise<void>((resolve) => {
				video.onseeked = () => resolve();
			});
			const canvas = document.createElement("canvas");
			canvas.width = video.videoWidth;
			canvas.height = video.videoHeight;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(video, 0, 0);
			return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		} finally {
			video.removeAttribute("src");
			video.load();
			URL.revokeObjectURL(url);
		}
	}

	function meanDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
		let total = 0;
		for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
		return total / a.length;
	}

	it("fits a later recording of another shape to its own size, not the first one's", async () => {
		const alone = await new VideoExporter({
			...base,
			sequence: [recording(smallVideoUrl)],
		}).export();
		const afterBigger = await new VideoExporter({
			...base,
			sequence: [recording(sampleVideoUrl), recording(smallVideoUrl)],
		}).export();
		expect(alone.success, alone.error).toBe(true);
		expect(afterBigger.success, afterBigger.error).toBe(true);

		// The same moment of the 16:9 recording, once on its own and once after a 4:3
		// one. The shapes have to differ: the sprite is stretched to the configured
		// size, so a same-shaped source drawn with stale dimensions looks identical and
		// would prove nothing. Encoding noise differs a little; a 16:9 source squeezed
		// into the first clip's 4:3 frame differs enormously.
		const own = await frameAt(alone.blob!, 1.0);
		const inSequence = await frameAt(afterBigger.blob!, 3.0);
		expect(meanDifference(own, inSequence)).toBeLessThan(8);
	});

	it("smooths over the join between clips when a transition is set", async () => {
		// A one-second card at 15fps, so the recording starts on frame 15 — one second
		// in. A card never goes through the frame renderer, where a trim's seam is
		// handled, so this is the path only the export loop can smooth over.
		const withCard = {
			...base,
			sequence: [
				{ kind: "card" as const, card: { durationMs: 1_000, title: "Intro" } },
				recording(sampleVideoUrl),
			],
		};
		const hardCut = await new VideoExporter(withCard).export();
		const dissolved = await new VideoExporter({
			...withCard,
			transitionStyle: "dissolve" as const,
			transitionMs: 600,
		}).export();
		expect(hardCut.success, hardCut.error).toBe(true);
		expect(dissolved.success, dissolved.error).toBe(true);

		// Just after the card gives way, the dissolved export is still mostly card —
		// the near-black title slide over the recording — while the hard cut is already
		// showing the recording alone.
		const cutJustAfter = await frameAt(hardCut.blob!, 1.05);
		const dissolvedJustAfter = await frameAt(dissolved.blob!, 1.05);
		expect(
			meanDifference(cutJustAfter, dissolvedJustAfter),
			"the join was not smoothed over",
		).toBeGreaterThan(15);

		// And well past it the two are the same video again: the transition ends.
		const cutLater = await frameAt(hardCut.blob!, 1.9);
		const dissolvedLater = await frameAt(dissolved.blob!, 1.9);
		expect(
			meanDifference(cutLater, dissolvedLater),
			"the held frame outstayed the transition",
		).toBeLessThan(8);
	});

	it("places each recording's sound under its own picture, silence where a take has none", async () => {
		const result = await new VideoExporter({
			...base,
			// A silent take, a card, then a take with a tone: the tone must wait for
			// both, three seconds in, rather than start the video.
			sequence: [
				recording(sampleVideoUrl),
				{ kind: "card", card: { durationMs: 1_000, title: "Next" } },
				recording(audioVideoUrl),
			],
		}).export();
		expect(result.success, result.error).toBe(true);

		const ctx = new AudioContext();
		try {
			const audio = await ctx.decodeAudioData(await result.blob!.arrayBuffer());
			expect(peak(audio, 0, 2.8)).toBeLessThan(0.02);
			expect(peak(audio, 3.3, 4.8)).toBeGreaterThan(0.05);
		} finally {
			await ctx.close();
		}
	});
});
