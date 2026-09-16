import { describe, expect, it } from "vitest";
import {
	DEFAULT_SILENCE_MIN_PAUSE_MS,
	DEFAULT_SILENCE_PADDING_MS,
	DEFAULT_SILENCE_SENSITIVITY,
	findSilenceCuts,
	type SilenceTrimSettings,
	silenceThreshold,
	speechLevel,
} from "./silenceTrim";

/**
 * Deciding what to cut out of a recording.
 *
 * The detection underneath is tested with the audio profile it belongs to. What
 * is tested here is the judgement on top: a threshold that fits the recording
 * rather than a fixed number, air left around the speech, and the refusals — the
 * cases where the honest answer is that there is nothing to cut.
 */

const SETTINGS: SilenceTrimSettings = {
	sensitivity: DEFAULT_SILENCE_SENSITIVITY,
	minPauseMs: DEFAULT_SILENCE_MIN_PAUSE_MS,
	paddingMs: DEFAULT_SILENCE_PADDING_MS,
};

/** 200 blocks per second, which is what the waveform worker produces. */
const BLOCKS_PER_SECOND = 200;

/**
 * Peaks for a take described as alternating stretches of loudness.
 *
 * Each stretch is `[milliseconds, amplitude]`; the result is the paired
 * [min, max] array the waveform hands around.
 */
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

const SPEECH = 0.6;
const ROOM_TONE = 0.004;

describe("speechLevel", () => {
	it("reads the speech, not the loudest moment", () => {
		// One clipped plosive in an otherwise ordinary take. Taking the maximum
		// would set the level at 1.0 and push the threshold up over the speech.
		const { peaks } = take([
			[5_000, SPEECH],
			[20, 1],
			[5_000, SPEECH],
		]);

		expect(speechLevel(peaks)).toBeCloseTo(SPEECH, 2);
	});

	it("reports a quiet take as quiet rather than normalising it up", () => {
		const loud = take([[4_000, SPEECH]]);
		const quiet = take([[4_000, 0.05]]);

		expect(speechLevel(quiet.peaks)).toBeLessThan(speechLevel(loud.peaks) / 5);
	});
});

describe("silenceThreshold", () => {
	it("sits between the room tone and the speech of the same take", () => {
		const { peaks } = take([
			[3_000, SPEECH],
			[3_000, ROOM_TONE],
		]);

		const threshold = silenceThreshold(peaks, DEFAULT_SILENCE_SENSITIVITY);
		expect(threshold).toBeGreaterThan(ROOM_TONE);
		expect(threshold).toBeLessThan(SPEECH);
	});

	it("follows a take recorded at low gain all the way down", () => {
		// Speech at 0.015 is below every fixed threshold that works for an ordinary
		// take — 0.02 would call this whole recording silent.
		const quiet = take([
			[3_000, 0.015],
			[3_000, 0.0005],
		]);

		const threshold = silenceThreshold(quiet.peaks, DEFAULT_SILENCE_SENSITIVITY);
		expect(threshold, "the threshold sits on top of the speech").toBeLessThan(0.015);
		expect(threshold, "the threshold is under the room tone").toBeGreaterThan(0.0005);
	});

	it("moves with the sensitivity", () => {
		const { peaks } = take([[3_000, SPEECH]]);

		expect(silenceThreshold(peaks, 100)).toBeGreaterThan(silenceThreshold(peaks, 0));
	});
});

