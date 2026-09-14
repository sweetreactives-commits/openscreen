import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import { computeTimeline, type KeepSegment } from "@/lib/timeline";

/**
 * A project as a sequence of clips, and the arithmetic that lays them on one axis.
 *
 * The editor has two clocks, and confusing them is the expensive mistake here:
 *
 * - **source time** — milliseconds inside one clip's own recording. Every region
 *   (zoom, trim, speed, annotation, blur), the cursor telemetry and the transcript
 *   all address this clock, and they keep doing so no matter where the clip sits.
 * - **timeline time** — milliseconds into the finished video, across all clips.
 *
 * Regions deliberately live in source time and belong to their clip. The
 * alternative — storing them against the timeline — looks simpler until a clip is
 * reordered or its trims change, at which point every region in every later clip
 * has to be rewritten. Here, moving a clip moves its edits with it and touches
 * nothing else.
 *
 * See docs/architecture/multiclip.md for the whole plan this belongs to.
 */

/** What a clip has to expose for the sequence to place it. */
export interface SequenceClipInput {
	id: string;
	/** Length of the clip's own recording, before trims and speeds. */
	sourceDurationMs: number;
	trimRegions?: readonly TrimRegion[];
	speedRegions?: readonly SpeedRegion[];
}

/** Where a clip landed on the output timeline, and what survives inside it. */
export interface PlacedClip {
	id: string;
	/** Start on the timeline clock. */
	outStartMs: number;
	/** End on the timeline clock. Equal to `outStartMs` when nothing survives. */
	outEndMs: number;
	/** Surviving spans, in this clip's **source** time, each with its speed. */
	segments: KeepSegment[];
}

export interface Sequence {
	/** In playback order, with timeline positions already resolved. */
	clips: PlacedClip[];
	/** How long the finished video runs. */
	durationMs: number;
}

/** A point in the sequence, expressed on both clocks. */
export interface SequencePosition {
	clipId: string;
	/** Where this lands inside that clip's own recording. */
	sourceMs: number;
	/** Where it landed on the timeline — may differ from a request that was clamped. */
	timelineMs: number;
}

/** Output length of one keep-segment: a 2× segment takes half as long to play. */
function outputLengthMs(segment: KeepSegment): number {
	return (segment.endMs - segment.startMs) / segment.speed;
}

/** Total output length of a clip's surviving segments. */
function clipOutputLengthMs(segments: readonly KeepSegment[]): number {
	return segments.reduce((total, segment) => total + outputLengthMs(segment), 0);
}

/**
 * Lays the clips end to end and reports where each one starts and ends.
 *
 * A clip trimmed away to nothing still appears, with `outStartMs === outEndMs`:
 * it is part of the project and the timeline has to draw it, it simply
 * contributes no footage. Nothing ever resolves *into* such a clip.
 */
export function computeSequence(clips: readonly SequenceClipInput[]): Sequence {
	const placed: PlacedClip[] = [];
	let cursor = 0;

	for (const clip of clips) {
		const segments = computeTimeline(
			Math.max(0, clip.sourceDurationMs),
			clip.trimRegions,
			clip.speedRegions,
		);
		const length = clipOutputLengthMs(segments);

		placed.push({
			id: clip.id,
			outStartMs: cursor,
			outEndMs: cursor + length,
			segments,
		});
		cursor += length;
	}

	return { clips: placed, durationMs: cursor };
}

/**
 * Timeline time → the clip playing then, and where inside its recording.
 *
 * Out-of-range requests are clamped into the sequence rather than refused, and
 * the result says where they actually landed. That mirrors `grabFrame`, and it
 * keeps every caller — scrubber at 100%, a seek past the end — from writing the
 * same clamp. `null` means only that there is nothing to play at all.
 */
export function resolveTimelinePosition(
	sequence: Sequence,
	timelineMs: number,
): SequencePosition | null {
	const playable = sequence.clips.filter((clip) => clip.outEndMs > clip.outStartMs);
	if (playable.length === 0) return null;

	const wanted = Number.isFinite(timelineMs) ? timelineMs : 0;
	const clamped = Math.min(Math.max(wanted, 0), sequence.durationMs);

	// The last instant belongs to the last clip: at exactly durationMs no clip's
	// half-open span contains the point, but the caller still wants a frame.
	const clip =
		playable.find((candidate) => clamped >= candidate.outStartMs && clamped < candidate.outEndMs) ??
		playable[playable.length - 1];

	let remaining = Math.min(Math.max(clamped - clip.outStartMs, 0), clip.outEndMs - clip.outStartMs);

	for (const segment of clip.segments) {
		const length = outputLengthMs(segment);
		if (remaining < length) {
			return {
				clipId: clip.id,
				sourceMs: segment.startMs + remaining * segment.speed,
				timelineMs: clamped,
			};
		}
		remaining -= length;
	}

	// Ran past the last segment by rounding: answer with its final instant.
	const last = clip.segments[clip.segments.length - 1];
	return { clipId: clip.id, sourceMs: last.endMs, timelineMs: clamped };
}

/**
 * A moment inside a clip's recording → where it shows up in the finished video.
 *
 * `null` when that moment is cut out — it genuinely has no place on the timeline,
 * and the caller (a region being drawn, a click being mapped) needs to know that
 * rather than be handed a plausible nearby number.
 */
export function locateSourceTime(
	sequence: Sequence,
	clipId: string,
	sourceMs: number,
): number | null {
	const clip = sequence.clips.find((candidate) => candidate.id === clipId);
	if (!clip) return null;

	let offset = 0;
	for (const segment of clip.segments) {
		if (sourceMs >= segment.startMs && sourceMs < segment.endMs) {
			return clip.outStartMs + offset + (sourceMs - segment.startMs) / segment.speed;
		}
		offset += outputLengthMs(segment);
	}

	// The very end of the last surviving segment is still on the timeline, at the
	// clip's closing instant; anything else fell inside a trim.
	const last = clip.segments[clip.segments.length - 1];
	if (last && sourceMs === last.endMs) return clip.outEndMs;

	return null;
}

/** The clip playing at this point on the timeline, if any. */
export function clipAt(sequence: Sequence, timelineMs: number): PlacedClip | null {
	const position = resolveTimelinePosition(sequence, timelineMs);
	if (!position) return null;
	return sequence.clips.find((clip) => clip.id === position.clipId) ?? null;
}
