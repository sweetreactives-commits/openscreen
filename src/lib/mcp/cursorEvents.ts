import type { CursorTelemetryPoint } from "@/components/video-editor/types";

/**
 * Cursor telemetry, compressed to what an agent can act on.
 *
 * Raw telemetry is sampled around 30 Hz — eighteen thousand points for a
 * ten-minute recording, which is both useless and ruinously expensive to hand to
 * a model. What carries meaning is where the user clicked, and where nothing
 * happened at all. Those are the anchors for "zoom on this" and "cut that".
 */

export type CursorInteraction = NonNullable<CursorTelemetryPoint["interactionType"]>;

export interface CursorClick {
	timeMs: number;
	cx: number;
	cy: number;
	type: CursorInteraction;
}

/** A stretch where the cursor sat still. */
export interface IdleSpan {
	startMs: number;
	endMs: number;
	durationMs: number;
}

export interface CursorEventSummary {
	sampleCount: number;
	clicks: CursorClick[];
	/** True when `clicks` was truncated; the recording had more than the cap. */
	clicksTruncated: boolean;
	idleSpans: IdleSpan[];
	totalIdleMs: number;
}

export interface CursorEventOptions {
	/** Movement below this share of the frame diagonal counts as standing still. */
	movementThreshold?: number;
	/** Stillness shorter than this isn't worth reporting as a gap. */
	minIdleMs?: number;
	/** Ceiling on returned clicks, so a click-happy recording can't flood the response. */
	maxClicks?: number;
}

const DEFAULT_MOVEMENT_THRESHOLD = 0.01;
const DEFAULT_MIN_IDLE_MS = 1_500;
const DEFAULT_MAX_CLICKS = 500;

const CLICK_TYPES = new Set<CursorInteraction>([
	"click",
	"double-click",
	"right-click",
	"middle-click",
]);

function round(value: number, decimals = 4): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

/**
 * Reduces telemetry to clicks and idle stretches.
 *
 * Samples are assumed to be in time order, which is how the recorder writes them;
 * out-of-order points would only mis-split an idle span, never lose a click.
 */
export function summarizeCursorEvents(
	telemetry: readonly CursorTelemetryPoint[],
	options: CursorEventOptions = {},
): CursorEventSummary {
	const movementThreshold = options.movementThreshold ?? DEFAULT_MOVEMENT_THRESHOLD;
	const minIdleMs = options.minIdleMs ?? DEFAULT_MIN_IDLE_MS;
	const maxClicks = options.maxClicks ?? DEFAULT_MAX_CLICKS;

	const clicks: CursorClick[] = [];
	const idleSpans: IdleSpan[] = [];

	let stillSince: number | null = null;
	let previous: CursorTelemetryPoint | null = null;

	for (const point of telemetry) {
		if (point.interactionType && CLICK_TYPES.has(point.interactionType)) {
			if (clicks.length < maxClicks) {
				clicks.push({
					timeMs: Math.round(point.timeMs),
					cx: round(point.cx),
					cy: round(point.cy),
					type: point.interactionType,
				});
			}
		}

		if (previous) {
			const moved = Math.hypot(point.cx - previous.cx, point.cy - previous.cy);
			if (moved > movementThreshold) {
				// Movement ends the current stillness; the gap runs up to the previous sample.
				if (stillSince !== null && previous.timeMs - stillSince >= minIdleMs) {
					idleSpans.push({
						startMs: Math.round(stillSince),
						endMs: Math.round(previous.timeMs),
						durationMs: Math.round(previous.timeMs - stillSince),
					});
				}
				stillSince = null;
			} else if (stillSince === null) {
				stillSince = previous.timeMs;
			}
		}

		previous = point;
	}

	// A recording that ends while the cursor is parked still has a trailing gap.
	if (stillSince !== null && previous && previous.timeMs - stillSince >= minIdleMs) {
		idleSpans.push({
			startMs: Math.round(stillSince),
			endMs: Math.round(previous.timeMs),
			durationMs: Math.round(previous.timeMs - stillSince),
		});
	}

	return {
		sampleCount: telemetry.length,
		clicks,
		clicksTruncated: clicks.length >= maxClicks,
		idleSpans,
		totalIdleMs: idleSpans.reduce((sum, span) => sum + span.durationMs, 0),
	};
}
