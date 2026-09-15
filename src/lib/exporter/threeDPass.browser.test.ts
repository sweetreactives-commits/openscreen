import { describe, expect, it } from "vitest";
import { createThreeDPass } from "./threeDPass";

describe("ThreeDPass (real browser)", () => {
	it("gives its WebGL context back, so many exports do not starve the page", () => {
		// Stands in for the editor's preview: a context that has to survive every export
		// made while it is open.
		const sentinelCanvas = document.createElement("canvas");
		const sentinel = sentinelCanvas.getContext("webgl2");
		expect(sentinel, "this browser has no WebGL2 to test with").not.toBeNull();
		if (!sentinel) return;

		// Every export creates and destroys one of these. Chromium caps live contexts per
		// page and discards the oldest past the cap, so a pass that only deletes its
		// resources leaves the context alive and eventually costs the sentinel its own.
		for (let i = 0; i < 40; i++) {
			const pass = createThreeDPass(64, 64);
			pass.destroy();
		}

		expect(sentinel.isContextLost(), "an older WebGL context was dropped").toBe(false);
	});
});
