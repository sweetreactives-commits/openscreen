import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "../types";
import {
	ABANDONED_DWELL_MS,
	DWELL_SATURATION_MS,
	findZoomSuggestions,
	MIN_DWELL_DURATION_MS,
	SUGGESTION_BUDGET_MS,
	SUGGESTION_GAP_MS,
} from "./zoomSuggestionUtils";

/**
 * Which moments of a recording are worth a zoom.
 *
 * The arithmetic of placing a span is dull and mostly self-evident. What is
 * worth pinning down is the judgement: that a click outranks a rest, that a
 * pointer left somewhere for a minute is not attention, and that a long rest is
 * not punished for being long.
 */

/** Cursor sampling runs at 30Hz in the recorder; the detector reads runs, not rates. */
const SAMPLE_INTERVAL_MS = 33;
const DEFAULT_DURATION_MS = 1_000;

/**
 * A take built from legs: "sit still here for this long", "jump over there".
 * Each leg is [cx, cy, durationMs] and is sampled at the recorder's rate.
 */
function take(legs: Array<[number, number, number]>): {
	telemetry: CursorTelemetryPoint[];
	totalMs: number;
} {
	const telemetry: CursorTelemetryPoint[] = [];
	let timeMs = 0;
	for (const [cx, cy, durationMs] of legs) {
		const end = timeMs + durationMs;
		while (timeMs <= end) {
			telemetry.push({ timeMs, cx, cy });
			timeMs += SAMPLE_INTERVAL_MS;
		}
	}
	return { telemetry, totalMs: timeMs };
}

function scan(
	legs: Array<[number, number, number]>,
	options: {
		clickTimesMs?: number[];
		existingRegions?: { startMs: number; endMs: number }[];
	} = {},
) {
	const { telemetry, totalMs } = take(legs);
	return findZoomSuggestions({
		cursorTelemetry: telemetry,
		clickTimesMs: options.clickTimesMs ?? [],
		totalMs,
		existingRegions: options.existingRegions ?? [],
		defaultDurationMs: DEFAULT_DURATION_MS,
	});
}

