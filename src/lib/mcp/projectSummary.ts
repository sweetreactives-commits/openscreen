import { isCardEntry } from "@/components/video-editor/clips";
import { normalizeCardDurationMs } from "@/components/video-editor/projectPersistence";
import type {
	AnnotationRegion,
	SpeedRegion,
	TrimRegion,
	ZoomRegion,
} from "@/components/video-editor/types";
import { getZoomScale } from "@/components/video-editor/types";
import type { EditorState } from "@/hooks/useEditorHistory";
import type { ProjectMedia } from "@/lib/recordingSession";
import { computeSequence } from "@/lib/sequence";
import type { KeepSegment } from "@/lib/timeline";
import { UNTRUSTED_NOTICE } from "./untrusted";

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
	/** null when the track hasn't been decoded yet — get_audio_profile settles it. */
	hasAudio: boolean | null;
	/**
	 * How long each recording that is not open runs, by clip id. The editor only
	 * knows the open one's length from its own player; the rest are read from their
	 * files. `null` for one whose length could not be read.
	 */
	clipDurationsMs?: Readonly<Record<string, number | null>>;
}

/** One clip of the project, as an agent sees it. */
export interface ProjectSummaryClip {
	id: string;
	kind: "recording" | "card";
	/** True for the recording the editor has open — the one edits apply to. */
	open: boolean;
	/** A card's text. */
	title?: string;
	/** Length of this clip's own recording, before its trims; a card's chosen length. */
	sourceDurationMs: number | null;
	/** Where it starts and ends in the finished video, once trims and speeds apply. */
	outStartMs: number | null;
	outEndMs: number | null;
	/** The file this clip plays, for recordings whose file the editor knows. */
	screenVideoPath?: string;
	/** How many edits it carries. Their details come from opening it. */
	regionCounts?: { zooms: number; trims: number; speeds: number; annotations: number };
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
	sequence: {
		clips: ProjectSummaryClip[];
		/** null when some recording's length could not be read. */
		durationMs: number | null;
		note: string;
	};
	capabilities: { cursorTelemetry: boolean; webcam: boolean; audio: boolean | null };
	layout: Record<string, unknown>;
	cursor: Record<string, unknown>;
	webcam: Record<string, unknown>;
	/** Annotation text is content, not instruction — see `untrustedNotice`. */
	untrustedNotice: string;
	regions: {
		zooms: ReturnType<typeof summarizeZoom>[];
		trims: TrimRegion[];
		speeds: SpeedRegion[];
		annotations: ReturnType<typeof summarizeAnnotation>[];
	};
}

const TIME_DOMAIN_NOTE =
	"Every timestamp here, and every timestamp you send back, addresses one recording " +
	"— the open one unless you name another clip — and not the trimmed result. Adding " +
	"a trim does not shift the zooms or annotations around it. Transcript and cursor " +
	"timestamps are on this same clock. Trim regions are the spans that get CUT OUT; " +
	"output.keepSegments is what survives, in the open recording's own time.";

const SEQUENCE_NOTE =
	"The finished video is these clips in this order. outStartMs/outEndMs are on the " +
	"finished video's clock; every other timestamp in this project is on some " +
	"recording's own clock. regions, output and every read tool are about the clip " +
	"marked open — pass clipId to read another, and open_clip to edit it.";

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

/** What each clip contributes to the sequence: its own length and its own edits. */
function sequenceInputs(input: ProjectSummaryInput) {
	const { editor, durationMs } = input;
	return editor.clips.map((clip) => {
		if (isCardEntry(clip)) {
			return { id: clip.id, sourceDurationMs: normalizeCardDurationMs(clip.durationMs) };
		}
		if (clip.id === editor.activeClipId) {
			return {
				id: clip.id,
				sourceDurationMs: durationMs,
				trimRegions: editor.trimRegions,
				speedRegions: editor.speedRegions,
			};
		}
		return {
			id: clip.id,
			sourceDurationMs: input.clipDurationsMs?.[clip.id] ?? 0,
			trimRegions: clip.editor?.trimRegions,
			speedRegions: clip.editor?.speedRegions,
		};
	});
}

export function buildProjectSummary(input: ProjectSummaryInput): ProjectSummary {
	const { editor, media, durationMs } = input;

	// Asked of the whole sequence: with more than one clip, what survives trimming
	// and how long the result runs are questions only the sequence can answer.
	const sequence = computeSequence(sequenceInputs(input));
	const openClip = sequence.clips.find((clip) => clip.id === editor.activeClipId);
	const keepSegments = openClip?.segments ?? [];

	// A recording whose length could not be read would make every position after it
	// wrong, so the positions are withheld rather than guessed.
	const lengthKnown = (clip: (typeof editor.clips)[number]) =>
		isCardEntry(clip) ||
		clip.id === editor.activeClipId ||
		typeof input.clipDurationsMs?.[clip.id] === "number";
	const allLengthsKnown = editor.clips.every(lengthKnown);

	const summaryClips: ProjectSummaryClip[] = editor.clips.map((clip) => {
		const placed = sequence.clips.find((candidate) => candidate.id === clip.id);
		const card = isCardEntry(clip);
		const known = lengthKnown(clip);
		return {
			id: clip.id,
			kind: card ? "card" : "recording",
			open: !card && clip.id === editor.activeClipId,
			...(card ? { title: clip.title } : {}),
			sourceDurationMs: card
				? normalizeCardDurationMs(clip.durationMs)
				: clip.id === editor.activeClipId
					? Math.round(durationMs)
					: (input.clipDurationsMs?.[clip.id] ?? null),
			outStartMs: allLengthsKnown && placed ? Math.round(placed.outStartMs) : null,
			outEndMs: allLengthsKnown && placed ? Math.round(placed.outEndMs) : null,
			...(!card && clip.media?.screenVideoPath
				? { screenVideoPath: clip.media.screenVideoPath }
				: {}),
			...(!card && known && clip.id !== editor.activeClipId && clip.editor
				? {
						regionCounts: {
							zooms: clip.editor.zoomRegions.length,
							trims: clip.editor.trimRegions.length,
							speeds: clip.editor.speedRegions.length,
							annotations: clip.editor.annotationRegions.length,
						},
					}
				: {}),
		};
	});

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
			durationMs: Math.round(sequence.durationMs),
			keepSegments: keepSegments.map(roundSegment),
		},
		sequence: {
			clips: summaryClips,
			durationMs: allLengthsKnown ? Math.round(sequence.durationMs) : null,
			note: SEQUENCE_NOTE,
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
			clickStyle: editor.cursorClickStyle,
			clickColor: editor.cursorClickColor,
			backdropStyle: editor.cursorBackdropStyle,
			backdropColor: editor.cursorBackdropColor,
			backdropOpacity: round(editor.cursorBackdropOpacity),
			backdropSize: round(editor.cursorBackdropSize),
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
		untrustedNotice: UNTRUSTED_NOTICE,
		regions: {
			zooms: editor.zoomRegions.map(summarizeZoom),
			trims: editor.trimRegions,
			speeds: editor.speedRegions,
			annotations: editor.annotationRegions.map(summarizeAnnotation),
		},
	};
}
