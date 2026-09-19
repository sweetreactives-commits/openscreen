/**
 * The mark drawn under the cursor for as long as it is on screen.
 *
 * A click effect answers "something happened here"; this answers "the pointer
 * is here", which is a different problem — a cursor crossing a busy page is
 * genuinely hard to follow, and no amount of click feedback helps between
 * clicks. Two shapes, because they fail differently: a disc reads at a glance
 * but hides what is under it, a glow hides nothing but needs contrast to be
 * seen at all.
 *
 * Lives beside the click effect and mirrors its shape on purpose — same size
 * unit, same pair of draw functions — so the preview paths and the export
 * cannot drift apart.
 */
import type { Graphics } from "pixi.js";
import { parseHexColor } from "./clickRipple";

export const CURSOR_BACKDROP_STYLES = ["none", "circle", "glow"] as const;
export type CursorBackdropStyle = (typeof CURSOR_BACKDROP_STYLES)[number];
export const DEFAULT_CURSOR_BACKDROP_STYLE: CursorBackdropStyle = "none";
export const DEFAULT_CURSOR_BACKDROP_COLOR = "#34b27b";
export const DEFAULT_CURSOR_BACKDROP_OPACITY = 0.35;
/** A multiplier on the shape's own radius, so 1 is the size it was drawn at. */
export const DEFAULT_CURSOR_BACKDROP_SIZE = 1;
export const MIN_CURSOR_BACKDROP_SIZE = 0.4;
export const MAX_CURSOR_BACKDROP_SIZE = 2.5;

export interface CursorBackdropVisual {
	/** Radius, expressed as a multiple of the rendered cursor height. */
	radius: number;
	alpha: number;
	/** A glow fades to nothing at its edge; a disc does not. */
	soft: boolean;
}

export function normalizeCursorBackdropStyle(value: unknown): CursorBackdropStyle {
	return CURSOR_BACKDROP_STYLES.includes(value as CursorBackdropStyle)
		? (value as CursorBackdropStyle)
		: DEFAULT_CURSOR_BACKDROP_STYLE;
}

/**
 * The disc sits a little tighter than the glow: a hard edge that reaches as far
 * as the glow does stops reading as "behind the cursor" and starts reading as a
 * blob the cursor happens to be on.
 */
export function getCursorBackdropVisual(
	style: CursorBackdropStyle,
	opacity: number,
	size: number = DEFAULT_CURSOR_BACKDROP_SIZE,
): CursorBackdropVisual | null {
	const alpha = Math.min(1, Math.max(0, opacity));
	if (style === "none" || alpha <= 0) {
		return null;
	}

	const scale = Math.min(
		MAX_CURSOR_BACKDROP_SIZE,
		Math.max(MIN_CURSOR_BACKDROP_SIZE, Number.isFinite(size) ? size : DEFAULT_CURSOR_BACKDROP_SIZE),
	);

	return style === "glow"
		? { radius: 1.15 * scale, alpha, soft: true }
		: { radius: 0.72 * scale, alpha, soft: false };
}

export function drawCursorBackdropOnGraphics(
	graphics: Graphics,
	x: number,
	y: number,
	cursorHeight: number,
	visual: CursorBackdropVisual,
	color: string = DEFAULT_CURSOR_BACKDROP_COLOR,
) {
	if (cursorHeight <= 0) {
		return;
	}

	const rgb = parseHexColor(color) ?? { r: 52, g: 178, b: 123 };
	const tint = (rgb.r << 16) | (rgb.g << 8) | rgb.b;
	const radius = visual.radius * cursorHeight;

	if (!visual.soft) {
		graphics.circle(x, y, radius).fill({ color: tint, alpha: visual.alpha });
		return;
	}

	// Pixi has no radial gradient fill here, so the falloff is built from rings
	// of decreasing alpha. Few enough to stay cheap, enough not to band.
	const steps = 6;
	for (let step = steps; step >= 1; step -= 1) {
		const t = step / steps;
		graphics.circle(x, y, radius * t).fill({
			color: tint,
			// Squared falloff, and each ring stacks onto the ones outside it.
			alpha: (visual.alpha * (1 - t) ** 2) / 2,
		});
	}
}

export function drawCursorBackdropOnCanvas(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	cursorHeight: number,
	visual: CursorBackdropVisual,
	color: string = DEFAULT_CURSOR_BACKDROP_COLOR,
) {
	if (cursorHeight <= 0) {
		return;
	}

	const rgb = parseHexColor(color) ?? { r: 52, g: 178, b: 123 };
	const radius = visual.radius * cursorHeight;

	ctx.save();
	if (visual.soft) {
		// The canvas path can do the falloff properly; the stops match the shape
		// the Pixi rings approximate.
		const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
		gradient.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${visual.alpha.toFixed(4)})`);
		gradient.addColorStop(
			0.5,
			`rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${(visual.alpha * 0.25).toFixed(4)})`,
		);
		gradient.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
		ctx.fillStyle = gradient;
	} else {
		ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${visual.alpha.toFixed(4)})`;
	}
	ctx.beginPath();
	ctx.arc(x, y, radius, 0, Math.PI * 2);
	ctx.fill();
	ctx.restore();
}