describe("findZoomSuggestions", () => {
	it("says so when the recording carries no cursor data at all", () => {
		const result = findZoomSuggestions({
			cursorTelemetry: [],
			totalMs: 10_000,
			existingRegions: [],
			defaultDurationMs: DEFAULT_DURATION_MS,
		});

		expect(result).toEqual({ ok: false, reason: "no-cursor-data" });
	});

	it("separates data too thin to read from data that is missing", () => {
		const result = findZoomSuggestions({
			cursorTelemetry: [{ timeMs: 0, cx: 0.5, cy: 0.5 }],
			totalMs: 10_000,
			existingRegions: [],
			defaultDurationMs: DEFAULT_DURATION_MS,
		});

		expect(result).toEqual({ ok: false, reason: "unusable-cursor-data" });
	});

	it("proposes nothing when the cursor never comes to rest", () => {
		// Every leg is shorter than the shortest rest that counts.
		const legs: Array<[number, number, number]> = [];
		for (let i = 0; i < 40; i++) {
			legs.push([i / 40, 0.5, MIN_DWELL_DURATION_MS / 3]);
		}

		expect(scan(legs)).toEqual({ ok: false, reason: "nothing-found" });
	});

	it("proposes a zoom where the cursor rests", () => {
		const result = scan([
			[0.2, 0.2, 200],
			[0.8, 0.7, 1_200],
			[0.1, 0.9, 200],
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0].kind).toBe("dwell");
		expect(result.suggestions[0].focus.cx).toBeCloseTo(0.8, 2);
		expect(result.suggestions[0].focus.cy).toBeCloseTo(0.7, 2);
	});

	it("does not mistake a parked pointer for attention", () => {
		const result = scan([
			[0.2, 0.2, 200],
			[0.8, 0.7, ABANDONED_DWELL_MS + 1_000],
			[0.1, 0.9, 200],
		]);

		expect(result).toEqual({ ok: false, reason: "nothing-found" });
	});

	it("keeps a rest that is merely long", () => {
		// Between the saturation point and the abandoned threshold: still a rest.
		const result = scan([
			[0.2, 0.2, 200],
			[0.8, 0.7, DWELL_SATURATION_MS * 2],
			[0.1, 0.9, 200],
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.suggestions).toHaveLength(1);
	});

	/**
	 * The old detector ranked by raw dwell duration, so the single longest pause
	 * in a recording dominated every other moment. Saturation is what stops that.
	 */
	it("proposes both long rests instead of letting the longer one crowd the other out", () => {
		// Enough recording between the two rests for both to fit the budget, filled
		// with movement too brief to be a candidate of its own.
		const drifting: Array<[number, number, number]> = Array.from(
			{ length: 180 },
			(_, i) => [i / 180, 0.5, 100] as [number, number, number],
		);
		const result = scan([
			[0.1, 0.1, DWELL_SATURATION_MS],
			...drifting,
			[0.9, 0.9, DWELL_SATURATION_MS * 3],
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Saturation makes the two rests worth the same, so neither crowds the other.
		expect(result.suggestions).toHaveLength(2);
	});

	it("proposes a zoom at a click, focused where the pointer was", () => {
		const result = scan(
			[
				[0.25, 0.75, 200],
				[0.6, 0.4, 300],
			],
			{ clickTimesMs: [400] },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const click = result.suggestions.find((suggestion) => suggestion.kind === "click");
		expect(click).toBeDefined();
		expect(click?.focus.cx).toBeCloseTo(0.6, 2);
		expect(click?.focus.cy).toBeCloseTo(0.4, 2);
	});

	it("lets a click win the moment it shares with a rest", () => {
		// The click lands inside a rest long enough to be a candidate on its own.
		const result = scan(
			[
				[0.2, 0.2, 200],
				[0.8, 0.7, 2_000],
			],
			{ clickTimesMs: [1_200] },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0].kind).toBe("click");
	});

	it("leaves the picture still between two suggestions", () => {
		// A minute of clicking, one every two seconds: dense enough that back-to-back
		// zooms were what the old centre-spacing rule produced.
		const clickTimesMs = Array.from({ length: 30 }, (_, i) => i * 2_000);
		const legs: Array<[number, number, number]> = [];
		for (let i = 0; i < 30; i++) {
			legs.push([i / 30, 0.5, 2_000]);
		}

		const result = scan(legs, { clickTimesMs });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const spans = [...result.suggestions].sort((a, b) => a.span.start - b.span.start);
		for (let i = 1; i < spans.length; i++) {
			expect(spans[i].span.start - spans[i - 1].span.end).toBeGreaterThanOrEqual(SUGGESTION_GAP_MS);
		}
	});

	/**
	 * A suggestion is something the user looks at and thins out. Proposing one
	 * every few seconds hands them a carpet to clear rather than a head start.
	 */
	it("proposes at most one zoom per stretch of recording", () => {
		const clickTimesMs = Array.from({ length: 30 }, (_, i) => i * 2_000);
		const legs: Array<[number, number, number]> = [];
		for (let i = 0; i < 30; i++) {
			legs.push([i / 30, 0.5, 2_000]);
		}

		const result = scan(legs, { clickTimesMs });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const totalMs = take(legs).totalMs;
		expect(result.suggestions.length).toBeLessThanOrEqual(
			Math.max(1, Math.floor(totalMs / SUGGESTION_BUDGET_MS)),
		);
	});

	it("stays out of the way of zooms already on the timeline", () => {
		const { telemetry, totalMs } = take([
			[0.2, 0.2, 200],
			[0.8, 0.7, 1_200],
			[0.1, 0.9, 200],
		]);

		const result = findZoomSuggestions({
			cursorTelemetry: telemetry,
			clickTimesMs: [],
			totalMs,
			existingRegions: [{ startMs: 0, endMs: totalMs }],
			defaultDurationMs: DEFAULT_DURATION_MS,
		});

		expect(result).toEqual({ ok: false, reason: "no-room" });
	});
});
