import { describe, expect, it } from "vitest";
import { cardFrameCount, layoutCardTitle } from "./cardFrame";

/** Every glyph half an em wide — crude, but exactly predictable. */
const measure = (text: string, fontSize: number) => text.length * fontSize * 0.5;

const frame = { width: 1920, height: 1080 };

describe("layoutCardTitle", () => {
	it("draws a short title on one line, at the largest size", () => {
		const layout = layoutCardTitle("Hello", frame, measure);

		expect(layout.lines).toEqual(["Hello"]);
		// 12% of the frame height is the ceiling.
		expect(layout.fontSize).toBe(Math.round(1080 * 0.12));
	});

	it("wraps on words rather than cutting them", () => {
		const layout = layoutCardTitle("Recording your first demo with OpenScreen", frame, measure);

		expect(layout.lines.length).toBeGreaterThan(1);
		for (const line of layout.lines) {
			expect(measure(line, layout.fontSize)).toBeLessThanOrEqual(frame.width * 0.8);
		}
		// Nothing was lost or duplicated on the way.
		expect(layout.lines.join(" ")).toBe("Recording your first demo with OpenScreen");
	});

	it("shrinks the text rather than overflowing the frame", () => {
		const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
		const layout = layoutCardTitle(long, frame, measure);

		expect(layout.fontSize).toBeLessThan(Math.round(1080 * 0.12));
		expect(layout.lines.length * layout.lineHeight).toBeLessThanOrEqual(frame.height * 0.6);
	});

	it("never shrinks past the floor, even for an absurd title", () => {
		const absurd = Array.from({ length: 4_000 }, (_, i) => `w${i}`).join(" ");
		const layout = layoutCardTitle(absurd, frame, measure);

		expect(layout.fontSize).toBeGreaterThanOrEqual(Math.round(1080 * 0.04));
	});

	it("still lays out a single word too long to fit, rather than giving up", () => {
		// No wrapping can save this one; clipping one word beats drawing nothing.
		const layout = layoutCardTitle("A".repeat(500), frame, measure);
		expect(layout.lines).toHaveLength(1);
		expect(layout.fontSize).toBeGreaterThan(0);
	});

	it("has nothing to draw for an empty or blank title", () => {
		expect(layoutCardTitle("", frame, measure).lines).toEqual([]);
		expect(layoutCardTitle("   \n\t ", frame, measure).lines).toEqual([]);
	});

	it("collapses the whitespace a user pasted in", () => {
		expect(layoutCardTitle("  Hello   there  ", frame, measure).lines).toEqual(["Hello there"]);
	});

	it("scales with the frame, so a card looks the same at any resolution", () => {
		const big = layoutCardTitle("Hello", { width: 1920, height: 1080 }, measure);
		const small = layoutCardTitle("Hello", { width: 960, height: 540 }, measure);

		expect(big.fontSize / small.fontSize).toBeCloseTo(2, 1);
	});
});

describe("cardFrameCount", () => {
	it("turns a length into frames at the export rate", () => {
		expect(cardFrameCount(3_000, 30)).toBe(90);
		expect(cardFrameCount(1_000, 60)).toBe(60);
	});

	it("never renders a card as nothing at all", () => {
		// 10ms at 30fps rounds to zero frames, which would drop the card silently.
		expect(cardFrameCount(10, 30)).toBe(1);
	});

	it("has nothing to render for a card with no length", () => {
		expect(cardFrameCount(0, 30)).toBe(0);
		expect(cardFrameCount(3_000, 0)).toBe(0);
	});
});
