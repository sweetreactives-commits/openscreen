import { describe, expect, it } from "vitest";
import { DEFAULT_SILENCE_SENSITIVITY } from "./silenceTrim";
import {
	DEFAULT_TIMELAPSE_MIN_MS,
	DEFAULT_TIMELAPSE_SPEED,
	findBoringStretches,
	type TimelapseSettings,
} from "./timelapse";

/**
 * Telling a boring stretch from a merely quiet one.
 *
 * The audio analysis underneath is tested with the silence cuts that share it.
 * What matters here is the judgement on top: how long is long enough, what a
 * click in the middle means, and keeping out of the way of decisions the user
 * has already made.
 */

const SETTINGS: TimelapseSettings = {
	sensitivity: DEFAULT_SILENCE_SENSITIVITY,
	speed: DEFAULT_TIMELAPSE_SPEED,
	minBoringMs: DEFAULT_TIMELAPSE_MIN_MS,
};

/** 200 blocks per second, which is what the waveform worker produces. */
const BLOCKS_PER_SECOND = 200;
const SPEECH = 0.6;
const ROOM_TONE = 0.004;

function take(stretches: Array<[number, number]>): { peaks: Float32Array; durationMs: number } {
	const blocks: number[] = [];
	for (const [ms, amplitude] of stretches) {
		const count = Math.round((ms / 1000) * BLOCKS_PER_SECOND);
		for (let i = 0; i < count; i++) blocks.push(amplitude);
	}
	const peaks = new Float32Array(blocks.length * 2);
	for (let i = 0; i < blocks.length; i++) {
		peaks[i * 2] = -blocks[i];
		peaks[i * 2 + 1] = blocks[i];
	}
	return { peaks, durationMs: (blocks.length / BLOCKS_PER_SECOND) * 1000 };
}

/** Two seconds of talking, a long wait, two more seconds of talking. */
function takeWithAWait(waitMs: number) {
	return take([
		[2_000, SPEECH],
		[waitMs, ROOM_TONE],
		[2_000, SPEECH],
	]);
}

describe("findBoringStretches", () => {
	it("speeds up a long wait, leaving the speech either side at its own pace", () => {
		const { peaks, durationMs } = takeWithAWait(10_000);

		const scan = findBoringStretches(peaks, durationMs, [], SETTINGS);
		expect(scan.ok).toBe(true);
		if (!scan.ok) return;

		expect(scan.stretches).toHaveLength(1);
		// Inside the wait, held off the speech on both sides.
		expect(scan.stretches[0].startMs).toBeGreaterThan(2_000);
		expect(scan.stretches[0].startMs).toBeLessThan(2_500);
		expect(scan.stretches[0].endMs).toBeGreaterThan(11_500);
		expect(scan.stretches[0].endMs).toBeLessThan(12_000);
	});

	it("leaves a pause between sentences alone", () => {
		// Long enough that the silence cuts would take it, far short of boring.
		const { peaks, durationMs } = takeWithAWait(1_200);

		expect(findBoringStretches(peaks, durationMs, [], SETTINGS)).toEqual({
			ok: false,
			reason: "nothing-found",
		});
	});

	it("splits a wait at a click rather than giving up on it", () => {
		// Something happened nine seconds in. The other nineteen seconds did not
		// stop being boring for it.
		const { peaks, durationMs } = takeWithAWait(20_000);

		const scan = findBoringStretches(peaks, durationMs, [11_000], SETTINGS);
		expect(scan.ok).toBe(true);
		if (!scan.ok) return;

		expect(scan.stretches).toHaveLength(2);
		expect(scan.stretches[0].endMs).toBeLessThanOrEqual(11_000);
		expect(scan.stretches[1].startMs).toBeGreaterThanOrEqual(11_000);
	});

	it("drops what a click leaves too short to bother with", () => {
		const { peaks, durationMs } = takeWithAWait(10_000);

		// A click near the end: the long piece before it survives, the stub after
		// it does not.
		const scan = findBoringStretches(peaks, durationMs, [11_400], SETTINGS);
		expect(scan.ok).toBe(true);
		if (!scan.ok) return;
		expect(scan.stretches).toHaveLength(1);
	});

	it("says nothing rather than nothing useful when there is no audio", () => {
		expect(findBoringStretches(null, 10_000, [], SETTINGS)).toEqual({
			ok: false,
			reason: "no-audio",
		});
	});

	it("keeps away from a stretch the user has already cut", () => {
		const { peaks, durationMs } = takeWithAWait(10_000);

		const scan = findBoringStretches(peaks, durationMs, [], SETTINGS, [
			{ id: "trim-1", startMs: 5_000, endMs: 6_000 },
		]);

		expect(scan).toEqual({ ok: false, reason: "nothing-found" });
	});

	it("keeps away from a speed the user has already set", () => {
		const { peaks, durationMs } = takeWithAWait(10_000);

		const scan = findBoringStretches(
			peaks,
			durationMs,
			[],
			SETTINGS,
			[],
			[{ id: "speed-1", startMs: 5_000, endMs: 6_000, speed: 2 }],
		);

		expect(scan).toEqual({ ok: false, reason: "nothing-found" });
	});

	it("follows the minimum it is given", () => {
		const { peaks, durationMs } = takeWithAWait(3_000);

		expect(findBoringStretches(peaks, durationMs, [], SETTINGS).ok).toBe(false);
		expect(findBoringStretches(peaks, durationMs, [], { ...SETTINGS, minBoringMs: 2_000 }).ok).toBe(
			true,
		);
	});
});
