import { describe, expect, it } from "vitest";
import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import {
	computeKeepSegments,
	computeOutputDurationMs,
	computeTimeline,
	splitBySpeed,
} from "./timeline";

const trim = (startMs: number, endMs: number, id = `trim-${startMs}`): TrimRegion => ({
	id,
	startMs,
	endMs,
});

const speed = (startMs: number, endMs: number, value: number): SpeedRegion => ({
	id: `speed-${startMs}`,
	startMs,
	endMs,
	speed: value,
});

describe("computeKeepSegments", () => {
	it("keeps the whole recording when nothing is trimmed", () => {
		expect(computeKeepSegments(10_000)).toEqual([{ startMs: 0, endMs: 10_000 }]);
		expect(computeKeepSegments(10_000, [])).toEqual([{ startMs: 0, endMs: 10_000 }]);
	});

	it("keeps the gaps around a trim, not the trim itself", () => {
		expect(computeKeepSegments(10_000, [trim(3_000, 5_000)])).toEqual([
			{ startMs: 0, endMs: 3_000 },
			{ startMs: 5_000, endMs: 10_000 },
		]);
	});

	it("drops the head when the trim starts at zero", () => {
		expect(computeKeepSegments(10_000, [trim(0, 4_000)])).toEqual([
			{ startMs: 4_000, endMs: 10_000 },
		]);
	});

	it("drops the tail when the trim runs to the end", () => {
		expect(computeKeepSegments(10_000, [trim(6_000, 10_000)])).toEqual([
			{ startMs: 0, endMs: 6_000 },
		]);
	});

	it("returns nothing when the whole recording is trimmed away", () => {
		expect(computeKeepSegments(10_000, [trim(0, 10_000)])).toEqual([]);
	});

	it("sorts trims that arrive out of order", () => {
		expect(computeKeepSegments(10_000, [trim(7_000, 8_000), trim(2_000, 3_000)])).toEqual([
			{ startMs: 0, endMs: 2_000 },
			{ startMs: 3_000, endMs: 7_000 },
			{ startMs: 8_000, endMs: 10_000 },
		]);
	});

	it("merges overlapping trims", () => {
		expect(computeKeepSegments(10_000, [trim(2_000, 5_000), trim(4_000, 7_000)])).toEqual([
			{ startMs: 0, endMs: 2_000 },
			{ startMs: 7_000, endMs: 10_000 },
		]);
	});

	it("does not resurrect footage when one trim is nested inside another", () => {
		// The nested trim sorts second and ends earlier. Assigning the cursor instead of
		// advancing it would move it back to 3s and keep 3s–8s, which the wider trim cut.
		expect(computeKeepSegments(10_000, [trim(1_000, 8_000), trim(2_000, 3_000)])).toEqual([
			{ startMs: 0, endMs: 1_000 },
			{ startMs: 8_000, endMs: 10_000 },
		]);
	});

	it("clamps trims that reach past the end of the recording", () => {
		expect(computeKeepSegments(10_000, [trim(8_000, 99_000)])).toEqual([
			{ startMs: 0, endMs: 8_000 },
		]);
	});

	it("clamps trims that start before zero", () => {
		expect(computeKeepSegments(10_000, [trim(-5_000, 2_000)])).toEqual([
			{ startMs: 2_000, endMs: 10_000 },
		]);
	});

	it("tolerates a reversed trim by treating it as the span it covers", () => {
		expect(computeKeepSegments(10_000, [trim(5_000, 3_000)])).toEqual([
			{ startMs: 0, endMs: 3_000 },
			{ startMs: 5_000, endMs: 10_000 },
		]);
	});

	it("ignores zero-length trims", () => {
		expect(computeKeepSegments(10_000, [trim(4_000, 4_000)])).toEqual([
			{ startMs: 0, endMs: 10_000 },
		]);
	});

	it("returns nothing for a recording with no duration", () => {
		expect(computeKeepSegments(0, [trim(0, 1_000)])).toEqual([]);
		expect(computeKeepSegments(Number.NaN)).toEqual([]);
	});
});

