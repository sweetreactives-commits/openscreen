import { describe, expect, it } from "vitest";
import {
	CLICK_RIPPLE_DURATION_MS,
	clickEffectColorToNumber,
	getClickRippleVisual,
	normalizeClickEffectStyle,
	parseHexColor,
} from "./clickRipple";
import { getNativeCursorClickRippleProgress } from "./nativeCursor";

/** The leading layer, which is the whole effect for every style but `echo`. */
function head(visual: ReturnType<typeof getClickRippleVisual>) {
	if (!visual) throw new Error("expected a visual");
	return visual.layers[0];
}

describe("click ripple visual", () => {
	it("returns null when there is no active click or the effect is disabled", () => {
		expect(getClickRippleVisual(0, 1)).toBeNull();
		expect(getClickRippleVisual(-0.2, 1)).toBeNull();
		expect(getClickRippleVisual(0.5, 0)).toBeNull();
	});

	it("expands the ring while fading it out", () => {
		const fresh = head(getClickRippleVisual(1, 1));
		const mid = head(getClickRippleVisual(0.5, 1));
		const late = head(getClickRippleVisual(0.1, 1));

		expect(fresh.radius).toBeLessThan(mid.radius);
		expect(mid.radius).toBeLessThan(late.radius);
		expect(fresh.alpha).toBeGreaterThan(mid.alpha);
		expect(mid.alpha).toBeGreaterThan(late.alpha);
		expect(late.alpha).toBeGreaterThan(0);
	});

	/**
	 * The dial used to buy opacity alone, which read as a dial that did nothing:
	 * every ripple came out the same size, however low it went.
	 */
	it("makes a weaker ripple smaller as well as fainter", () => {
		const full = getClickRippleVisual(0.5, 1);
		const half = getClickRippleVisual(0.5, 0.5);
		const faint = getClickRippleVisual(0.5, 0.1);

		expect(head(half).radius).toBeLessThan(head(full).radius);
		expect(head(faint).radius).toBeLessThan(head(half).radius);
		expect(head(half).alpha).toBeLessThan(head(full).alpha);
		expect(head(half).strokeWidth).toBeLessThan(head(full).strokeWidth);
	});

	it("keeps the faintest setting visible rather than invisible", () => {
		const faint = getClickRippleVisual(0.5, 0.05);

		expect(head(faint).alpha).toBeGreaterThan(0.1);
		expect(head(faint).radius).toBeGreaterThan(0);
	});

	/**
	 * The dark pass under the ring is there to keep the colour readable on bright
	 * content. When it outweighs the colour, a yellow ripple reads as a grey one.
	 */
	it("keeps the contrast pass weaker than the colour it backs", () => {
		for (const style of ["ring", "pulse", "echo"] as const) {
			const visual = getClickRippleVisual(0.7, 1, style);
			if (!visual) throw new Error("expected a visual");
			expect(visual.shadowAlpha).toBeLessThan(visual.layers[0].alpha);
		}
	});

	/**
	 * The disc covers what was clicked, so it has to stay out of the way: fainter
	 * than the ring and not reaching as far.
	 */
	it("keeps the pulse fainter and tighter than the ring", () => {
		const ring = head(getClickRippleVisual(0.5, 1, "ring"));
		const pulse = head(getClickRippleVisual(0.5, 1, "pulse"));

		expect(pulse.strokeWidth).toBe(0);
		expect(pulse.alpha).toBeLessThan(ring.alpha);
		expect(pulse.radius).toBeLessThan(ring.radius);
	});

	it("stacks echo rings behind the leading one", () => {
		const echo = getClickRippleVisual(1, 1, "echo");
		if (!echo) throw new Error("expected a visual");

		expect(echo.layers.length).toBeGreaterThan(1);
		// Later rings started earlier, so they are further out and weaker.
		for (let i = 1; i < echo.layers.length; i++) {
			expect(echo.layers[i].radius).toBeGreaterThan(echo.layers[i - 1].radius);
			expect(echo.layers[i].alpha).toBeLessThan(echo.layers[i - 1].alpha);
		}
	});

	it("every style ends with nothing left to draw", () => {
		for (const style of ["ring", "pulse", "echo"] as const) {
			const expired = getClickRippleVisual(0, 1, style);
			expect(expired).toBeNull();
		}
	});

	it("falls back to the default style rather than drawing nothing", () => {
		expect(normalizeClickEffectStyle("echo")).toBe("echo");
		expect(normalizeClickEffectStyle("sparkles")).toBe("ring");
		expect(normalizeClickEffectStyle(undefined)).toBe("ring");
	});
});

describe("click effect colour", () => {
	it("reads both hex forms", () => {
		expect(parseHexColor("#ff8800")).toEqual({ r: 255, g: 136, b: 0 });
		expect(parseHexColor("#f80")).toEqual({ r: 255, g: 136, b: 0 });
		expect(parseHexColor("ff8800")).toEqual({ r: 255, g: 136, b: 0 });
	});

	it("falls back to white on anything it cannot read", () => {
		expect(parseHexColor("rebeccapurple")).toBeNull();
		expect(parseHexColor(null)).toBeNull();
		expect(clickEffectColorToNumber("not a colour")).toBe(0xffffff);
		expect(clickEffectColorToNumber("#ff8800")).toBe(0xff8800);
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
		expect(
			getNativeCursorClickRippleProgress(recordingData, 100 + CLICK_RIPPLE_DURATION_MS + 1),
		).toBe(0);
	});

	it("returns 0 before the click and without recording data", () => {
		expect(getNativeCursorClickRippleProgress(recordingData, 50)).toBe(0);
		expect(getNativeCursorClickRippleProgress(null, 100)).toBe(0);
		expect(getNativeCursorClickRippleProgress({ ...recordingData, samples: [] }, 100)).toBe(0);
	});
});
