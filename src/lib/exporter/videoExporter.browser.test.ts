import { describe, expect, it } from "vitest";
import sampleVideoUrl from "../../../tests/fixtures/sample.webm?url";
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
