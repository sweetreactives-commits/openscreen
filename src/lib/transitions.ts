import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import { computeKeepSegments } from "@/lib/timeline";

/**
 * Smoothing the seams a trim leaves behind.
 *
 * Every trim turns into a jump cut, and a screencast has dozens of them. The
 * effect itself is alpha and nothing else, which is what makes it affordable:
 * both the preview and the export render through Pixi and can hold the last
 * frame before the cut, so a dissolve needs no second decoder and no overlapping
 * material.
 *
 * The maths here is deliberately ignorant of both paths. It is told how many
 * milliseconds of the **finished video** have passed since a seam — which the
 * export counts in frames and the preview counts on the wall clock, those being
 * the same thing — and answers with the alphas to draw. See
 * docs/architecture/transitions.md.
 */

export const TRANSITION_STYLES = ["none", "dissolve", "dip"] as const;
export type TransitionStyle = (typeof TRANSITION_STYLES)[number];

/**
 * Off by default: a project saved before this existed must export exactly as it
 * did, and a recording is not automatically better for having its cuts dissolved.
 */
export const DEFAULT_TRANSITION_STYLE: TransitionStyle = "none";
export const DEFAULT_TRANSITION_MS = 250;
export const MIN_TRANSITION_MS = 80;
export const MAX_TRANSITION_MS = 800;

export function normalizeTransitionStyle(value: unknown): TransitionStyle {
	return TRANSITION_STYLES.includes(value as TransitionStyle)
		? (value as TransitionStyle)
		: DEFAULT_TRANSITION_STYLE;
}

export function normalizeTransitionMs(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TRANSITION_MS;
	return Math.round(Math.min(Math.max(value, MIN_TRANSITION_MS), MAX_TRANSITION_MS));
}

/** A cut with material on both sides of it. */
export interface Seam {
	/** Source time where the outgoing material stops. */
	outMs: number;
	/** Source time where the incoming material starts. */
	inMs: number;
}

/**
 * The seams a recording's trims leave.
 *
 * Derived from the surviving segments rather than from the trims themselves, so
 * overlapping and touching trims count once. A trim at the very start or the very
 * end of the recording leaves no seam: there is nothing on one side of it, which
 * makes it an edge trimmed off, not a cut to smooth over.
 */
export function seamsFromTrims(
	sourceDurationMs: number,
	trimRegions?: readonly TrimRegion[],
): Seam[] {
	const segments = computeKeepSegments(sourceDurationMs, trimRegions);
	const seams: Seam[] = [];
	for (let index = 1; index < segments.length; index++) {
		seams.push({ outMs: segments[index - 1].endMs, inMs: segments[index].startMs });
	}
	return seams;
}

/** The seam a jump from one source time to another skipped over, if any. */
export function seamBetween(
	seams: readonly Seam[],
	previousSourceMs: number,
	sourceMs: number,
): Seam | null {
	if (sourceMs <= previousSourceMs) return null;
	return seams.find((seam) => previousSourceMs <= seam.outMs && sourceMs >= seam.inMs - 1) ?? null;
}

/** Playback speed in force at a moment of the recording. */
export function speedAt(
	speedRegions: readonly SpeedRegion[] | undefined,
	sourceMs: number,
): number {
	const region = speedRegions?.find((r) => sourceMs >= r.startMs && sourceMs < r.endMs);
	const speed = region?.speed ?? 1;
	return speed > 0 ? speed : 1;
}

/**
 * How much of the finished video is left before the next seam.
 *
 * In the finished video's time, not the recording's: a stretch played at 2× is
 * over in half the time, and the fade has to be over with it.
 */
export function outputMsUntilSeam(
	seams: readonly Seam[],
	sourceMs: number,
	speedRegions?: readonly SpeedRegion[],
): number | null {
	const next = seams.find((seam) => seam.outMs > sourceMs);
	if (!next) return null;
	return (next.outMs - sourceMs) / speedAt(speedRegions, sourceMs);
}

/** What to draw on top of the frame. */
export interface TransitionOverlay {
	/** Alpha of the held frame from before the cut, drawn over the new material. */
	frozenAlpha: number;
	/** Alpha of black over everything. */
	blackAlpha: number;
}

const NOTHING: TransitionOverlay = { frozenAlpha: 0, blackAlpha: 0 };

function clamp01(value: number): number {
	return Math.min(Math.max(value, 0), 1);
}

/** The half of a dip that happens before the cut takes half its length. */
function dipHalfMs(durationMs: number): number {
	return Math.max(1, durationMs / 2);
}

/** What to draw `msSinceSeam` into the finished video after a cut. */
export function overlayAfterSeam(
	style: TransitionStyle,
	durationMs: number,
	msSinceSeam: number,
): TransitionOverlay {
	if (style === "none" || msSinceSeam < 0) return NOTHING;

	if (style === "dissolve") {
		if (msSinceSeam >= durationMs) return NOTHING;
		return { frozenAlpha: 1 - clamp01(msSinceSeam / durationMs), blackAlpha: 0 };
	}

	const half = dipHalfMs(durationMs);
	if (msSinceSeam >= half) return NOTHING;
	return { frozenAlpha: 0, blackAlpha: 1 - clamp01(msSinceSeam / half) };
}

/**
 * What to draw `msUntilSeam` of finished video before the next cut.
 *
 * Only a dip has anything to do here: it darkens on the way in so the cut lands
 * in black. A dissolve has no such half — it holds the last frame and fades it
 * out afterwards, which is the whole reason it needs no material to overlap.
 */
export function overlayBeforeSeam(
	style: TransitionStyle,
	durationMs: number,
	msUntilSeam: number | null,
): TransitionOverlay {
	if (style !== "dip" || msUntilSeam === null || msUntilSeam < 0) return NOTHING;

	const half = dipHalfMs(durationMs);
	if (msUntilSeam >= half) return NOTHING;
	return { frozenAlpha: 0, blackAlpha: 1 - clamp01(msUntilSeam / half) };
}

/** Whichever of the two halves is showing, the stronger one wins. */
export function combineOverlays(
	before: TransitionOverlay,
	after: TransitionOverlay,
): TransitionOverlay {
	return {
		frozenAlpha: Math.max(before.frozenAlpha, after.frozenAlpha),
		blackAlpha: Math.max(before.blackAlpha, after.blackAlpha),
	};
}
