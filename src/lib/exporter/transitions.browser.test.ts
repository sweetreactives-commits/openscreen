import { describe, expect, it } from "vitest";
import type { TransitionStyle } from "@/lib/transitions";
import { FrameRenderer } from "./frameRenderer";

/**
 * A cut, rendered.
 *
 * The maths of the transition is unit-tested on its own; what only a browser can
 * answer is whether the renderer actually holds the frame from before the cut and
 * puts it back over the new material. So this feeds it two obviously different
 * frames either side of a trim and reads the pixels.
 */

const WIDTH = 160;
const HEIGHT = 90;
/** The trim in the middle of a two-second recording: everything jumps across it. */
const TRIM = { id: "trim-1", startMs: 800, endMs: 1_200 };

function solidFrame(color: string, timestampMs: number): VideoFrame {
	const canvas = document.createElement("canvas");
	canvas.width = 640;
	canvas.height = 360;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no 2d context");
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	return new VideoFrame(canvas, { timestamp: timestampMs * 1000, duration: 40_000 });
}

/** The colour at the middle of the rendered frame, where the video itself is. */
function centrePixel(renderer: FrameRenderer): [number, number, number] {
	const canvas = renderer.getCanvas();
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no 2d context on the export canvas");
	const { data } = ctx.getImageData(Math.floor(WIDTH / 2), Math.floor(HEIGHT / 2), 1, 1);
	return [data[0], data[1], data[2]];
}

async function renderAcrossTheCut(style: TransitionStyle, transitionMs: number) {
	const renderer = new FrameRenderer({
		width: WIDTH,
		height: HEIGHT,
		wallpaper: "#000000",
		zoomRegions: [],
		showShadow: false,
		shadowIntensity: 0,
		showBlur: false,
		padding: 0,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		videoWidth: 640,
		videoHeight: 360,
		trimRegions: [TRIM],
		videoDurationMs: 2_000,
		transitionStyle: style,
		transitionMs,
		frameRate: 25,
		platform: "win32",
	});
	await renderer.initialize();

	const pixels: Array<[number, number, number]> = [];
	try {
		// Red up to the cut, blue after it. 25 fps, so one frame is 40 ms.
		for (const timeMs of [720, 760]) {
			const frame = solidFrame("#ff0000", timeMs);
			await renderer.renderFrame(frame, timeMs * 1000);
			frame.close();
		}
		// Frame by frame, the way an export runs: the transition is measured in
		// frames rendered since the cut, not in source time.
		for (let index = 0; index < 12; index++) {
			const timeMs = 1_200 + index * 40;
			const frame = solidFrame("#0000ff", timeMs);
			await renderer.renderFrame(frame, timeMs * 1000);
			frame.close();
			pixels.push(centrePixel(renderer));
		}
	} finally {
		renderer.destroy();
	}
	return pixels;
}

describe("transitions at a cut (real browser)", () => {
	it("cuts hard when no transition is asked for", async () => {
		const [first] = await renderAcrossTheCut("none", 400);

		expect(first[2], "the first frame after the cut is not the new material").toBeGreaterThan(200);
		expect(
			first[0],
			"the frame before the cut bled into it with no transition asked for",
		).toBeLessThan(40);
	});

	it("dissolves out of the frame before the cut", async () => {
		const pixels = await renderAcrossTheCut("dissolve", 400);

		// Straight after the cut the old frame still dominates, and it thins out.
		expect(pixels[0][0], "the frame before the cut was not held").toBeGreaterThan(120);
		expect(pixels[1][0]).toBeLessThan(pixels[0][0]);
		expect(pixels[2][0]).toBeLessThan(pixels[1][0]);
		// And once the 400 ms are up — ten frames at 25 fps — the new material is all
		// that is left.
		expect(pixels[11][0], "the held frame never went away").toBeLessThan(40);
		expect(pixels[11][2]).toBeGreaterThan(200);
	});

	it("comes back out of black after a dip", async () => {
		const pixels = await renderAcrossTheCut("dip", 400);

		// A dip has no held frame: it darkens, so nothing red survives the cut.
		expect(pixels[0][0]).toBeLessThan(40);
		expect(pixels[0][2], "the first frame after the cut was not darkened").toBeLessThan(180);
		expect(pixels[1][2]).toBeGreaterThan(pixels[0][2]);
		expect(pixels[11][2], "the picture never came back").toBeGreaterThan(200);
	});
});
