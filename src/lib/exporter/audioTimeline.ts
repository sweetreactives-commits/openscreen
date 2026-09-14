import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import { computeTimeline } from "@/lib/timeline";

/**
 * Laying several recordings' sound end to end on one output track.
 *
 * Encoded audio from different recordings cannot simply be concatenated: two
 * takes can differ in codec, sample rate and channel count. So every clip is
 * brought down to plain samples at one agreed rate, placed at its own offset in
 * a single buffer, and that buffer is encoded once.
 *
 * Speed regions are the awkward case and are deliberately not handled here. The
 * exporter preserves pitch by playing the audio in real time through a media
 * element, which no amount of sample copying reproduces — a clip with speed
 * changes arrives here already rendered, as plain samples with nothing left to
 * apply. See docs/architecture/multiclip.md.
 */

/** Planar samples: one array per channel, all the same length. */
export type PlanarAudio = Float32Array[];

export interface AudioPlacement {
	/** Where this clip's sound starts on the output track. */
	outStartMs: number;
	samples: PlanarAudio;
}

function msToFrames(ms: number, sampleRate: number): number {
	return Math.round((ms / 1000) * sampleRate);
}

/**
 * Cuts the trimmed spans out of a clip's samples.
 *
 * Only for clips with no speed changes: `computeTimeline` would report a speed
 * on a segment, and resampling here would shift the pitch. Such a clip is
 * rendered to samples before it gets this far.
 */
export function applyTrimsToSamples(
	samples: PlanarAudio,
	sampleRate: number,
	durationMs: number,
	trimRegions?: readonly TrimRegion[],
	speedRegions?: readonly SpeedRegion[],
): PlanarAudio {
	if (samples.length === 0) return [];

	const segments = computeTimeline(durationMs, trimRegions, speedRegions);
	if (segments.some((segment) => segment.speed !== 1)) {
		throw new Error("applyTrimsToSamples cannot change speed: render the clip's audio first");
	}

	const sourceLength = samples[0].length;
	const spans = segments
		.map((segment) => ({
			from: Math.min(sourceLength, Math.max(0, msToFrames(segment.startMs, sampleRate))),
			to: Math.min(sourceLength, Math.max(0, msToFrames(segment.endMs, sampleRate))),
		}))
		.filter((span) => span.to > span.from);

	const total = spans.reduce((sum, span) => sum + (span.to - span.from), 0);
	const output: PlanarAudio = samples.map(() => new Float32Array(total));

	let cursor = 0;
	for (const span of spans) {
		for (let channel = 0; channel < samples.length; channel++) {
			output[channel].set(samples[channel].subarray(span.from, span.to), cursor);
		}
		cursor += span.to - span.from;
	}

	return output;
}

/**
 * Builds the whole output track: every clip's samples at its own offset, and
 * silence wherever nothing is playing — under a title card, or in a gap.
 *
 * The buffer is sized to cover the last clip, so a recording that runs slightly
 * long is never clipped by an arithmetic mismatch with the video side.
 */
export function assembleAudioTimeline(
	placements: readonly AudioPlacement[],
	sampleRate: number,
	channels: number,
): PlanarAudio {
	if (channels < 1 || sampleRate <= 0) return [];

	const end = placements.reduce((longest, placement) => {
		const frames = placement.samples[0]?.length ?? 0;
		return Math.max(longest, msToFrames(placement.outStartMs, sampleRate) + frames);
	}, 0);

	const output: PlanarAudio = Array.from({ length: channels }, () => new Float32Array(end));

	for (const placement of placements) {
		const offset = Math.max(0, msToFrames(placement.outStartMs, sampleRate));
		for (let channel = 0; channel < channels; channel++) {
			// A mono clip feeds every output channel rather than falling silent on
			// the right; a clip with more channels than the output loses the extras.
			const source = placement.samples[channel] ?? placement.samples[0];
			if (!source) continue;

			const room = Math.max(0, end - offset);
			output[channel].set(source.subarray(0, room), offset);
		}
	}

	return output;
}

/** One piece of the output track, sized for the encoder. */
export interface AudioChunkPlan {
	frames: number;
	timestampUs: number;
}

/** Splits an assembled track into encoder-sized pieces with running timestamps. */
export function planAudioChunks(
	totalFrames: number,
	sampleRate: number,
	chunkFrames = 1024,
): AudioChunkPlan[] {
	if (!(totalFrames > 0) || !(sampleRate > 0) || !(chunkFrames > 0)) return [];

	const chunks: AudioChunkPlan[] = [];
	for (let frame = 0; frame < totalFrames; frame += chunkFrames) {
		chunks.push({
			frames: Math.min(chunkFrames, totalFrames - frame),
			timestampUs: Math.round((frame / sampleRate) * 1_000_000),
		});
	}
	return chunks;
}
