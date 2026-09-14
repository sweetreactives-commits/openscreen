import { describe, expect, it } from "vitest";
import {
	applyTrimsToSamples,
	assembleAudioTimeline,
	type PlanarAudio,
	planAudioChunks,
} from "./audioTimeline";

const RATE = 48_000;

/** One channel whose every sample says which frame it is, so moves are visible. */
function ramp(frames: number, offset = 0): PlanarAudio {
	const data = new Float32Array(frames);
	for (let i = 0; i < frames; i++) data[i] = offset + i;
	return [data];
}

const tone = (frames: number, value: number): PlanarAudio => [new Float32Array(frames).fill(value)];

describe("applyTrimsToSamples", () => {
	it("hands back everything when nothing is trimmed", () => {
		const samples = ramp(RATE);
		const kept = applyTrimsToSamples(samples, RATE, 1_000);

		expect(kept[0].length).toBe(RATE);
		expect(Array.from(kept[0].subarray(0, 3))).toEqual([0, 1, 2]);
	});

	it("cuts the trimmed span out and closes the gap", () => {
		// One second, with the middle 200ms cut.
		const kept = applyTrimsToSamples(ramp(RATE), RATE, 1_000, [
			{ id: "trim-1", startMs: 400, endMs: 600 },
		]);

		expect(kept[0].length).toBe(RATE - msFrames(200));
		// The sample right after the cut follows the one right before it.
		expect(kept[0][msFrames(400) - 1]).toBe(msFrames(400) - 1);
		expect(kept[0][msFrames(400)]).toBe(msFrames(600));
	});

	it("keeps every channel in step", () => {
		const left = new Float32Array(RATE).fill(1);
		const right = new Float32Array(RATE).fill(2);
		const kept = applyTrimsToSamples([left, right], RATE, 1_000, [
			{ id: "trim-1", startMs: 0, endMs: 500 },
		]);

		expect(kept[0].length).toBe(kept[1].length);
		expect(kept[0][0]).toBe(1);
		expect(kept[1][0]).toBe(2);
	});

	it("refuses to change speed rather than shifting the pitch", () => {
		expect(() =>
			applyTrimsToSamples(ramp(RATE), RATE, 1_000, undefined, [
				{ id: "speed-1", startMs: 0, endMs: 1_000, speed: 2 },
			]),
		).toThrow(/render the clip's audio first/);
	});

	it("has nothing to hand back when the whole clip is trimmed away", () => {
		const kept = applyTrimsToSamples(ramp(RATE), RATE, 1_000, [
			{ id: "trim-1", startMs: 0, endMs: 1_000 },
		]);
		expect(kept[0].length).toBe(0);
	});

	it("survives a trim that runs past the end of the samples", () => {
		const kept = applyTrimsToSamples(ramp(RATE), RATE, 1_000, [
			{ id: "trim-1", startMs: 900, endMs: 99_000 },
		]);
		expect(kept[0].length).toBe(msFrames(900));
	});
});

describe("assembleAudioTimeline", () => {
	it("places each clip at its own offset", () => {
		const track = assembleAudioTimeline(
			[
				{ outStartMs: 0, samples: tone(msFrames(500), 0.5) },
				{ outStartMs: 1_000, samples: tone(msFrames(500), 0.8) },
			],
			RATE,
			1,
		);

		expect(track[0][0]).toBe(0.5);
		expect(track[0][msFrames(1_000)]).toBeCloseTo(0.8, 5);
	});

	it("leaves silence where nothing plays — under a card, or in a gap", () => {
		const track = assembleAudioTimeline(
			[{ outStartMs: 1_000, samples: tone(msFrames(500), 0.9) }],
			RATE,
			1,
		);

		// The whole first second is the title card.
		for (let i = 0; i < msFrames(1_000); i++) expect(track[0][i]).toBe(0);
		expect(track[0][msFrames(1_000)]).toBeCloseTo(0.9, 5);
	});

	it("runs exactly as long as the last clip needs", () => {
		const track = assembleAudioTimeline(
			[
				{ outStartMs: 0, samples: tone(msFrames(500), 0.5) },
				{ outStartMs: 2_000, samples: tone(msFrames(250), 0.5) },
			],
			RATE,
			1,
		);

		expect(track[0].length).toBe(msFrames(2_250));
	});

	it("feeds a mono clip to both output channels rather than half-silence", () => {
		const track = assembleAudioTimeline(
			[{ outStartMs: 0, samples: tone(msFrames(100), 0.7) }],
			RATE,
			2,
		);

		expect(track).toHaveLength(2);
		expect(track[0][0]).toBeCloseTo(0.7, 5);
		expect(track[1][0]).toBeCloseTo(0.7, 5);
	});

	it("has nothing to assemble from nothing", () => {
		expect(assembleAudioTimeline([], RATE, 1)[0].length).toBe(0);
		expect(assembleAudioTimeline([], RATE, 0)).toEqual([]);
	});

	it("does not let a clip write past the end of the track", () => {
		// A clip whose samples outlast the buffer must be clipped, not throw.
		const track = assembleAudioTimeline(
			[{ outStartMs: 0, samples: tone(msFrames(100), 1) }],
			RATE,
			1,
		);
		expect(track[0].length).toBe(msFrames(100));
	});
});

describe("planAudioChunks", () => {
	it("covers the whole track in encoder-sized pieces", () => {
		const chunks = planAudioChunks(msFrames(3_000), RATE);
		expect(chunks.reduce((sum, chunk) => sum + chunk.frames, 0)).toBe(msFrames(3_000));
		expect(Math.max(...chunks.map((chunk) => chunk.frames))).toBeLessThanOrEqual(1024);
	});

	it("timestamps the pieces end to end from zero", () => {
		const chunks = planAudioChunks(4_000, RATE, 1_000);
		expect(chunks.map((chunk) => chunk.timestampUs)).toEqual([
			0,
			Math.round((1_000 / RATE) * 1_000_000),
			Math.round((2_000 / RATE) * 1_000_000),
			Math.round((3_000 / RATE) * 1_000_000),
		]);
	});

	it("has nothing to plan for an empty track", () => {
		expect(planAudioChunks(0, RATE)).toEqual([]);
		expect(planAudioChunks(1_000, 0)).toEqual([]);
	});
});

function msFrames(ms: number): number {
	return Math.round((ms / 1000) * RATE);
}
