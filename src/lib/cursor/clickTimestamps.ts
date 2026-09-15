import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { hasNativeCursorRecordingData } from "@/lib/cursor/nativeCursor";
import type { CursorCaptureMode } from "@/lib/recordingSession";
import type { CursorRecordingData } from "@/native/contracts";

/**
 * Cursor facts a recording needs at render time, worked out the same way for the
 * recording open in the editor and for every other recording in a sequence.
 * They used to be derived inline in the editor, which only ever knew about one.
 */

export function isClickInteractionType(interactionType: string | null | undefined): boolean {
	return (
		interactionType === "click" ||
		interactionType === "double-click" ||
		interactionType === "right-click" ||
		interactionType === "middle-click"
	);
}

/**
 * When the clicks happened, for the ripple and the bounce.
 *
 * The native cursor recording is the better source when it has any clicks; the
 * sampled telemetry is the fallback.
 */
export function clickTimestampsFrom(
	recordingData: CursorRecordingData | null | undefined,
	telemetry: readonly CursorTelemetryPoint[],
): number[] {
	const recordingClicks =
		recordingData?.samples
			.filter((sample) => isClickInteractionType(sample.interactionType))
			.map((sample) => sample.timeMs) ?? [];
	if (recordingClicks.length > 0) {
		return recordingClicks;
	}

	return telemetry
		.filter((sample) => isClickInteractionType(sample.interactionType))
		.map((sample) => sample.timeMs);
}

/**
 * Whether this recording's cursor is drawn by OpenScreen rather than baked into
 * the picture.
 *
 * Only an "editable-overlay" capture on Windows or macOS with native cursor data
 * qualifies. Anything else already shows the system cursor, and drawing ours on
 * top would put two cursors on screen.
 */
export function hasEditableCursorOverlay(
	captureMode: CursorCaptureMode | null | undefined,
	platform: string | null | undefined,
	recordingData: CursorRecordingData | null | undefined,
): recordingData is CursorRecordingData {
	return (
		captureMode === "editable-overlay" &&
		(platform === "win32" || platform === "darwin") &&
		hasNativeCursorRecordingData(recordingData)
	);
}
