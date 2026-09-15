import { locateSourceTime, type PlacedClip, type Sequence } from "@/lib/sequence";

/**
 * Moving a playhead through a sequence while it plays.
 *
 * The player shows one clip at a time. A recording plays itself — its video
 * element skips its own trims and follows its own speeds, and reports where it is
 * in **source** time. A card has no video, so its time is simply counted. Either
 * way the question after every tick is the same: are we still inside this clip,
 * and if not, where does playback go next? These functions answer it without
 * knowing anything about video elements.
 */

/** What playback should do after a tick. */
export type PlaybackStep =
	/** Still inside the current clip; the playhead is here. */
	| { kind: "continue"; timelineMs: number }
	/** The current clip is done; start this one from its beginning. */
	| { kind: "enter"; clipId: string; timelineMs: number; sourceMs: number }
	/** Nothing left to play; the playhead rests at the end. */
	| { kind: "end"; timelineMs: number };

function isPlayable(clip: PlacedClip): boolean {
	return clip.outEndMs > clip.outStartMs && clip.segments.length > 0;
}

/** The first clip after `clipId` that has anything to show, if one exists. */
export function nextPlayableClip(sequence: Sequence, clipId: string): PlacedClip | null {
	const index = sequence.clips.findIndex((clip) => clip.id === clipId);
	if (index === -1) return null;
	return sequence.clips.slice(index + 1).find(isPlayable) ?? null;
}

/** Where a clip starts, on both clocks. */
export function clipStart(clip: PlacedClip): { timelineMs: number; sourceMs: number } {
	return { timelineMs: clip.outStartMs, sourceMs: clip.segments[0]?.startMs ?? 0 };
}

function leave(sequence: Sequence, clipId: string): PlaybackStep {
	const next = nextPlayableClip(sequence, clipId);
	if (!next) return { kind: "end", timelineMs: sequence.durationMs };
	return { kind: "enter", clipId: next.id, ...clipStart(next) };
}

/**
 * A recording reported its position.
 *
 * `stopped` means its video stopped on its own — it ran off the end of the file,
 * or skipped a trailing trim that reaches the end. Playback never stops mid-clip
 * by itself, so that is always the end of the clip.
 *
 * A position inside a trim is a moment the video is about to skip, not a place on
 * the timeline: the playhead waits at the next surviving segment rather than jump
 * back and forth.
 */
export function stepRecording(
	sequence: Sequence,
	clipId: string,
	sourceMs: number,
	stopped = false,
): PlaybackStep {
	const clip = sequence.clips.find((candidate) => candidate.id === clipId);
	if (!clip || !isPlayable(clip)) return leave(sequence, clipId);

	const last = clip.segments[clip.segments.length - 1];
	if (stopped || sourceMs >= last.endMs) return leave(sequence, clipId);

	const timelineMs = locateSourceTime(sequence, clipId, sourceMs);
	if (timelineMs !== null) return { kind: "continue", timelineMs };

	const upcoming = clip.segments.find((segment) => segment.startMs > sourceMs);
	if (!upcoming) return leave(sequence, clipId);
	return {
		kind: "continue",
		timelineMs: locateSourceTime(sequence, clipId, upcoming.startMs) ?? clip.outStartMs,
	};
}

/** A card's counted time reached `timelineMs`. */
export function stepCard(sequence: Sequence, clipId: string, timelineMs: number): PlaybackStep {
	const clip = sequence.clips.find((candidate) => candidate.id === clipId);
	if (!clip || timelineMs >= clip.outEndMs) return leave(sequence, clipId);
	return { kind: "continue", timelineMs: Math.max(timelineMs, clip.outStartMs) };
}
