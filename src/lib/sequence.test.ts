import { describe, expect, it } from "vitest";
import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import {
	clipAt,
	computeSequence,
	locateSourceTime,
	resolveTimelinePosition,
	type SequenceClipInput,
} from "./sequence";

const trim = (startMs: number, endMs: number): TrimRegion => ({
	id: `trim-${startMs}`,
	startMs,
	endMs,
});

const speed = (startMs: number, endMs: number, value: number): SpeedRegion => ({
	id: `speed-${startMs}`,
	startMs,
	endMs,
	speed: value,
});

const clip = (id: string, sourceDurationMs: number, rest: Partial<SequenceClipInput> = {}) => ({
	id,
	sourceDurationMs,
	...rest,
});

describe("computeSequence", () => {
	it("reports nothing for a project with no clips", () => {
		expect(computeSequence([])).toEqual({ clips: [], durationMs: 0 });
	});

	it("places a single untouched clip as the whole timeline", () => {
		const sequence = computeSequence([clip("a", 10_000)]);

		expect(sequence.durationMs).toBe(10_000);
		expect(sequence.clips).toEqual([
			{
				id: "a",
				outStartMs: 0,
				outEndMs: 10_000,
				segments: [{ startMs: 0, endMs: 10_000, speed: 1 }],
			},
		]);
	});

	it("lays clips end to end, each starting where the last one stopped", () => {
		const sequence = computeSequence([clip("a", 4_000), clip("b", 6_000), clip("c", 1_000)]);

		expect(sequence.clips.map((c) => [c.outStartMs, c.outEndMs])).toEqual([
			[0, 4_000],
			[4_000, 10_000],
			[10_000, 11_000],
		]);
		expect(sequence.durationMs).toBe(11_000);
	});

	it("shortens a trimmed clip and pulls everything after it forward", () => {
		const sequence = computeSequence([
			clip("a", 10_000, { trimRegions: [trim(2_000, 5_000)] }),
			clip("b", 3_000),
		]);

		// 3s cut out of a 10s clip leaves 7s, so "b" starts at 7s rather than 10s.
		expect(sequence.clips[0].outEndMs).toBe(7_000);
		expect(sequence.clips[1].outStartMs).toBe(7_000);
		expect(sequence.durationMs).toBe(10_000);
	});

	it("counts a sped-up span by how long it takes to play, not how long it was", () => {
		const sequence = computeSequence([clip("a", 10_000, { speedRegions: [speed(0, 10_000, 2)] })]);
		expect(sequence.durationMs).toBe(5_000);
	});

	it("keeps segments in source time, so a clip's edits do not depend on where it sits", () => {
		const edited = clip("a", 10_000, { trimRegions: [trim(2_000, 5_000)] });

		const first = computeSequence([edited, clip("b", 3_000)]);
		const second = computeSequence([clip("b", 3_000), edited]);

		// The clip moved from the start of the timeline to the middle of it, and its
		// own segments are untouched. This is the property the whole model rests on.
		expect(first.clips[0].segments).toEqual(second.clips[1].segments);
		expect(second.clips[1].outStartMs).toBe(3_000);
	});

	it("keeps a fully trimmed clip in the project, contributing nothing", () => {
		const sequence = computeSequence([
			clip("a", 5_000, { trimRegions: [trim(0, 5_000)] }),
			clip("b", 2_000),
		]);

		expect(sequence.clips[0]).toMatchObject({ outStartMs: 0, outEndMs: 0, segments: [] });
		expect(sequence.clips[1]).toMatchObject({ outStartMs: 0, outEndMs: 2_000 });
		expect(sequence.durationMs).toBe(2_000);
	});

	it("treats a clip with no length as empty rather than negative", () => {
		const sequence = computeSequence([clip("a", 0), clip("b", -500), clip("c", 1_000)]);
		expect(sequence.durationMs).toBe(1_000);
	});
});

