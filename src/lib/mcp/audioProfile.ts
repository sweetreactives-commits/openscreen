/**
 * Audio reduced to a loudness curve and a list of quiet stretches.
 *
 * The editor already decodes the track into paired [min, max] peaks for the
 * waveform, so this reuses that instead of touching audio again. What an agent
 * needs is coarse: roughly how loud, and where nobody is talking — the raw peak
 * array is tens of thousands of floats and says nothing more.
 */

export interface SilenceSpan {
	startMs: number;
	endMs: number;
	durationMs: number;
}

export interface AudioProfile {
	/** Peak blocks behind the summary, for a sense of the resolution. */
	blockCount: number;
	/** How much source time each loudness bucket covers. */
	bucketMs: number;
	/** Peak amplitude per bucket, 0 to 1. */
	loudness: number[];
	silences: SilenceSpan[];
	totalSilenceMs: number;
}

export interface AudioProfileOptions {
	/** Buckets in the returned curve. The default reads well without being long. */
	bucketCount?: number;
	/** Amplitude at or below which a block counts as quiet. */
	silenceThreshold?: number;
	/** Quiet stretches shorter than this are pauses in speech, not dead air. */
	minSilenceMs?: number;
}

const DEFAULT_BUCKET_COUNT = 120;
const DEFAULT_SILENCE_THRESHOLD = 0.02;
const DEFAULT_MIN_SILENCE_MS = 700;

function round(value: number, decimals = 3): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

/**
 * @param peaks Paired [min, max] per block, as produced for the waveform — its
 *   length is twice the block count.
 * @param durationMs Source duration the peaks span.
 */
export function buildAudioProfile(
	peaks: Float32Array | null,
	durationMs: number,
	options: AudioProfileOptions = {},
): AudioProfile {
	const bucketCount = options.bucketCount ?? DEFAULT_BUCKET_COUNT;
	const silenceThreshold = options.silenceThreshold ?? DEFAULT_SILENCE_THRESHOLD;
	const minSilenceMs = options.minSilenceMs ?? DEFAULT_MIN_SILENCE_MS;

	const blockCount = peaks ? Math.floor(peaks.length / 2) : 0;
	if (!peaks || blockCount === 0 || !(durationMs > 0)) {
		return { blockCount: 0, bucketMs: 0, loudness: [], silences: [], totalSilenceMs: 0 };
	}

	const msPerBlock = durationMs / blockCount;
	const amplitudes = new Float32Array(blockCount);
	for (let i = 0; i < blockCount; i++) {
		amplitudes[i] = Math.max(Math.abs(peaks[i * 2]), Math.abs(peaks[i * 2 + 1]));
	}

	const buckets = Math.min(bucketCount, blockCount);
	const loudness: number[] = [];
	for (let b = 0; b < buckets; b++) {
		const from = Math.floor((b * blockCount) / buckets);
		const to = Math.max(from + 1, Math.floor(((b + 1) * blockCount) / buckets));
		let peak = 0;
		for (let i = from; i < to; i++) {
			if (amplitudes[i] > peak) peak = amplitudes[i];
		}
		loudness.push(round(peak));
	}

	const silences: SilenceSpan[] = [];
	let quietFrom: number | null = null;
	for (let i = 0; i < blockCount; i++) {
		const quiet = amplitudes[i] <= silenceThreshold;
		if (quiet) {
			if (quietFrom === null) quietFrom = i;
			continue;
		}
		if (quietFrom !== null) {
			pushSilence(silences, quietFrom, i, msPerBlock, minSilenceMs);
			quietFrom = null;
		}
	}
	if (quietFrom !== null) {
		pushSilence(silences, quietFrom, blockCount, msPerBlock, minSilenceMs);
	}

	return {
		blockCount,
		bucketMs: round(durationMs / buckets, 1),
		loudness,
		silences,
		totalSilenceMs: silences.reduce((sum, span) => sum + span.durationMs, 0),
	};
}

function pushSilence(
	silences: SilenceSpan[],
	fromBlock: number,
	toBlock: number,
	msPerBlock: number,
	minSilenceMs: number,
): void {
	const startMs = Math.round(fromBlock * msPerBlock);
	const endMs = Math.round(toBlock * msPerBlock);
	const durationMs = endMs - startMs;
	if (durationMs >= minSilenceMs) {
		silences.push({ startMs, endMs, durationMs });
	}
}
