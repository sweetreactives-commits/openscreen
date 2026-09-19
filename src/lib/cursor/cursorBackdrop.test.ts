import { describe, expect, it } from "vitest";
import {
	getCursorBackdropVisual,
	MAX_CURSOR_BACKDROP_SIZE,
	MIN_CURSOR_BACKDROP_SIZE,
	normalizeCursorBackdropStyle,
} from "./cursorBackdrop";

/**
 * The backdrop is on screen for the whole recording rather than for 450ms, so
 * the judgements worth pinning down are the ones that decide whether it helps
 * or gets in the way: that it can be switched off outright, that a hard disc
 * does not reach as far as a glow, and that the opacity dial reaches zero.
 */

describe("cursor backdrop visual", () => {
	it("draws nothing when switched off", () => {
		expect(getCursorBackdropVisual("none", 1)).toBeNull();
	});

	it("draws nothing at zero opacity, whichever shape is chosen", () => {
		expect(getCursorBackdropVisual("circle", 0)).toBeNull();
		expect(getCursorBackdropVisual("glow", 0)).toBeNull();
		expect(getCursorBackdropVisual("circle", -1)).toBeNull();
	});

	it("keeps the hard disc tighter than the glow", () => {
		const circle = getCursorBackdropVisual("circle", 0.5);
		const glow = getCursorBackdropVisual("glow", 0.5);

		expect(circle?.soft).toBe(false);
		expect(glow?.soft).toBe(true);
		expect(circle?.radius).toBeLessThan(glow?.radius ?? 0);
	});

	it("passes the opacity through, clamped", () => {
		expect(getCursorBackdropVisual("circle", 0.4)?.alpha).toBeCloseTo(0.4);
		expect(getCursorBackdropVisual("circle", 3)?.alpha).toBe(1);
	});

	it("falls back to off rather than to a shape the user did not pick", () => {
		expect(normalizeCursorBackdropStyle("glow")).toBe("glow");
		expect(normalizeCursorBackdropStyle("halo")).toBe("none");
		expect(normalizeCursorBackdropStyle(undefined)).toBe("none");
	});
});

describe("cursor backdrop size", () => {
	it("scales the shape without changing which shape it is", () => {
		const small = getCursorBackdropVisual("circle", 0.5, 0.6);
		const large = getCursorBackdropVisual("circle", 0.5, 2);

		expect(small?.radius).toBeLessThan(large?.radius ?? 0);
		expect(small?.soft).toBe(false);
		expect(large?.soft).toBe(false);
	});

	it("holds the dial inside a range that stays useful", () => {
		const tiny = getCursorBackdropVisual("glow", 1, 0.01);
		const huge = getCursorBackdropVisual("glow", 1, 99);
		const atMin = getCursorBackdropVisual("glow", 1, MIN_CURSOR_BACKDROP_SIZE);
		const atMax = getCursorBackdropVisual("glow", 1, MAX_CURSOR_BACKDROP_SIZE);

		expect(tiny?.radius).toBeCloseTo(atMin?.radius ?? 0);
		expect(huge?.radius).toBeCloseTo(atMax?.radius ?? 0);
	});

	it("defaults to the size the shape was drawn at", () => {
		expect(getCursorBackdropVisual("circle", 0.5)?.radius).toBeCloseTo(
			getCursorBackdropVisual("circle", 0.5, 1)?.radius ?? 0,
		);
	});
});
