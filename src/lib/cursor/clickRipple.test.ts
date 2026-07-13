import { describe, expect, it } from "vitest";
import { CLICK_RIPPLE_DURATION_MS, getClickRippleVisual } from "./clickRipple";
import { getNativeCursorClickRippleProgress } from "./nativeCursor";

describe("click ripple visual", () => {
	it("returns null when there is no active click or the effect is disabled", () => {
		expect(getClickRippleVisual(0, 1)).toBeNull();
		expect(getClickRippleVisual(-0.2, 1)).toBeNull();
		expect(getClickRippleVisual(0.5, 0)).toBeNull();
	});

	it("expands the ring while fading it out", () => {
		const fresh = getClickRippleVisual(1, 1)!;
		const mid = getClickRippleVisual(0.5, 1)!;
		const late = getClickRippleVisual(0.1, 1)!;

		expect(fresh.radius).toBeLessThan(mid.radius);
		expect(mid.radius).toBeLessThan(late.radius);
		expect(fresh.alpha).toBeGreaterThan(mid.alpha);
		expect(mid.alpha).toBeGreaterThan(late.alpha);
		expect(late.alpha).toBeGreaterThan(0);
	});

	it("scales opacity with the user intensity", () => {
		const full = getClickRippleVisual(0.5, 1)!;
		const half = getClickRippleVisual(0.5, 0.5)!;

		expect(half.alpha).toBeCloseTo(full.alpha * 0.5);
		expect(half.shadowAlpha).toBeCloseTo(full.shadowAlpha * 0.5);
		expect(half.radius).toBe(full.radius);
	});
});

describe("native cursor click ripple progress", () => {
	const recordingData = {
		version: 2,
		provider: "native" as const,
		assets: [],
		samples: [
			{ timeMs: 0, cx: 0.5, cy: 0.5, interactionType: "move" as const },
			{ timeMs: 100, cx: 0.5, cy: 0.5, interactionType: "click" as const },
			{ timeMs: 200, cx: 0.5, cy: 0.5, interactionType: "move" as const },
			{ timeMs: 700, cx: 0.5, cy: 0.5, interactionType: "move" as const },
		],
	};

	it("outlives the click bounce so the ring stays visible while it expands", () => {
		expect(getNativeCursorClickRippleProgress(recordingData, 100)).toBe(1);
		expect(getNativeCursorClickRippleProgress(recordingData, 400)).toBeGreaterThan(0);
		expect(getNativeCursorClickRippleProgress(recordingData, 100 + CLICK_RIPPLE_DURATION_MS + 1)).toBe(
			0,
		);
	});

	it("returns 0 before the click and without recording data", () => {
		expect(getNativeCursorClickRippleProgress(recordingData, 50)).toBe(0);
		expect(getNativeCursorClickRippleProgress(null, 100)).toBe(0);
		expect(getNativeCursorClickRippleProgress({ ...recordingData, samples: [] }, 100)).toBe(0);
	});
});
