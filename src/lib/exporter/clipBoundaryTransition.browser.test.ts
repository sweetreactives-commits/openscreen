import { describe, expect, it } from "vitest";
import { ClipBoundaryTransition } from "./clipBoundaryTransition";

/**
 * A join between clips, drawn.
 *
 * The timing is unit-tested on its own; what only a browser can answer is whether
 * the picture from before the join is really kept and put back over the clip that
 * follows — and, just as important, that the frame handed in is left untouched. A
 * card is drawn once and encoded for every frame it lasts, so an overlay burnt
 * into it would stay there for the rest of the card.
 */

const WIDTH = 160;
const HEIGHT = 90;
const OPTIONS = { frameRate: 25, durationMs: 400, width: WIDTH, height: HEIGHT };

function solid(color: string): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = WIDTH;
	canvas.height = HEIGHT;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no 2d context");
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, WIDTH, HEIGHT);
	return canvas;
}

function centrePixel(canvas: HTMLCanvasElement): [number, number, number] {
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no 2d context");
	const { data } = ctx.getImageData(WIDTH / 2, HEIGHT / 2, 1, 1);
	return [data[0], data[1], data[2]];
}

/** Two clips of five frames each, the second starting at frame 5. */
function acrossTheJoin(style: "none" | "dissolve" | "dip") {
	const boundary = new ClipBoundaryTransition({ ...OPTIONS, style });
	const outgoing = solid("#ff0000");
	const incoming = solid("#0000ff");

	boundary.beginClip(0, 5, true);
	for (let frame = 0; frame < 5; frame++) boundary.paint(outgoing, frame);

	boundary.beginClip(5, 12, false);
	const painted: Array<[number, number, number]> = [];
	for (let frame = 5; frame < 17; frame++) {
		painted.push(centrePixel(boundary.paint(incoming, frame)));
	}
	return { painted, incoming };
}

describe("a join between clips (real browser)", () => {
	it("cuts straight over when no transition is asked for", () => {
		const { painted } = acrossTheJoin("none");

		expect(painted[0][2], "the new clip is not on screen").toBeGreaterThan(200);
		expect(painted[0][0], "the outgoing clip bled across a hard cut").toBeLessThan(40);
	});

	it("holds the picture from before the join and fades it out", () => {
		const { painted } = acrossTheJoin("dissolve");

		expect(painted[0][0], "the outgoing clip was not held").toBeGreaterThan(200);
		expect(painted[1][0]).toBeLessThan(painted[0][0]);
		expect(painted[4][0]).toBeLessThan(painted[1][0]);
		// Ten frames at 25 fps is the whole 400 ms, and then it is gone.
		expect(painted[10][0], "the held picture never went away").toBeLessThan(40);
		expect(painted[10][2]).toBeGreaterThan(200);
	});

	it("lands the join in black and comes back for a dip", () => {
		const { painted } = acrossTheJoin("dip");

		// A dip holds nothing, so no red survives; it darkens instead.
		expect(painted[0][0]).toBeLessThan(40);
		expect(painted[0][2], "the first frame after the join was not darkened").toBeLessThan(180);
		expect(painted[1][2]).toBeGreaterThan(painted[0][2]);
		expect(painted[10][2], "the picture never came back").toBeGreaterThan(200);
	});

	it("never draws on the frame it was handed", () => {
		const { incoming } = acrossTheJoin("dissolve");

		// The same canvas came back through paint() a dozen times with an overlay on
		// top of it. A card's canvas is exactly this: drawn once, encoded repeatedly.
		expect(centrePixel(incoming)).toEqual([0, 0, 255]);
	});
});