describe("resolveTimelinePosition", () => {
	it("has nothing to resolve in an empty sequence", () => {
		expect(resolveTimelinePosition(computeSequence([]), 0)).toBeNull();
	});

	it("maps straight through when a single clip has no edits", () => {
		const sequence = computeSequence([clip("a", 10_000)]);
		expect(resolveTimelinePosition(sequence, 3_500)).toEqual({
			clipId: "a",
			sourceMs: 3_500,
			timelineMs: 3_500,
		});
	});

	it("finds the right clip and the right moment inside it", () => {
		const sequence = computeSequence([clip("a", 4_000), clip("b", 6_000)]);

		expect(resolveTimelinePosition(sequence, 5_000)).toEqual({
			clipId: "b",
			sourceMs: 1_000,
			timelineMs: 5_000,
		});
	});

	it("gives a clip boundary to the clip that is starting", () => {
		const sequence = computeSequence([clip("a", 4_000), clip("b", 6_000)]);
		expect(resolveTimelinePosition(sequence, 4_000)?.clipId).toBe("b");
	});

	it("skips over a trim: the timeline never addresses cut footage", () => {
		const sequence = computeSequence([clip("a", 10_000, { trimRegions: [trim(2_000, 5_000)] })]);

		// Just before the cut.
		expect(resolveTimelinePosition(sequence, 1_999)?.sourceMs).toBe(1_999);
		// At the cut, playback has already jumped to where it resumes.
		expect(resolveTimelinePosition(sequence, 2_000)?.sourceMs).toBe(5_000);
		expect(resolveTimelinePosition(sequence, 3_000)?.sourceMs).toBe(6_000);
	});

	it("runs the source clock faster inside a sped-up span", () => {
		const sequence = computeSequence([clip("a", 10_000, { speedRegions: [speed(0, 10_000, 2)] })]);

		// One second of watching covers two seconds of the recording.
		expect(resolveTimelinePosition(sequence, 1_000)?.sourceMs).toBe(2_000);
	});

	it("clamps instead of refusing, and says where it landed", () => {
		const sequence = computeSequence([clip("a", 4_000), clip("b", 6_000)]);

		expect(resolveTimelinePosition(sequence, -500)).toEqual({
			clipId: "a",
			sourceMs: 0,
			timelineMs: 0,
		});

		// A scrubber at 100% asks for exactly the duration; it wants the last frame,
		// not null.
		const end = resolveTimelinePosition(sequence, 10_000);
		expect(end).toMatchObject({ clipId: "b", timelineMs: 10_000 });
		expect(end?.sourceMs).toBe(6_000);

		expect(resolveTimelinePosition(sequence, 99_999)?.clipId).toBe("b");
	});

	it("never lands on a clip that was trimmed away to nothing", () => {
		const sequence = computeSequence([
			clip("gone", 5_000, { trimRegions: [trim(0, 5_000)] }),
			clip("b", 2_000),
		]);

		expect(resolveTimelinePosition(sequence, 0)?.clipId).toBe("b");
		expect(resolveTimelinePosition(sequence, 1_000)?.clipId).toBe("b");
	});
});

describe("locateSourceTime", () => {
	it("is the inverse of resolving, across clips, trims and speeds", () => {
		const sequence = computeSequence([
			clip("a", 10_000, { trimRegions: [trim(2_000, 5_000)] }),
			clip("b", 6_000, { speedRegions: [speed(0, 6_000, 2)] }),
		]);

		for (const timelineMs of [0, 1_000, 1_999, 2_000, 5_000, 6_999, 7_000, 8_500, 9_999]) {
			const position = resolveTimelinePosition(sequence, timelineMs);
			expect(position).not.toBeNull();
			if (!position) continue;
			expect(locateSourceTime(sequence, position.clipId, position.sourceMs)).toBeCloseTo(
				timelineMs,
				6,
			);
		}
	});

	it("refuses a moment that was cut out, rather than guessing a nearby one", () => {
		const sequence = computeSequence([clip("a", 10_000, { trimRegions: [trim(2_000, 5_000)] })]);

		expect(locateSourceTime(sequence, "a", 1_000)).toBe(1_000);
		expect(locateSourceTime(sequence, "a", 3_000)).toBeNull();
		expect(locateSourceTime(sequence, "a", 5_000)).toBe(2_000);
	});

	it("offsets by everything that plays before the clip", () => {
		const sequence = computeSequence([clip("a", 4_000), clip("b", 6_000)]);
		expect(locateSourceTime(sequence, "b", 1_500)).toBe(5_500);
	});

	it("places the closing instant of a clip at its end on the timeline", () => {
		const sequence = computeSequence([clip("a", 4_000), clip("b", 6_000)]);
		expect(locateSourceTime(sequence, "a", 4_000)).toBe(4_000);
	});

	it("knows nothing about a clip that is not in the sequence", () => {
		const sequence = computeSequence([clip("a", 4_000)]);
		expect(locateSourceTime(sequence, "ghost", 1_000)).toBeNull();
	});
});

describe("clipAt", () => {
	it("names the clip playing at a moment", () => {
		const sequence = computeSequence([clip("a", 4_000), clip("b", 6_000)]);

		expect(clipAt(sequence, 1_000)?.id).toBe("a");
		expect(clipAt(sequence, 7_000)?.id).toBe("b");
		expect(clipAt(computeSequence([]), 0)).toBeNull();
	});
});
