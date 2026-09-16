import { describe, expect, it } from "vitest";
import { ClipBoundaryTransition } from "./clipBoundaryTransition";

/**
 * When a join between clips is smoothed over, and by how much.
 *
 * Only the timing lives here — what gets drawn is the shared transition maths,
 * tested on its own, and the drawing itself needs a browser. What this pins down
 * is the bookkeeping the export loop drives: which frame counts as a join, how
 * far into the transition each frame is, and when there is nothing left to draw.
 */

/** 25 fps, so one frame lasts 40 ms and a 400 ms transition is ten frames. */
const options = { frameRate: 25, durationMs: 400, width: 16, height: 9 };

describe("ClipBoundaryTransition", () => {
	it("leaves every frame alone when no transition is asked for", () => {
		const boundary = new ClipBoundaryTransition({ ...options, style: "none" });
		boundary.beginClip(0, 10, true);
		boundary.beginClip(10, 10, false);

		expect(boundary.enabled).toBe(false);
		expect(boundary.overlayAt(10)).toEqual({ frozenAlpha: 0, blackAlpha: 0 });
	});

	it("does not treat the start of the video as a join", () => {
		const boundary = new ClipBoundaryTransition({ ...options, style: "dissolve" });
		boundary.beginClip(0, 10, true);

		expect(boundary.overlayAt(0)).toEqual({ frozenAlpha: 0, blackAlpha: 0 });
		expect(boundary.overlayAt(1)).toEqual({ frozenAlpha: 0, blackAlpha: 0 });
	});

	it("fades the frame before a join out over the transition's length", () => {
		const boundary = new ClipBoundaryTransition({ ...options, style: "dissolve" });
		boundary.beginClip(0, 10, true);
		boundary.beginClip(10, 10, false);

		// The first frame of the new clip is already one frame in, or the outgoing
		// picture would be shown twice.
		expect(boundary.overlayAt(10).frozenAlpha).toBeCloseTo(0.9, 5);
		expect(boundary.overlayAt(14).frozenAlpha).toBeCloseTo(0.5, 5);
		expect(boundary.overlayAt(19).frozenAlpha).toBe(0);
		// A dissolve never darkens anything.
		expect(boundary.overlayAt(12).blackAlpha).toBe(0);
	});

	it("darkens into a join and comes back out of it, for a dip", () => {
		const boundary = new ClipBoundaryTransition({ ...options, style: "dip" });
		// A ten-frame clip with another one after it: the join lands on frame 10.
		boundary.beginClip(0, 10, true);

		// Half the transition happens before the join — five frames of it.
		expect(boundary.overlayAt(4).blackAlpha).toBe(0);
		expect(boundary.overlayAt(8).blackAlpha).toBeCloseTo(0.6, 5);
		expect(boundary.overlayAt(9).blackAlpha).toBeCloseTo(0.8, 5);

		boundary.beginClip(10, 10, false);
		expect(boundary.overlayAt(10).blackAlpha).toBeCloseTo(0.8, 5);
		expect(boundary.overlayAt(12).blackAlpha).toBeCloseTo(0.4, 5);
		expect(boundary.overlayAt(14).blackAlpha).toBe(0);
		// And a dip holds no frame: it has nothing to fade out.
		expect(boundary.overlayAt(11).frozenAlpha).toBe(0);
	});

	it("does not darken towards the end of the last clip", () => {
		const boundary = new ClipBoundaryTransition({ ...options, style: "dip" });
		boundary.beginClip(0, 10, false);

		// The end of the video is not a cut: there is nothing on the other side of it.
		expect(boundary.overlayAt(9).blackAlpha).toBe(0);
		expect(boundary.overlayAt(10).blackAlpha).toBe(0);
	});

	it("keeps the two halves of a dip apart when clips are shorter than the transition", () => {
		const boundary = new ClipBoundaryTransition({ ...options, style: "dip" });
		// A three-frame clip in the middle: it is darkening towards its own end while
		// still coming back out of the join that started it.
		boundary.beginClip(10, 3, true);

		const overlay = boundary.overlayAt(11);
		// Coming out of the join says 0.6, going into the next one says 0.6 as well;
		// the stronger of the two wins rather than the two adding up past black.
		expect(overlay.blackAlpha).toBeLessThanOrEqual(1);
		expect(overlay.blackAlpha).toBeCloseTo(0.6, 5);
	});
});
