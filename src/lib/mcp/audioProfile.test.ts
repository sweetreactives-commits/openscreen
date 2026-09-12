import { describe, expect, it } from "vitest";
import { buildAudioProfile } from "./audioProfile";

/** Peaks are paired [min, max] per block; these helpers build that layout. */
function peaksFromAmplitudes(amplitudes: number[]): Float32Array {
	const peaks = new Float32Array(amplitudes.length * 2);
	for (let i = 0; i < amplitudes.length; i++) {
		peaks[i * 2] = -amplitudes[i];
		peaks[i * 2 + 1] = amplitudes[i];
	}
	return peaks;
}

function repeat(value: number, count: number): number[] {
	return Array.from({ length: count }, () => value);
}

describe("buildAudioProfile", () => {
	it("returns an empty profile when there is no audio track", () => {
		expect(buildAudioProfile(null, 10_000)).toEqual({
			blockCount: 0,
			bucketMs: 0,
			loudness: [],
			silences: [],
			totalSilenceMs: 0,
		});
	});

	it("returns an empty profile for a recording with no duration", () => {
		expect(buildAudioProfile(peaksFromAmplitudes([0.5, 0.5]), 0).blockCount).toBe(0);
	});

	it("reports one loudness value per bucket, peak-weighted", () => {
		const profile = buildAudioProfile(peaksFromAmplitudes([0.1, 0.9, 0.2, 0.8]), 4_000, {
			bucketCount: 2,
		});
		// Two buckets over four blocks: max(0.1, 0.9) then max(0.2, 0.8).
		expect(profile.loudness).toEqual([0.9, 0.8]);
		expect(profile.blockCount).toBe(4);
		expect(profile.bucketMs).toBe(2_000);
	});

	it("never asks for more buckets than there are blocks", () => {
		const profile = buildAudioProfile(peaksFromAmplitudes([0.5, 0.5]), 1_000, {
			bucketCount: 100,
		});
		expect(profile.loudness).toHaveLength(2);
	});

	it("uses the loudest of the min and max sides", () => {
		const peaks = new Float32Array([-0.8, 0.1]);
		expect(buildAudioProfile(peaks, 1_000, { bucketCount: 1 }).loudness).toEqual([0.8]);
	});

	it("finds a quiet stretch in the middle", () => {
		// 10 loud blocks, 20 quiet, 10 loud — over 40 seconds, so 1s per block.
		const profile = buildAudioProfile(
			peaksFromAmplitudes([...repeat(0.6, 10), ...repeat(0, 20), ...repeat(0.6, 10)]),
			40_000,
		);
		expect(profile.silences).toHaveLength(1);
		expect(profile.silences[0]).toEqual({ startMs: 10_000, endMs: 30_000, durationMs: 20_000 });
		expect(profile.totalSilenceMs).toBe(20_000);
	});

	it("finds a quiet stretch that runs to the end", () => {
		const profile = buildAudioProfile(
			peaksFromAmplitudes([...repeat(0.6, 10), ...repeat(0, 10)]),
			20_000,
		);
		expect(profile.silences).toEqual([{ startMs: 10_000, endMs: 20_000, durationMs: 10_000 }]);
	});

	it("ignores pauses shorter than the minimum", () => {
		// 40 blocks over 20 seconds is 500 ms each, so one quiet block is a breath
		// between sentences rather than dead air worth cutting.
		const profile = buildAudioProfile(
			peaksFromAmplitudes([...repeat(0.6, 20), 0, ...repeat(0.6, 19)]),
			20_000,
		);
		expect(profile.silences).toEqual([]);
	});

	it("reports a pause once it crosses the minimum", () => {
		// Two adjacent quiet blocks at 500 ms each clear the 700 ms floor.
		const profile = buildAudioProfile(
			peaksFromAmplitudes([...repeat(0.6, 20), 0, 0, ...repeat(0.6, 18)]),
			20_000,
		);
		expect(profile.silences).toEqual([{ startMs: 10_000, endMs: 11_000, durationMs: 1_000 }]);
	});

	it("treats near-silence under the threshold as quiet", () => {
		const profile = buildAudioProfile(
			peaksFromAmplitudes([...repeat(0.6, 5), ...repeat(0.01, 10), ...repeat(0.6, 5)]),
			20_000,
		);
		expect(profile.silences).toHaveLength(1);
	});

	it("honours a custom silence threshold", () => {
		const amplitudes = [...repeat(0.6, 5), ...repeat(0.1, 10), ...repeat(0.6, 5)];
		expect(buildAudioProfile(peaksFromAmplitudes(amplitudes), 20_000).silences).toEqual([]);
		expect(
			buildAudioProfile(peaksFromAmplitudes(amplitudes), 20_000, { silenceThreshold: 0.2 })
				.silences,
		).toHaveLength(1);
	});

	it("calls a fully silent track one long silence", () => {
		const profile = buildAudioProfile(peaksFromAmplitudes(repeat(0, 20)), 20_000);
		expect(profile.silences).toEqual([{ startMs: 0, endMs: 20_000, durationMs: 20_000 }]);
	});
});
