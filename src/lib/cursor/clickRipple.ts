/**
 * Shared click-ripple math so the Pixi preview overlay, the native cursor
 * preview, and the export frame renderer all draw an identical ring.
 *
 * `progress` follows the same convention as the click-bounce helpers:
 * 1 right at the click, decaying linearly to 0 when the ripple expires.
 */
import type { Graphics } from "pixi.js";

export const CLICK_RIPPLE_DURATION_MS = 450;

export interface ClickRippleVisual {
	/** Ring radius, expressed as a multiple of the rendered cursor height. */
	radius: number;
	/** Alpha of the light (white) ring. */
	alpha: number;
	/** Alpha of the darker contrast ring drawn underneath the light one. */
	shadowAlpha: number;
	/** Stroke width, expressed as a multiple of the rendered cursor height. */
	strokeWidth: number;
}

function clamp01(value: number) {
	return Math.min(1, Math.max(0, value));
}

/**
 * Computes the ripple ring for a given remaining progress (1 → fresh click,
 * 0 → expired) and user intensity (0 disables the effect). Returns null when
 * nothing should be drawn.
 */
export function getClickRippleVisual(
	progress: number,
	intensity: number,
): ClickRippleVisual | null {
	if (progress <= 0 || intensity <= 0) {
		return null;
	}

	const clampedIntensity = clamp01(intensity);
	const elapsed = 1 - clamp01(progress);
	// Ease-out expansion: the ring grows quickly, then settles while fading.
	const eased = 1 - (1 - elapsed) ** 3;
	const fade = (1 - elapsed) ** 1.5;

	return {
		radius: 0.28 + eased * 0.55,
		alpha: 0.65 * fade * clampedIntensity,
		shadowAlpha: 0.28 * fade * clampedIntensity,
		strokeWidth: 0.085 * (1 - 0.35 * elapsed),
	};
}

/**
 * Draws the ripple onto a Pixi Graphics (preview paths). Coordinates are in the
 * graphics' local space; `cursorHeight` is the rendered cursor height used as
 * the size unit. A darker ring under the light one keeps the ripple visible on
 * bright content.
 */
export function drawClickRippleOnGraphics(
	graphics: Graphics,
	x: number,
	y: number,
	cursorHeight: number,
	visual: ClickRippleVisual,
) {
	if (cursorHeight <= 0) {
		return;
	}

	const radius = visual.radius * cursorHeight;
	const strokeWidth = Math.max(0.5, visual.strokeWidth * cursorHeight);
	graphics
		.circle(x, y, radius)
		.stroke({ width: strokeWidth * 1.9, color: 0x000000, alpha: visual.shadowAlpha })
		.circle(x, y, radius)
		.stroke({ width: strokeWidth, color: 0xffffff, alpha: visual.alpha });
}

/**
 * Draws the ripple onto a 2D canvas (export path). Coordinates are in canvas
 * pixels; `cursorHeight` is the rendered cursor height used as the size unit.
 */
export function drawClickRippleOnCanvas(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	cursorHeight: number,
	visual: ClickRippleVisual,
) {
	if (cursorHeight <= 0) {
		return;
	}

	const radius = visual.radius * cursorHeight;
	const strokeWidth = Math.max(0.5, visual.strokeWidth * cursorHeight);

	ctx.save();
	ctx.beginPath();
	ctx.arc(x, y, radius, 0, Math.PI * 2);
	ctx.strokeStyle = `rgba(0, 0, 0, ${visual.shadowAlpha.toFixed(4)})`;
	ctx.lineWidth = strokeWidth * 1.9;
	ctx.stroke();
	ctx.beginPath();
	ctx.arc(x, y, radius, 0, Math.PI * 2);
	ctx.strokeStyle = `rgba(255, 255, 255, ${visual.alpha.toFixed(4)})`;
	ctx.lineWidth = strokeWidth;
	ctx.stroke();
	ctx.restore();
}
