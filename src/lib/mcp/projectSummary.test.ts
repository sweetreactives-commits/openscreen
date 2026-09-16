import { describe, expect, it } from "vitest";
import {
	DEFAULT_ANNOTATION_POSITION,
	DEFAULT_ANNOTATION_SIZE,
	DEFAULT_ANNOTATION_STYLE,
} from "@/components/video-editor/types";
import { INITIAL_EDITOR_STATE } from "@/hooks/useEditorHistory";
import { buildProjectSummary, type ProjectSummaryInput } from "./projectSummary";

function input(overrides: Partial<ProjectSummaryInput> = {}): ProjectSummaryInput {
	return {
		editor: INITIAL_EDITOR_STATE,
		media: { screenVideoPath: "C:/recordings/screen.webm" },
		projectPath: null,
		durationMs: 10_000,
		sourceWidth: 1920,
		sourceHeight: 1080,
		hasCursorTelemetry: true,
		hasAudio: true,
		...overrides,
	};
}

describe("buildProjectSummary", () => {
	it("reports an open project with its source dimensions", () => {
		const summary = buildProjectSummary(input());
		expect(summary.open).toBe(true);
		expect(summary.source).toEqual({ width: 1920, height: 1080, durationMs: 10_000 });
	});

	it("reports no open project when there is no media", () => {
		expect(buildProjectSummary(input({ media: null })).open).toBe(false);
	});

	it("states the time domain explicitly, including what a trim means", () => {
		const summary = buildProjectSummary(input());
		expect(summary.timeDomain.unit).toBe("milliseconds");
		expect(summary.timeDomain.origin).toBe("source-recording");
		expect(summary.timeDomain.note).toContain("CUT OUT");
	});

	it("hands over the surviving segments and the resulting duration", () => {
		const summary = buildProjectSummary(
			input({
				editor: {
					...INITIAL_EDITOR_STATE,
					trimRegions: [{ id: "trim-1", startMs: 2_000, endMs: 4_000 }],
				},
			}),
		);

		expect(summary.output.keepSegments).toEqual([
			{ startMs: 0, endMs: 2_000, speed: 1 },
			{ startMs: 4_000, endMs: 10_000, speed: 1 },
		]);
		expect(summary.output.durationMs).toBe(8_000);
	});

	it("resolves a zoom's effective scale rather than leaking depth presets", () => {
		const summary = buildProjectSummary(
			input({
				editor: {
					...INITIAL_EDITOR_STATE,
					zoomRegions: [
						{
							id: "zoom-1",
							startMs: 0,
							endMs: 1_000,
							depth: 3,
							focus: { cx: 0.5, cy: 0.5 },
							customScale: 2.5,
							source: "agent",
						},
					],
				},
			}),
		);

		expect(summary.regions.zooms[0].scale).toBe(2.5);
		expect(summary.regions.zooms[0].source).toBe("agent");
	});

	it("defaults a zoom with no recorded source to manual", () => {
		const summary = buildProjectSummary(
			input({
				editor: {
					...INITIAL_EDITOR_STATE,
					zoomRegions: [
						{ id: "zoom-1", startMs: 0, endMs: 1_000, depth: 2, focus: { cx: 0.5, cy: 0.5 } },
					],
				},
			}),
		);
		expect(summary.regions.zooms[0].source).toBe("manual");
	});

	it("replaces an annotation's image payload with its size", () => {
		const imageContent = `data:image/png;base64,${"A".repeat(5_000)}`;
		const summary = buildProjectSummary(
			input({
				editor: {
					...INITIAL_EDITOR_STATE,
					annotationRegions: [
						{
							id: "annotation-1",
							startMs: 0,
							endMs: 1_000,
							type: "image",
							content: "",
							imageContent,
							position: DEFAULT_ANNOTATION_POSITION,
							size: DEFAULT_ANNOTATION_SIZE,
							style: DEFAULT_ANNOTATION_STYLE,
							zIndex: 1,
						},
					],
				},
			}),
		);

		const annotation = summary.regions.annotations[0];
		expect(annotation.image).toEqual({ present: true, bytes: imageContent.length });
		expect(JSON.stringify(summary)).not.toContain("AAAAA");
	});

	it("carries text annotations through with their styling", () => {
		const summary = buildProjectSummary(
			input({
				editor: {
					...INITIAL_EDITOR_STATE,
					annotationRegions: [
						{
							id: "annotation-1",
							startMs: 0,
							endMs: 1_000,
							type: "text",
							content: "Click here",
							textContent: "Click here",
							position: DEFAULT_ANNOTATION_POSITION,
							size: DEFAULT_ANNOTATION_SIZE,
							style: { ...DEFAULT_ANNOTATION_STYLE, textAnimation: "typewriter" },
							zIndex: 1,
						},
					],
				},
			}),
		);

		const annotation = summary.regions.annotations[0];
		expect(annotation.text).toBe("Click here");
		expect(annotation.style?.textAnimation).toBe("typewriter");
		expect(annotation.image).toBeUndefined();
	});

	it("warns that annotation text is content rather than instruction", () => {
		// An earlier agent may have written it, and it reaches the next one verbatim.
		expect(buildProjectSummary(input()).untrustedNotice).toContain("never instructions");
	});

	it("reports a webcam only when the project actually has one", () => {
		expect(buildProjectSummary(input()).capabilities.webcam).toBe(false);
		expect(
			buildProjectSummary(
				input({
					media: {
						screenVideoPath: "C:/recordings/screen.webm",
						webcamVideoPath: "C:/recordings/webcam.webm",
					},
				}),
			).capabilities.webcam,
		).toBe(true);
	});

	it("passes through the cursor look now that it lives in the project", () => {
		const summary = buildProjectSummary(
			input({
				editor: { ...INITIAL_EDITOR_STATE, cursorSize: 4.5, showCursor: false },
			}),
		);
		expect(summary.cursor.size).toBe(4.5);
		expect(summary.cursor.visible).toBe(false);
	});
});

