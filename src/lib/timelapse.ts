import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import { type SilenceCut, silentStretches } from "@/lib/silenceTrim";

/**
 * Speeding up the stretches where nothing is happening.
 *
 * The other half of making a screencast watchable. Dead air gets cut
 * (silenceTrim.ts); waiting does not — an install, a page load, a long scroll
 * has to stay, or the viewer loses the thread. It just has no business running
 * at normal speed.
 *
 * Both signals are already computed for the agent: quiet from the audio profile
 * and clicks from the cursor summary. What is decided here is which quiet
 * stretches are boring rather than merely quiet. See
 * docs/architecture/timelapse.md.
 */

export interface TimelapseSettings {
	/** Shared with the silence cuts: the same judgement about what counts as quiet. */
	sensitivity: number;
	/** How much faster a boring stretch plays. */
	speed: number;
	/** Nothing shorter than this is worth speeding up. */
	minBoringMs: number;
}

export const DEFAULT_TIMELAPSE_SPEED = 4;
export const DEFAULT_TIMELAPSE_MIN_MS = 5_000;
export const TIMELAPSE_MIN_RANGE_MS = [2_000, 30_000] as const;

/**
 * Speech is left at its own speed on both sides.
 *
 * The boundary of a speed region is a hard change of pace, and one landing on
 * the tail of a word plays that word at four times the rate.
 */
const MARGIN_MS = 250;
/** Below this there is nothing to gain: the region is shorter than its own margins. */
const MIN_REGION_MS = 1_000;

export interface BoringStretch {
	startMs: number;
	endMs: number;
}

export type TimelapseScan =
	| { ok: true; stretches: BoringStretch[] }
	/** `no-audio`: nothing to measure. `nothing-found`: measured, nothing dull enough. */
	| { ok: false; reason: "no-audio" | "nothing-found" };

function overlaps(span: BoringStretch, region: { startMs: number; endMs: number }): boolean {
	return span.startMs < region.endMs && region.startMs < span.endMs;
}

/**
 * Cuts a quiet stretch at every click inside it.
 *
 * A click in the middle of twenty silent seconds means something happened there.
 * Dropping the whole stretch for it would throw away the nineteen seconds where
 * nothing did, so it is split around the click instead.
 */
function splitAtClicks(span: BoringStretch, clickTimesMs: readonly number[]): BoringStretch[] {
	const inside = clickTimesMs
		.filter((time) => time > span.startMs && time < span.endMs)
		.sort((a, b) => a - b);
	if (inside.length === 0) return [span];

	const pieces: BoringStretch[] = [];
	let from = span.startMs;
	for (const click of inside) {
		if (click > from) pieces.push({ startMs: from, endMs: click });
		from = click;
	}
	if (span.endMs > from) pieces.push({ startMs: from, endMs: span.endMs });
	return pieces;
}

/**
 * Every stretch of the recording worth playing faster.
 *
 * Quiet and unclicked for long enough, and clear of anything the user has
 * already decided about — a cut or a speed of their own is an answer about that
 * stretch, and this does not argue with it.
 */
export function findBoringStretches(
	peaks: Float32Array | null,
	durationMs: number,
	clickTimesMs: readonly number[],
	settings: TimelapseSettings,
	existingTrims: readonly TrimRegion[] = [],
	existingSpeeds: readonly SpeedRegion[] = [],
): TimelapseScan {
	if (!peaks || peaks.length < 2 || !(durationMs > 0)) return { ok: false, reason: "no-audio" };

	const minBoringMs = Math.min(
		Math.max(settings.minBoringMs, TIMELAPSE_MIN_RANGE_MS[0]),
		TIMELAPSE_MIN_RANGE_MS[1],
	);

	const quiet: SilenceCut[] = silentStretches(peaks, durationMs, settings.sensitivity);
	const stretches = quiet
		.flatMap((span) => splitAtClicks(span, clickTimesMs))
		.filter((span) => span.endMs - span.startMs >= minBoringMs)
		.map((span) => ({
			startMs: Math.round(span.startMs + MARGIN_MS),
			endMs: Math.round(span.endMs - MARGIN_MS),
		}))
		.filter((span) => span.endMs - span.startMs >= MIN_REGION_MS)
		.filter(
			(span) =>
				!existingTrims.some((region) => overlaps(span, region)) &&
				!existingSpeeds.some((region) => overlaps(span, region)),
		);

	if (stretches.length === 0) return { ok: false, reason: "nothing-found" };
	return { ok: true, stretches };
}
