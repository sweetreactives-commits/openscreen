import type {
	AnnotationRegion,
	SpeedRegion,
	TrimRegion,
	ZoomRegion,
} from "@/components/video-editor/types";
import { getZoomScale } from "@/components/video-editor/types";
import type { EditorState } from "@/hooks/useEditorHistory";
import type { ProjectMedia } from "@/lib/recordingSession";
import { computeOutputDurationMs, computeTimeline, type KeepSegment } from "./timeline";

/**
 * The project as an agent sees it.
 *
 * Two rules shape everything here. Compact: a ten-minute recording must not cost
 * an agent its context window, so nothing raw goes in — no telemetry samples, no
 * image payloads. And explicit: anything an agent could plausibly get backwards
 * (what a trim means, which clock a timestamp is on) is stated rather than left
 * to be inferred.
 */

/** What the editor knows that isn't part of `EditorState`. */
export interface ProjectSummaryInput {
	editor: EditorState;
	media: ProjectMedia | null;
	projectPath: string | null;
	durationMs: number;
	sourceWidth: number;
	sourceHeight: number;
	hasCursorTelemetry: boolean;
	hasAudio: boolean;
}

export interface ProjectSummary {
	open: boolean;
	projectPath: string | null;
	media: ProjectMedia | null;
	source: { width: number; height: number; durationMs: number };
	timeDomain: {
		unit: "milliseconds";
		origin: "source-recording";
		note: string;
	};
	output: { durationMs: number; keepSegments: KeepSegment[] };
	capabilities: { cursorTelemetry: boolean; webcam: boolean; audio: boolean };
	layout: Record<string, unknown>;
	cursor: Record<string, unknown>;
	webcam: Record<string, unknown>;
	regions: {
		zooms: ReturnType<typeof summarizeZoom>[];
		trims: TrimRegion[];
		speeds: SpeedRegion[];
		annotations: ReturnType<typeof summarizeAnnotation>[];
	};
}

const TIME_DOMAIN_NOTE =
	"Every timestamp here, and every timestamp you send back, addresses the original " +
	"recording — not the trimmed result. Adding a trim does not shift the zooms or " +
	"annotations around it. Transcript and cursor timestamps are on this same clock. " +
	"Trim regions are the spans that get CUT OUT; output.keepSegments is what survives.";

/** Two decimals is past the precision of anything on screen; more is float noise. */
function round(value: number, decimals = 2): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

function roundSegment(segment: KeepSegment): KeepSegment {
	return {
		startMs: Math.round(segment.startMs),
		endMs: Math.round(segment.endMs),
		speed: round(segment.speed),
	};
}

function summarizeZoom(region: ZoomRegion) {
	return {
		id: region.id,
		startMs: region.startMs,
		endMs: region.endMs,
		scale: round(getZoomScale(region)),
		focus: { cx: round(region.focus.cx, 4), cy: round(region.focus.cy, 4) },
		focusMode: region.focusMode ?? "manual",
		rotationPreset: region.rotationPreset ?? null,
		// "auto" is the magic wand's, "agent" is yours, "manual" means a human touched it.
		source: region.source ?? "manual",
	};
}

/**
 * Annotations minus their payload. `imageContent` is a data URL living inside the
 * project, routinely hundreds of kilobytes — enough to swamp a response on its own.
 */
function summarizeAnnotation(region: AnnotationRegion) {
	const image = region.imageContent;
	return {
		id: region.id,
		startMs: region.startMs,
		endMs: region.endMs,
		type: region.type,
		text: region.textContent ?? (region.type === "text" ? region.content : undefined),
		image: image ? { present: true, bytes: image.length } : undefined,
		position: region.position,
		size: region.size,
		zIndex: region.zIndex,
		style:
			region.type === "text"
				? {
						color: region.style.color,
						backgroundColor: region.style.backgroundColor,
						fontSize: region.style.fontSize,
						fontFamily: region.style.fontFamily,
						fontWeight: region.style.fontWeight,
						textAlign: region.style.textAlign,
						textAnimation: region.style.textAnimation ?? "none",
					}
				: undefined,
		figure: region.figureData,
		blur: region.blurData
			? {
					type: region.blurData.type,
					shape: region.blurData.shape,
					intensity: region.blurData.intensity,
				}
			: undefined,
		fromAutoCaption: region.annotationSource === "auto-caption" ? true : undefined,
	};
}

export function buildProjectSummary(input: ProjectSummaryInput): ProjectSummary {
	const { editor, media, durationMs } = input;
	const keepSegments = computeTimeline(durationMs, editor.trimRegions, editor.speedRegions);

	return {
		open: media !== null && durationMs > 0,
		projectPath: input.projectPath,
		media,
		source: {
			width: input.sourceWidth,
			height: input.sourceHeight,
			durationMs: Math.round(durationMs),
		},
		timeDomain: {
			unit: "milliseconds",
			origin: "source-recording",
			note: TIME_DOMAIN_NOTE,
		},
		output: {
			durationMs: Math.round(
				computeOutputDurationMs(durationMs, editor.trimRegions, editor.speedRegions),
			),
			keepSegments: keepSegments.map(roundSegment),
		},
		capabilities: {
			cursorTelemetry: input.hasCursorTelemetry,
			webcam: Boolean(media?.webcamVideoPath),
			audio: input.hasAudio,
		},
		layout: {
			aspectRatio: editor.aspectRatio,
			padding: editor.padding,
			borderRadius: editor.borderRadius,
			wallpaper: editor.wallpaper,
			shadowIntensity: editor.shadowIntensity,
			motionBlurAmount: editor.motionBlurAmount,
			cropRegion: editor.cropRegion,
		},
		cursor: {
			visible: editor.showCursor,
			size: round(editor.cursorSize),
			smoothing: round(editor.cursorSmoothing),
			motionBlur: round(editor.cursorMotionBlur),
			clickBounce: round(editor.cursorClickBounce),
			clickRipple: round(editor.cursorClickRipple),
			clipToBounds: editor.cursorClipToBounds,
			theme: editor.cursorTheme,
		},
		webcam: {
			layoutPreset: editor.webcamLayoutPreset,
			maskShape: editor.webcamMaskShape,
			sizePreset: editor.webcamSizePreset,
			position: editor.webcamPosition,
			mirrored: editor.webcamMirrored,
			reactiveZoom: editor.webcamReactiveZoom,
		},
		regions: {
			zooms: editor.zoomRegions.map(summarizeZoom),
			trims: editor.trimRegions,
			speeds: editor.speedRegions,
			annotations: editor.annotationRegions.map(summarizeAnnotation),
		},
	};
}