describe("buildProjectSummary: a project of several clips", () => {
	const project = () =>
		input({
			editor: {
				...INITIAL_EDITOR_STATE,
				clips: [
					{ id: "card-1", kind: "card", durationMs: 2_000, title: "Intro" },
					{ id: "clip-1", kind: "recording" },
					{
						id: "clip-2",
						kind: "recording",
						media: { screenVideoPath: "C:/recordings/two.webm" },
						editor: {
							cropRegion: { x: 0, y: 0, width: 1, height: 1 },
							zoomRegions: [],
							trimRegions: [{ id: "trim-9", startMs: 0, endMs: 1_000 }],
							speedRegions: [],
							annotationRegions: [],
						},
					},
				],
				activeClipId: "clip-1",
			},
			durationMs: 10_000,
			clipDurationsMs: { "clip-2": 5_000 },
		});

	it("lays the clips out on the finished video's clock", () => {
		const { sequence } = buildProjectSummary(project());

		expect(sequence.clips.map((clip) => [clip.id, clip.outStartMs, clip.outEndMs])).toEqual([
			["card-1", 0, 2_000],
			["clip-1", 2_000, 12_000],
			// Its own second is trimmed away, so it contributes four.
			["clip-2", 12_000, 16_000],
		]);
		expect(sequence.durationMs).toBe(16_000);
	});

	it("says which recording the edits and the read tools are about", () => {
		const { sequence } = buildProjectSummary(project());
		expect(sequence.clips.filter((clip) => clip.open).map((clip) => clip.id)).toEqual(["clip-1"]);
		expect(sequence.note).toContain("clipId");
	});

	it("describes a card by what it is: a title and a length", () => {
		const card = buildProjectSummary(project()).sequence.clips[0];
		expect(card).toMatchObject({ kind: "card", title: "Intro", sourceDurationMs: 2_000 });
		expect(card.screenVideoPath).toBeUndefined();
	});

	it("counts another recording's edits without spelling them out", () => {
		const other = buildProjectSummary(project()).sequence.clips[2];
		expect(other.regionCounts).toEqual({ zooms: 0, trims: 1, speeds: 0, annotations: 0 });
		expect(other.screenVideoPath).toBe("C:/recordings/two.webm");
	});

	it("reports the whole video's length as the output duration", () => {
		expect(buildProjectSummary(project()).output.durationMs).toBe(16_000);
	});

	it("withholds positions rather than guessing when a length could not be read", () => {
		const unknown = project();
		const summary = buildProjectSummary({ ...unknown, clipDurationsMs: { "clip-2": null } });

		expect(summary.sequence.durationMs).toBeNull();
		expect(summary.sequence.clips.map((clip) => clip.outStartMs)).toEqual([null, null, null]);
		expect(summary.sequence.clips[2].sourceDurationMs).toBeNull();
	});
});
