import { describe, expect, it } from "vitest";
import { computeSequence } from "./sequence";
import { clipStart, nextPlayableClip, stepCard, stepRecording } from "./sequencePlayback";

// intro card 1 s → recording a (4 s, 1–2 s trimmed) → recording b (2 s, 2× speed) → outro card 1 s
const sequence = computeSequence([
	{ id: "intro", sourceDurationMs: 1_000 },
	{
		id: "a",
		sourceDurationMs: 4_000,
		trimRegions: [{ id: "t1", startMs: 1_000, endMs: 2_000 }],
	},
	{
		id: "b",
		sourceDurationMs: 2_000,
		speedRegions: [{ id: "s1", startMs: 0, endMs: 2_000, speed: 2 }],
	},
	{ id: "outro", sourceDurationMs: 1_000 },
]);

describe("stepRecording", () => {
	it("maps a position inside a surviving segment onto the timeline", () => {
		expect(stepRecording(sequence, "a", 500)).toEqual({ kind: "continue", timelineMs: 1_500 });
		// After the trim the clip has lost a second.
		expect(stepRecording(sequence, "a", 2_500)).toEqual({ kind: "continue", timelineMs: 2_500 });
	});

	it("holds the playhead at the next segment while the video skips a trim", () => {
		expect(stepRecording(sequence, "a", 1_400)).toEqual({ kind: "continue", timelineMs: 2_000 });
	});

	it("follows speed: a 2× recording covers its source twice as fast", () => {
		expect(stepRecording(sequence, "b", 1_000)).toEqual({ kind: "continue", timelineMs: 4_500 });
	});

	it("enters the next clip once the recording reaches the end of what survives", () => {
		expect(stepRecording(sequence, "a", 4_000)).toEqual({
			kind: "enter",
			clipId: "b",
			timelineMs: 4_000,
			sourceMs: 0,
		});
	});

	it("treats a video that stopped by itself as the end of its clip", () => {
		expect(stepRecording(sequence, "a", 3_990, true)).toMatchObject({ kind: "enter", clipId: "b" });
	});

	it("leaves at a trailing trim instead of waiting for the file to end", () => {
		const trailing = computeSequence([
			{
				id: "a",
				sourceDurationMs: 4_000,
				trimRegions: [{ id: "t", startMs: 3_000, endMs: 4_000 }],
			},
			{ id: "card", sourceDurationMs: 1_000 },
		]);
		expect(stepRecording(trailing, "a", 3_010)).toEqual({
			kind: "enter",
			clipId: "card",
			timelineMs: 3_000,
			sourceMs: 0,
		});
	});

	it("starts the next clip at its first surviving moment, not at zero", () => {
		const leadingTrim = computeSequence([
			{ id: "a", sourceDurationMs: 1_000 },
			{
				id: "b",
				sourceDurationMs: 3_000,
				trimRegions: [{ id: "t", startMs: 0, endMs: 500 }],
			},
		]);
		expect(stepRecording(leadingTrim, "a", 1_000)).toEqual({
			kind: "enter",
			clipId: "b",
			timelineMs: 1_000,
			sourceMs: 500,
		});
	});

	it("skips a clip trimmed away to nothing", () => {
		const emptied = computeSequence([
			{ id: "a", sourceDurationMs: 1_000 },
			{
				id: "gone",
				sourceDurationMs: 2_000,
				trimRegions: [{ id: "t", startMs: 0, endMs: 2_000 }],
			},
			{ id: "c", sourceDurationMs: 1_000 },
		]);
		expect(stepRecording(emptied, "a", 1_000)).toMatchObject({ kind: "enter", clipId: "c" });
	});

	it("ends after the last clip", () => {
		const single = computeSequence([{ id: "a", sourceDurationMs: 2_000 }]);
		expect(stepRecording(single, "a", 2_000)).toEqual({ kind: "end", timelineMs: 2_000 });
	});
});

describe("stepCard", () => {
	it("counts time inside the card", () => {
		expect(stepCard(sequence, "intro", 600)).toEqual({ kind: "continue", timelineMs: 600 });
	});

	it("hands over to the recording after it when the card is done", () => {
		expect(stepCard(sequence, "intro", 1_016)).toEqual({
			kind: "enter",
			clipId: "a",
			timelineMs: 1_000,
			sourceMs: 0,
		});
	});

	it("ends at the outro's end", () => {
		expect(stepCard(sequence, "outro", 6_000)).toEqual({ kind: "end", timelineMs: 6_000 });
	});
});

describe("nextPlayableClip / clipStart", () => {
	it("finds what follows and where it starts", () => {
		const next = nextPlayableClip(sequence, "b");
		expect(next?.id).toBe("outro");
		expect(next && clipStart(next)).toEqual({ timelineMs: 5_000, sourceMs: 0 });
		expect(nextPlayableClip(sequence, "outro")).toBeNull();
		expect(nextPlayableClip(sequence, "missing")).toBeNull();
	});
});
