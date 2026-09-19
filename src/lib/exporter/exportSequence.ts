import type {
	AnnotationRegion,
	CropRegion,
	SpeedRegion,
	TrimRegion,
	ZoomRegion,
} from "@/components/video-editor/types";
import type { CursorRecordingData } from "@/native/contracts";

/**
 * What an export renders, in order — shared by the MP4 and GIF exporters so
 * neither has to import the other to agree on it.
 */

/** A card clip as the exporter needs it: how long, and what it says. */
export interface ExportCard {
	durationMs: number;
	title?: string;
}

/** One recording as the exporter needs it: its media and the edits that address it. */
export interface ExportRecording {
	videoUrl: string;
	webcamVideoUrl?: string;
	trimRegions?: TrimRegion[];
	speedRegions?: SpeedRegion[];
	zoomRegions: ZoomRegion[];
	annotationRegions?: AnnotationRegion[];
	cropRegion: CropRegion;
	cursorRecordingData?: CursorRecordingData | null;
	/**
	 * Whether this take's cursor is OpenScreen's to draw. False when its own
	 * pointer is already in the picture — the marks around it still are.
	 */
	drawCursor?: boolean;
	cursorTelemetry?: import("@/components/video-editor/types").CursorTelemetryPoint[];
	cursorClickTimestamps?: number[];
}

/** One entry of what gets rendered, in order. */
export type ExportSequenceClip =
	| { kind: "card"; card: ExportCard }
	| { kind: "recording"; recording: ExportRecording };

/**
 * What to render, in order.
 *
 * A caller can hand over a full `sequence`. Without one, the classic single
 * recording is described by the top-level fields, with `cards` around it — which
 * is exactly a sequence of cards, one recording, and more cards, so both shapes
 * go down the same path.
 */
/** The fields either exporter's configuration uses to describe what to render. */
export interface ExportSequenceSource extends ExportRecording {
	sequence?: ExportSequenceClip[];
	cards?: { before: ExportCard[]; after: ExportCard[] };
}

export function resolveExportSequence(config: ExportSequenceSource): ExportSequenceClip[] {
	if (config.sequence && config.sequence.length > 0) return config.sequence;

	const single: ExportSequenceClip = {
		kind: "recording",
		recording: {
			videoUrl: config.videoUrl,
			webcamVideoUrl: config.webcamVideoUrl,
			trimRegions: config.trimRegions,
			speedRegions: config.speedRegions,
			zoomRegions: config.zoomRegions,
			annotationRegions: config.annotationRegions,
			cropRegion: config.cropRegion,
			cursorRecordingData: config.cursorRecordingData,
			drawCursor: config.drawCursor,
			cursorTelemetry: config.cursorTelemetry,
			cursorClickTimestamps: config.cursorClickTimestamps,
		},
	};
	const asClips = (cards: ExportCard[] = []): ExportSequenceClip[] =>
		cards.map((card) => ({ kind: "card", card }));

	return [...asClips(config.cards?.before), single, ...asClips(config.cards?.after)];
}
