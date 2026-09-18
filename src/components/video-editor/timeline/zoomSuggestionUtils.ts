import type { CursorTelemetryPoint, ZoomFocus } from "../types";
import { interpolateCursorAt } from "../videoPlayback/cursorFollowUtils";

/**
 * Working out where a zoom is worth suggesting.
 *
 * The question is where the viewer should be looking, and the recording answers
 * it in two voices. A click is the loud one: something was acted on, and
 * whatever it was deserves to be seen. A resting cursor is the quiet one — it
 * usually sits where the person is reading or about to act, so it is worth
 * something, but never as much as a click.
 *
 * Both signals are already in the recording. Clicks come from the cursor data
 * that draws the ripple and splits timelapse stretches; positions come from the
 * same telemetry that makes a zoom follow the cursor. What is decided here is
 * only which moments are worth proposing, and in what order.
 */

/** Below this the cursor merely passed through on its way somewhere. */
export const MIN_DWELL_DURATION_MS = 450;
/**
 * A rest counts for no more than this.
 *
 * Suggestions are ranked by strength, so an unbounded score would let one long
 * pause outrank every other moment in the recording. Past a few seconds the
 * extra stillness says nothing new.
 */
export const DWELL_SATURATION_MS = 3_000;
/**
 * Past this the cursor was parked, not resting.
 *
 * Someone typing, reading or away from the desk leaves the pointer wherever it
 * happened to be, which is precisely where the attention is not.
 */
export const ABANDONED_DWELL_MS = 20_000;
/** How far the cursor may drift and still count as resting. */
export const DWELL_MOVE_THRESHOLD = 0.02;
/**
 * Quiet required on either side of a suggested zoom.
 *
 * Spacing used to be measured between centres, which only kept two zooms from
 * overlapping — so they came out back to back, and a recording full of small
 * pauses got a carpet of them. What a viewer needs is the picture holding still
 * between moves.
 */
export const SUGGESTION_GAP_MS = 3_000;
/**
 * One suggestion per this much recording, at most.
 *
 * The gap alone still fills a long take end to end. Suggestions are proposals
 * for the user to thin out, and a list that has to be thinned out wholesale is
 * worse than a short one: the strongest moments are claimed first, so a budget
 * spends itself on clicks before it spends itself on rests.
 */
export const SUGGESTION_BUDGET_MS = 10_000;

export type ZoomCandidateKind = "click" | "dwell";

export interface ZoomCandidate {
	centerTimeMs: number;
	focus: ZoomFocus;
	/** Compared only against candidates of the same kind. */
	strength: number;
	kind: ZoomCandidateKind;
}

function normalizeTelemetrySample(
	sample: CursorTelemetryPoint,
	totalMs: number,
): CursorTelemetryPoint {
	return {
		timeMs: Math.max(0, Math.min(sample.timeMs, totalMs)),
		cx: Math.max(0, Math.min(sample.cx, 1)),
		cy: Math.max(0, Math.min(sample.cy, 1)),
	};
}

export function normalizeCursorTelemetry(
	telemetry: readonly CursorTelemetryPoint[],
	totalMs: number,
): CursorTelemetryPoint[] {
	return [...telemetry]
		.filter(
			(sample) =>
				Number.isFinite(sample.timeMs) && Number.isFinite(sample.cx) && Number.isFinite(sample.cy),
		)
		.sort((a, b) => a.timeMs - b.timeMs)
		.map((sample) => normalizeTelemetrySample(sample, totalMs));
}

/**
 * Stretches where the cursor came to rest.
 *
 * A run is a span of consecutive samples none of which moves further than
 * DWELL_MOVE_THRESHOLD from the one before. Runs shorter than MIN_DWELL are
 * passing through; runs longer than ABANDONED_DWELL are a forgotten pointer.
 */
export function detectZoomDwellCandidates(samples: CursorTelemetryPoint[]): ZoomCandidate[] {
	if (samples.length < 2) {
		return [];
	}

	const dwellCandidates: ZoomCandidate[] = [];
	let runStart = 0;

	const pushRunIfDwell = (startIndex: number, endIndexExclusive: number) => {
		if (endIndexExclusive - startIndex < 2) {
			return;
		}

		const start = samples[startIndex];
		const end = samples[endIndexExclusive - 1];
		const runDuration = end.timeMs - start.timeMs;
		if (runDuration < MIN_DWELL_DURATION_MS || runDuration > ABANDONED_DWELL_MS) {
			return;
		}

		const runSamples = samples.slice(startIndex, endIndexExclusive);
		const avgCx = runSamples.reduce((sum, sample) => sum + sample.cx, 0) / runSamples.length;
		const avgCy = runSamples.reduce((sum, sample) => sum + sample.cy, 0) / runSamples.length;

		dwellCandidates.push({
			centerTimeMs: Math.round((start.timeMs + end.timeMs) / 2),
			focus: { cx: avgCx, cy: avgCy },
			strength: Math.min(runDuration, DWELL_SATURATION_MS),
			kind: "dwell",
		});
	};

	for (let index = 1; index < samples.length; index += 1) {
		const prev = samples[index - 1];
		const curr = samples[index];
		const distance = Math.hypot(curr.cx - prev.cx, curr.cy - prev.cy);

		if (distance > DWELL_MOVE_THRESHOLD) {
			pushRunIfDwell(runStart, index);
			runStart = index;
		}
	}
	pushRunIfDwell(runStart, samples.length);

	return dwellCandidates;
}

