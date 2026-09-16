import { describe, expect, it } from "vitest";
import type { TrimRegion } from "@/components/video-editor/types";
import {
	combineOverlays,
	MAX_TRANSITION_MS,
	normalizeTransitionMs,
	normalizeTransitionStyle,
	outputMsUntilSeam,
	overlayAfterSeam,
	overlayBeforeSeam,
	seamBetween,
	seamsFromTrims,
	speedAt,
} from "./transitions";

const trim = (startMs: number, endMs: number): TrimRegion => ({
	id: `trim-${startMs}`,
	startMs,
	endMs,
});

describe("seamsFromTrims", () => {
	it("finds the cut a trim in the middle leaves", () => {
		expect(seamsFromTrims(10_000, [trim(3_000, 4_000)])).toEqual([{ outMs: 3_000, inMs: 4_000 }]);
	});

	it("leaves no seam where a trim only shortens an end", () => {
		expect(seamsFromTrims(10_000, [trim(0, 2_000)])).toEqual([]);
		expect(seamsFromTrims(10_000, [trim(8_000, 10_000)])).toEqual([]);
		expect(seamsFromTrims(10_000, [trim(0, 1_000), trim(9_000, 10_000)])).toEqual([]);
	});

	it("counts overlapping trims as the one cut they make", () => {
		expect(seamsFromTrims(10_000, [trim(2_000, 4_000), trim(3_000, 5_000)])).toEqual([
			{ outMs: 2_000, inMs: 5_000 },
		]);
	});

	it("reports every cut of several, in order", () => {
		expect(seamsFromTrims(10_000, [trim(6_000, 7_000), trim(2_000, 3_000)])).toEqual([
			{ outMs: 2_000, inMs: 3_000 },
			{ outMs: 6_000, inMs: 7_000 },
		]);
	});

	it("has nothing to smooth when nothing is cut", () => {
		expect(seamsFromTrims(10_000, [])).toEqual([]);
		expect(seamsFromTrims(10_000)).toEqual([]);
	});
});

describe("seamBetween", () => {
	const seams = seamsFromTrims(10_000, [trim(3_000, 4_000)]);

	it("spots the jump a cut makes", () => {
		expect(seamBetween(seams, 2_960, 4_000)).toEqual({ outMs: 3_000, inMs: 4_000 });
	});

	it("says nothing for ordinary neighbouring frames", () => {
		expect(seamBetween(seams, 1_000, 1_040)).toBeNull();
		expect(seamBetween(seams, 4_040, 4_080)).toBeNull();
	});

	it("says nothing when time goes backwards, as it does on a seek", () => {
		expect(seamBetween(seams, 5_000, 1_000)).toBeNull();
	});
});

describe("overlayAfterSeam", () => {
	it("holds the frame before the cut and fades it out", () => {
		expect(overlayAfterSeam("dissolve", 200, 0).frozenAlpha).toBe(1);
		expect(overlayAfterSeam("dissolve", 200, 100).frozenAlpha).toBeCloseTo(0.5);
		expect(overlayAfterSeam("dissolve", 200, 200)).toEqual({ frozenAlpha: 0, blackAlpha: 0 });
		expect(overlayAfterSeam("dissolve", 200, 5_000)).toEqual({ frozenAlpha: 0, blackAlpha: 0 });
	});

	it("comes back out of black over half a dip", () => {
		expect(overlayAfterSeam("dip", 200, 0).blackAlpha).toBe(1);
		expect(overlayAfterSeam("dip", 200, 50).blackAlpha).toBeCloseTo(0.5);
		expect(overlayAfterSeam("dip", 200, 100).blackAlpha).toBe(0);
	});

	it("draws nothing at all when transitions are off", () => {
		expect(overlayAfterSeam("none", 200, 10)).toEqual({ frozenAlpha: 0, blackAlpha: 0 });
	});
});

describe("overlayBeforeSeam", () => {
	it("darkens into the cut, but only for a dip", () => {
		expect(overlayBeforeSeam("dip", 200, 100).blackAlpha).toBe(0);
		expect(overlayBeforeSeam("dip", 200, 50).blackAlpha).toBeCloseTo(0.5);
		expect(overlayBeforeSeam("dip", 200, 0).blackAlpha).toBe(1);
		// A dissolve has no half before the cut: it holds the last frame instead.
		expect(overlayBeforeSeam("dissolve", 200, 10)).toEqual({ frozenAlpha: 0, blackAlpha: 0 });
		expect(overlayBeforeSeam("dip", 200, null)).toEqual({ frozenAlpha: 0, blackAlpha: 0 });
	});
});

describe("outputMsUntilSeam", () => {
	const seams = seamsFromTrims(10_000, [trim(3_000, 4_000)]);

	it("measures what the viewer has left, not what the recording has", () => {
		expect(outputMsUntilSeam(seams, 2_800)).toBe(200);
		// Twice as fast, so those 200 ms of recording are over in 100.
		expect(
			outputMsUntilSeam(seams, 2_800, [{ id: "speed-1", startMs: 0, endMs: 3_000, speed: 2 }]),
		).toBe(100);
	});

	it("answers null past the last cut", () => {
		expect(outputMsUntilSeam(seams, 5_000)).toBeNull();
	});
});

describe("speedAt", () => {
	it("falls back to normal speed outside any region and on nonsense", () => {
		const regions = [{ id: "s", startMs: 0, endMs: 1_000, speed: 0 }];
		expect(speedAt(regions, 500)).toBe(1);
		expect(speedAt(regions, 2_000)).toBe(1);
		expect(speedAt(undefined, 10)).toBe(1);
	});
});

describe("normalizing what is stored", () => {
	it("keeps a known style and falls back to off", () => {
		expect(normalizeTransitionStyle("dissolve")).toBe("dissolve");
		expect(normalizeTransitionStyle("wipe")).toBe("none");
		expect(normalizeTransitionStyle(undefined)).toBe("none");
	});

	it("clamps the length into what is watchable", () => {
		expect(normalizeTransitionMs(250)).toBe(250);
		expect(normalizeTransitionMs(5)).toBe(80);
		expect(normalizeTransitionMs(99_999)).toBe(MAX_TRANSITION_MS);
		expect(normalizeTransitionMs("soon")).toBe(250);
	});
});

describe("combineOverlays", () => {
	it("keeps whichever half is showing more", () => {
		expect(
			combineOverlays({ frozenAlpha: 0, blackAlpha: 0.8 }, { frozenAlpha: 0.2, blackAlpha: 0.1 }),
		).toEqual({ frozenAlpha: 0.2, blackAlpha: 0.8 });
	});
});
