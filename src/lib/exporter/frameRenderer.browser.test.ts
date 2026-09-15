import { describe, expect, it } from "vitest";
import { FrameRenderer } from "./frameRenderer";

describe("FrameRenderer (real browser)", () => {
	it("does not let Pixi redraw the stage on its own while frames are drawn by hand", async () => {
		const renderer = new FrameRenderer({
			width: 320,
			height: 180,
			wallpaper: "#000000",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
			videoWidth: 640,
			videoHeight: 480,
			platform: "win32",
		});
		await renderer.initialize();

		try {
			// A running ticker redraws the stage every animation frame, racing renderFrame as
			// it swaps and destroys each frame's texture.
			const app = (renderer as unknown as { app: { ticker: { started: boolean } } }).app;
			expect(app.ticker.started, "Pixi's ticker is running during an export").toBe(false);
		} finally {
			renderer.destroy();
		}
	});
});