/**
 * The moments something was clicked.
 *
 * The click carries its own time but not its own position, so the focus is read
 * off the telemetry at that instant — the same interpolation the cursor-follow
 * zoom uses, so a suggested zoom lands where the pointer actually was.
 */
export function detectZoomClickCandidates(
	samples: CursorTelemetryPoint[],
	clickTimesMs: readonly number[],
	totalMs: number,
): ZoomCandidate[] {
	if (samples.length === 0) {
		return [];
	}

	const candidates: ZoomCandidate[] = [];
	for (const rawTimeMs of clickTimesMs) {
		if (!Number.isFinite(rawTimeMs)) {
			continue;
		}
		const timeMs = Math.max(0, Math.min(rawTimeMs, totalMs));
		const focus = interpolateCursorAt(samples, timeMs);
		if (!focus) {
			continue;
		}
		candidates.push({
			centerTimeMs: Math.round(timeMs),
			focus,
			// Every click is worth the same; what separates them is only whether
			// another accepted suggestion already covers the moment.
			strength: 1,
			kind: "click",
		});
	}

	return candidates;
}

export interface AutoZoomSuggestion {
	span: { start: number; end: number };
	focus: ZoomFocus;
	kind: ZoomCandidateKind;
}

export type ZoomSuggestionScan =
	| { ok: true; suggestions: AutoZoomSuggestion[] }
	/**
	 * `no-cursor-data`: the recording carries none. `unusable-cursor-data`: it
	 * carries some, too little to read. `nothing-found`: read it, no moment stood
	 * out. `no-room`: moments stood out, existing zooms cover them all.
	 */
	| {
			ok: false;
			reason: "no-cursor-data" | "unusable-cursor-data" | "nothing-found" | "no-room";
	  };

/** Clicks first, then the longest rests; the order suggestions are claimed in. */
function byPriority(a: ZoomCandidate, b: ZoomCandidate): number {
	if (a.kind !== b.kind) {
		return a.kind === "click" ? -1 : 1;
	}
	return b.strength - a.strength;
}

/**
 * Build non-overlapping zoom suggestions from what the cursor did: take the
 * clicks and the rests, claim them strongest first, space them by
 * SUGGESTION_SPACING_MS and drop any that would land on an existing region.
 * Pure, shared by the magic-wand toggle and the on-load auto-suggest pass.
 */
export function findZoomSuggestions(options: {
	cursorTelemetry: readonly CursorTelemetryPoint[];
	clickTimesMs?: readonly number[];
	totalMs: number;
	existingRegions: { startMs: number; endMs: number }[];
	defaultDurationMs: number;
}): ZoomSuggestionScan {
	const {
		cursorTelemetry,
		clickTimesMs = [],
		totalMs,
		existingRegions,
		defaultDurationMs,
	} = options;
	if (cursorTelemetry.length === 0) {
		return { ok: false, reason: "no-cursor-data" };
	}
	if (totalMs <= 0 || cursorTelemetry.length < 2) {
		return { ok: false, reason: "unusable-cursor-data" };
	}

	const defaultDuration = Math.min(defaultDurationMs, totalMs);
	if (defaultDuration <= 0) {
		return { ok: false, reason: "unusable-cursor-data" };
	}

	const normalizedSamples = normalizeCursorTelemetry(cursorTelemetry, totalMs);
	if (normalizedSamples.length < 2) {
		return { ok: false, reason: "unusable-cursor-data" };
	}

	const candidates = [
		...detectZoomClickCandidates(normalizedSamples, clickTimesMs, totalMs),
		...detectZoomDwellCandidates(normalizedSamples),
	];
	if (candidates.length === 0) {
		return { ok: false, reason: "nothing-found" };
	}

	const reservedSpans = existingRegions
		.map((region) => ({ start: region.startMs, end: region.endMs }))
		.sort((a, b) => a.start - b.start);

	const sortedCandidates = [...candidates].sort(byPriority);
	const suggestions: AutoZoomSuggestion[] = [];
	const budget = Math.max(1, Math.floor(totalMs / SUGGESTION_BUDGET_MS));

	for (const candidate of sortedCandidates) {
		if (suggestions.length >= budget) {
			break;
		}

		const centeredStart = Math.round(candidate.centerTimeMs - defaultDuration / 2);
		const candidateStart = Math.max(0, Math.min(centeredStart, totalMs - defaultDuration));
		const candidateEnd = candidateStart + defaultDuration;
		// Zooms already on the timeline are given the same berth as suggested ones:
		// landing one right against a zoom the user placed reads as a stutter.
		const tooClose = reservedSpans.some(
			(span) =>
				candidateEnd + SUGGESTION_GAP_MS > span.start &&
				candidateStart - SUGGESTION_GAP_MS < span.end,
		);
		if (tooClose) {
			continue;
		}

		reservedSpans.push({ start: candidateStart, end: candidateEnd });
		suggestions.push({
			span: { start: candidateStart, end: candidateEnd },
			focus: candidate.focus,
			kind: candidate.kind,
		});
	}

	if (suggestions.length === 0) {
		return { ok: false, reason: "no-room" };
	}

	return { ok: true, suggestions };
}
