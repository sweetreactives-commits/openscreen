import { describe, expect, it } from "vitest";
import {
	getSourceCopyFastPathBlockers,
	isSourceCopyFastPathEligible,
	resolveExportSequence,
	type VideoExporterConfig,
} from "./videoExporter";

function createConfig(overrides: Partial<VideoExporterConfig> = {}): VideoExporterConfig {
	return {
		videoUrl: "recording.mp4",
		width: 1920,
		height: 1080,
		frameRate: 60,
		bitrate: 30_000_000,
		wallpaper: "#000000",
		zoomRegions: [],
		trimRegions: [],
		speedRegions: [],
		showShadow: false,
		shadowIntensity: 0,
		showBlur: false,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		...overrides,
	};
}

describe("isSourceCopyFastPathEligible", () => {
	it("allows a no-op MP4 export at source dimensions", () => {
		expect(
			isSourceCopyFastPathEligible(createConfig(), {
				width: 1920,
				height: 1080,
			}),
		).toBe(true);
	});

	it("rejects timeline edits and frame-level effects", () => {
		const videoInfo = { width: 1920, height: 1080 };

		expect(
			isSourceCopyFastPathEligible(
				createConfig({ trimRegions: [{ id: "trim", startMs: 100, endMs: 200 }] }),
				videoInfo,
			),
		).toBe(false);
		expect(
			isSourceCopyFastPathEligible(
				createConfig({
					speedRegions: [{ id: "speed", startMs: 100, endMs: 200, speed: 1.5 }],
				}),
				videoInfo,
			),
		).toBe(false);
		expect(
			isSourceCopyFastPathEligible(
				createConfig({
					zoomRegions: [
						{
							id: "zoom",
							startMs: 100,
							endMs: 200,
							depth: 2,
							focus: { cx: 0.5, cy: 0.5 },
						},
					],
				}),
				videoInfo,
			),
		).toBe(false);
		expect(isSourceCopyFastPathEligible(createConfig({ showBlur: true }), videoInfo)).toBe(false);
	});

	it("rejects resizing and overlays", () => {
		const videoInfo = { width: 1920, height: 1080 };

		expect(isSourceCopyFastPathEligible(createConfig({ width: 1280 }), videoInfo)).toBe(false);
		expect(
			isSourceCopyFastPathEligible(
				createConfig({
					cursorScale: 2,
				}),
				videoInfo,
			),
		).toBe(false);
		expect(
			isSourceCopyFastPathEligible(
				createConfig({
					cursorScale: 2,
					cursorRecordingData: {
						version: 2,
						provider: "native",
						assets: [
							{
								id: "cursor",
								platform: "win32",
								imageDataUrl: "data:image/png;base64,AA==",
								width: 32,
								height: 32,
								hotspotX: 0,
								hotspotY: 0,
							},
						],
						samples: [{ timeMs: 0, cx: 0.5, cy: 0.5, visible: true, assetId: "cursor" }],
					},
				}),
				videoInfo,
			),
		).toBe(false);
	});
});

describe("getSourceCopyFastPathBlockers", () => {
	it("reports the source-size mismatch that blocks copy-only export", () => {
		expect(
			getSourceCopyFastPathBlockers(createConfig({ height: 1080 }), {
				width: 1920,
				height: 1032,
			}),
		).toContain("output-size 1920x1080 differs from source 1920x1032");
	});
});

describe("resolveExportSequence", () => {
	it("describes the classic single recording as a sequence of one", () => {
		const sequence = resolveExportSequence(createConfig({ zoomRegions: [] }));
		expect(sequence).toHaveLength(1);
		expect(sequence[0]).toMatchObject({
			kind: "recording",
			recording: { videoUrl: "recording.mp4" },
		});
	});

	it("puts cards around the recording in the order they were given", () => {
		const sequence = resolveExportSequence(
			createConfig({
				cards: {
					before: [{ durationMs: 1_000, title: "Intro" }],
					after: [{ durationMs: 500, title: "Bye" }],
				},
			}),
		);
		expect(sequence.map((clip) => clip.kind)).toEqual(["card", "recording", "card"]);
	});

	it("carries the recording's own edits into it, not just its file", () => {
		const trim = { id: "trim-1", startMs: 0, endMs: 100 };
		const [clip] = resolveExportSequence(createConfig({ trimRegions: [trim] }));
		expect(clip.kind === "recording" && clip.recording.trimRegions).toEqual([trim]);
	});

	it("lets an explicit sequence replace the single-recording fields entirely", () => {
		const sequence = resolveExportSequence(
			createConfig({
				cards: { before: [{ durationMs: 1_000 }], after: [] },
				sequence: [
					{
						kind: "recording",
						recording: {
							videoUrl: "a.webm",
							zoomRegions: [],
							cropRegion: { x: 0, y: 0, width: 1, height: 1 },
						},
					},
				],
			}),
		);
		expect(sequence).toHaveLength(1);
		expect(sequence[0]).toMatchObject({ recording: { videoUrl: "a.webm" } });
	});

	it("never lets a sequence through the source-copy fast path", () => {
		// An explicit sequence leaves the top-level edit fields empty. Judging by them
		// would call a heavily edited sequence untouched and copy the first file.
		const blockers = getSourceCopyFastPathBlockers(
			createConfig({
				sequence: [
					{
						kind: "recording",
						recording: {
							videoUrl: "a.webm",
							zoomRegions: [],
							cropRegion: { x: 0, y: 0, width: 1, height: 1 },
						},
					},
				],
			}),
			{ width: 1920, height: 1080 },
		);
		expect(blockers).toContain("the export is a sequence");
	});
});