describe("findSilenceCuts", () => {
	it("cuts a pause in the middle, leaving air on both sides of it", () => {
		const { peaks, durationMs } = take([
			[2_000, SPEECH],
			[2_000, ROOM_TONE],
			[2_000, SPEECH],
		]);

		const scan = findSilenceCuts(peaks, durationMs, SETTINGS);
		expect(scan.ok).toBe(true);
		if (!scan.ok) return;

		expect(scan.cuts).toHaveLength(1);
		expect(scan.cuts[0].startMs).toBeCloseTo(2_000 + DEFAULT_SILENCE_PADDING_MS, -2);
		expect(scan.cuts[0].endMs).toBeCloseTo(4_000 - DEFAULT_SILENCE_PADDING_MS, -2);
	});

	it("takes the silence at the very start out to the edge", () => {
		// No speech before the start of the file, so nothing there needs protecting
		// — and a padded slice of silence left at the head is the dead air the
		// button was pressed to remove.
		const { peaks, durationMs } = take([
			[1_500, ROOM_TONE],
			[3_000, SPEECH],
		]);

		const scan = findSilenceCuts(peaks, durationMs, SETTINGS);
		expect(scan.ok).toBe(true);
		if (!scan.ok) return;

		expect(scan.cuts[0].startMs).toBe(0);
		expect(scan.cuts[0].endMs).toBeCloseTo(1_500 - DEFAULT_SILENCE_PADDING_MS, -2);
	});

	it("takes the silence at the very end out to the edge", () => {
		const { peaks, durationMs } = take([
			[3_000, SPEECH],
			[1_500, ROOM_TONE],
		]);

		const scan = findSilenceCuts(peaks, durationMs, SETTINGS);
		expect(scan.ok).toBe(true);
		if (!scan.ok) return;

		expect(scan.cuts[0].endMs).toBeCloseTo(durationMs, -2);
	});

	it("leaves a pause shorter than the minimum alone", () => {
		const { peaks, durationMs } = take([
			[2_000, SPEECH],
			[300, ROOM_TONE],
			[2_000, SPEECH],
		]);

		expect(findSilenceCuts(peaks, durationMs, SETTINGS)).toEqual({
			ok: false,
			reason: "nothing-found",
		});
	});

	it("is not fooled into splitting a pause by a keystroke inside it", () => {
		// A click in the middle of dead air leaves two stretches that each fall
		// under the minimum — and a pause that would otherwise go uncut.
		const { peaks, durationMs } = take([
			[2_000, SPEECH],
			[500, ROOM_TONE],
			[30, SPEECH],
			[500, ROOM_TONE],
			[2_000, SPEECH],
		]);

		const scan = findSilenceCuts(peaks, durationMs, SETTINGS);
		expect(scan.ok, "the burst split the pause into two shorter ones").toBe(true);
		if (!scan.ok) return;
		expect(scan.cuts).toHaveLength(1);
		expect(scan.cuts[0].endMs - scan.cuts[0].startMs).toBeGreaterThan(400);
	});

	it("ends a pause on a real word", () => {
		// The other side of bridging: speech between two pauses must keep them apart,
		// or the word itself would be cut out with them.
		const { peaks, durationMs } = take([
			[1_000, SPEECH],
			[900, ROOM_TONE],
			[400, SPEECH],
			[900, ROOM_TONE],
			[1_000, SPEECH],
		]);

		const scan = findSilenceCuts(peaks, durationMs, SETTINGS);
		expect(scan.ok).toBe(true);
		if (!scan.ok) return;
		expect(scan.cuts).toHaveLength(2);
	});

	it("cuts a quietly recorded take rather than calling all of it silence", () => {
		// The same take as the threshold test, seen through the whole decision: with
		// a fixed threshold every block here reads as quiet and the answer would be
		// "the recording is empty" instead of one cut in the middle.
		const { peaks, durationMs } = take([
			[2_000, 0.015],
			[2_000, 0.0005],
			[2_000, 0.015],
		]);

		const scan = findSilenceCuts(peaks, durationMs, SETTINGS);
		expect(scan.ok, "a quiet take was read as silence throughout").toBe(true);
		if (!scan.ok) return;
		expect(scan.cuts).toHaveLength(1);
	});

	it("refuses a recording with no audio at all", () => {
		expect(findSilenceCuts(null, 5_000, SETTINGS)).toEqual({ ok: false, reason: "no-audio" });
	});

	it("refuses to cut away the whole recording", () => {
		// A silent take reads as one long pause. Obeying it would empty the project.
		const { peaks, durationMs } = take([[6_000, 0]]);

		expect(findSilenceCuts(peaks, durationMs, SETTINGS)).toEqual({
			ok: false,
			reason: "all-quiet",
		});
	});

	it("keeps away from cuts the user already made", () => {
		const { peaks, durationMs } = take([
			[2_000, SPEECH],
			[2_000, ROOM_TONE],
			[2_000, SPEECH],
		]);

		const scan = findSilenceCuts(peaks, durationMs, SETTINGS, [
			{ id: "trim-1", startMs: 2_500, endMs: 3_000 },
		]);

		expect(scan).toEqual({ ok: false, reason: "nothing-found" });
	});

	it("finds more of the take at a higher sensitivity", () => {
		// Room tone loud enough that the default setting reads it as speech.
		const { peaks, durationMs } = take([
			[2_000, SPEECH],
			[2_000, 0.09],
			[2_000, SPEECH],
		]);

		const shy = findSilenceCuts(peaks, durationMs, { ...SETTINGS, sensitivity: 0 });
		const keen = findSilenceCuts(peaks, durationMs, { ...SETTINGS, sensitivity: 100 });

		expect(shy.ok).toBe(false);
		expect(keen.ok).toBe(true);
	});
});
