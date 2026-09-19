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
 *
 * `systemCursorInVideo` is the take's own account of what happened, and it
 * overrules the capture mode: asking for the overlay does not mean the pointer
 * was actually left out, because a missing platform helper drops the recording
 * to a pipeline that keeps it. Takes made before that was tracked carry nothing,
 * and fall back to trusting the mode.
 */
export function hasEditableCursorOverlay(
	captureMode: CursorCaptureMode | null | undefined,
	platform: string | null | undefined,
	recordingData: CursorRecordingData | null | undefined,
	systemCursorInVideo?: boolean,
): recordingData is CursorRecordingData {
	return (
		captureMode === "editable-overlay" &&
		systemCursorInVideo !== true &&
		(platform === "win32" || platform === "darwin") &&
		hasNativeCursorRecordingData(recordingData)
	);
}

/**
 * Whether the marks that go around the cursor — the click effect and the
 * highlight — can be drawn for this recording.
 *
 * They are a separate question from the cursor itself. A mark needs a position
 * and nothing else, and a position is exactly what every recording with cursor
 * data has, including the ones whose own pointer is already in the picture. Tying
 * the two together is what made a click effect impossible to show on a take the
 * editor could not draw a cursor for.
 */
export function hasCursorMarks(
	recordingData: CursorRecordingData | null | undefined,
	telemetry: readonly CursorTelemetryPoint[],
): boolean {
	return Boolean(recordingData?.samples.length) || telemetry.length > 0;
}