describe("splitBySpeed", () => {
	const whole = [{ startMs: 0, endMs: 10_000 }];

	it("marks everything 1x when there are no speed regions", () => {
		expect(splitBySpeed(whole)).toEqual([{ startMs: 0, endMs: 10_000, speed: 1 }]);
	});

	it("splits a segment around a speed region in the middle", () => {
		expect(splitBySpeed(whole, [speed(4_000, 6_000, 2)])).toEqual([
			{ startMs: 0, endMs: 4_000, speed: 1 },
			{ startMs: 4_000, endMs: 6_000, speed: 2 },
			{ startMs: 6_000, endMs: 10_000, speed: 1 },
		]);
	});

	it("clips a speed region to the segment it overlaps", () => {
		expect(splitBySpeed([{ startMs: 2_000, endMs: 8_000 }], [speed(0, 99_000, 4)])).toEqual([
			{ startMs: 2_000, endMs: 8_000, speed: 4 },
		]);
	});

	it("ignores speed regions that fall inside a trimmed-away gap", () => {
		const segments = computeKeepSegments(10_000, [trim(3_000, 6_000)]);
		expect(splitBySpeed(segments, [speed(4_000, 5_000, 4)])).toEqual([
			{ startMs: 0, endMs: 3_000, speed: 1 },
			{ startMs: 6_000, endMs: 10_000, speed: 1 },
		]);
	});

	it("applies two speed regions inside one segment", () => {
		expect(splitBySpeed(whole, [speed(1_000, 2_000, 2), speed(5_000, 6_000, 0.5)])).toEqual([
			{ startMs: 0, endMs: 1_000, speed: 1 },
			{ startMs: 1_000, endMs: 2_000, speed: 2 },
			{ startMs: 2_000, endMs: 5_000, speed: 1 },
			{ startMs: 5_000, endMs: 6_000, speed: 0.5 },
			{ startMs: 6_000, endMs: 10_000, speed: 1 },
		]);
	});
});

describe("computeOutputDurationMs", () => {
	it("is the source duration when nothing is edited", () => {
		expect(computeOutputDurationMs(10_000)).toBe(10_000);
	});

	it("subtracts trimmed spans", () => {
		expect(computeOutputDurationMs(10_000, [trim(2_000, 4_000)])).toBe(8_000);
	});

	it("divides sped-up spans by their multiplier", () => {
		// 0–4s at 1x, 4–6s at 2x (1s of output), 6–10s at 1x.
		expect(computeOutputDurationMs(10_000, [], [speed(4_000, 6_000, 2)])).toBe(9_000);
	});

	it("stretches slowed-down spans", () => {
		expect(computeOutputDurationMs(10_000, [], [speed(0, 2_000, 0.5)])).toBe(12_000);
	});

	it("combines trims and speeds", () => {
		// Cut 0–2s, leaving 2–10s; of that, 2–4s runs at 4x (0.5s) and 4–10s at 1x.
		const result = computeOutputDurationMs(10_000, [trim(0, 2_000)], [speed(2_000, 4_000, 4)]);
		expect(result).toBe(6_500);
	});

	it("is zero when everything is trimmed away", () => {
		expect(computeOutputDurationMs(10_000, [trim(0, 10_000)])).toBe(0);
	});
});

describe("computeTimeline", () => {
	it("composes trimming and speed in one call", () => {
		expect(computeTimeline(10_000, [trim(0, 2_000)], [speed(4_000, 6_000, 2)])).toEqual([
			{ startMs: 2_000, endMs: 4_000, speed: 1 },
			{ startMs: 4_000, endMs: 6_000, speed: 2 },
			{ startMs: 6_000, endMs: 10_000, speed: 1 },
		]);
	});
});
