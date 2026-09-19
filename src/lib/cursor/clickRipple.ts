/**
 * Shared click-effect math so the Pixi preview overlay, the native cursor
 * preview, and the export frame renderer all draw an identical mark.
 *
 * `progress` follows the same convention as the click-bounce helpers:
 * 1 right at the click, decaying linearly to 0 when the effect expires.
 *
 * Three styles, separated by how loud they are rather than by shape: a ring
 * that covers nothing, a soft disc that reads as a tap, and staggered rings for
 * the moments worth pointing at. What every style shares is a darker pass drawn
 * underneath — without it a light effect disappears on light content, which is
 * why the contrast colour is not the user's to choose.
 */
import type { Graphics } from "pixi.js";

export const CLICK_RIPPLE_DURATION_MS = 450;

export const CLICK_EFFECT_STYLES = ["ring", "pulse", "echo"] as const;
export type ClickEffectStyle = (typeof CLICK_EFFECT_STYLES)[number];
export const DEFAULT_CLICK_EFFECT_STYLE: ClickEffectStyle = "ring";
export const DEFAULT_CLICK_EFFECT_COLOR = "#ffffff";

/** Rings of `echo`, as a head start on the leading ring's progress. */
const ECHO_DELAYS = [0, 0.22, 0.44];

export interface ClickRippleLayer {
	/** Radius, expressed as a multiple of the rendered cursor height. */
	radius: number;
	alpha: number;
	/**
	 * Stroke width as a multiple of cursor height. Zero means a filled disc,
	 * which is what separates `pulse` from the ring styles.
	 */
	strokeWidth: number;
}

export interface ClickRippleVisual {
	/** Drawn in order, so an earlier layer sits under a later one. */
	layers: ClickRippleLayer[];
	/** Alpha of the darker contrast pass drawn under each layer. */
	shadowAlpha: number;
}

function clamp01(value: number) {
	return Math.min(1, Math.max(0, value));
}

export function normalizeClickEffectStyle(value: unknown): ClickEffectStyle {
	return CLICK_EFFECT_STYLES.includes(value as ClickEffectStyle)
		? (value as ClickEffectStyle)
		: DEFAULT_CLICK_EFFECT_STYLE;
}

/**
 * How much of the effect the intensity dial buys.
 *
 * It used to buy opacity alone, so every ripple came out the same size however
 * low the dial went — which reads as a dial that does nothing, since a large
 * faint ring and a large bright one differ less than the numbers suggest. A
 * weaker ripple is now a smaller one too, and never shrinks to a dot.
 */
function sizeScaleFor(intensity: number): number {
	return 0.45 + 0.75 * intensity;
}

/**
 * A single expanding ring: the original effect, and the quietest of the three.
 *
 * `alphaIntensity` is separate so `echo` can fade its trailing rings without
 * also shrinking them out of the arrangement.
 */
function ringLayer(
	elapsed: number,
	intensity: number,
	alphaIntensity = intensity,
): ClickRippleLayer | null {
	if (elapsed >= 1) {
		return null;
	}
	// Ease-out expansion: the ring grows quickly, then settles while fading.
	const eased = 1 - (1 - elapsed) ** 3;
	const fade = (1 - elapsed) ** 1.5;
	const sizeScale = sizeScaleFor(intensity);
	return {
		radius: (0.28 + eased * 0.55) * sizeScale,
		// Never fully transparent at the low end: the dial sets how big and how
		// strong, and a ring nobody can see is not a weaker ring, it is none.
		alpha: 0.85 * fade * (0.4 + 0.6 * alphaIntensity),
		strokeWidth: 0.11 * (1 - 0.35 * elapsed) * sizeScale,
	};
}

/**
 * A filled disc, kept deliberately faint.
 *
 * It covers whatever was clicked, which is the one thing a click effect must
 * not do — so it stays translucent, spreads less far than the ring, and is gone
 * sooner.
 */
function pulseLayer(elapsed: number, intensity: number): ClickRippleLayer | null {
	if (elapsed >= 1) {
		return null;
	}
	const eased = 1 - (1 - elapsed) ** 2;
	const fade = (1 - elapsed) ** 2;
	const sizeScale = sizeScaleFor(intensity);
	return {
		radius: (0.22 + eased * 0.5) * sizeScale,
		alpha: 0.42 * fade * (0.4 + 0.6 * intensity),
		strokeWidth: 0,
	};
}

export function getClickRippleVisual(
	progress: number,
	intensity: number,
	style: ClickEffectStyle = DEFAULT_CLICK_EFFECT_STYLE,
): ClickRippleVisual | null {
	if (progress <= 0 || intensity <= 0) {
		return null;
	}

	const clampedIntensity = clamp01(intensity);
	const elapsed = 1 - clamp01(progress);

	if (style === "pulse") {
		const layer = pulseLayer(elapsed, clampedIntensity);
		return layer ? { layers: [layer], shadowAlpha: 0.16 * clampedIntensity } : null;
	}

	if (style === "echo") {
		// Each ring is the same ring, started later: the trailing ones have not
		// left the cursor yet when the leading one is already fading.
		const layers = ECHO_DELAYS.map((delay) =>
			ringLayer(elapsed + delay, clampedIntensity, clampedIntensity * (1 - delay * 0.8)),
		).filter((layer): layer is ClickRippleLayer => layer !== null);
		return layers.length > 0
			? { layers, shadowAlpha: 0.17 * (1 - elapsed) * clampedIntensity }
			: null;
	}

	const layer = ringLayer(elapsed, clampedIntensity);
	return layer
		? { layers: [layer], shadowAlpha: 0.2 * (1 - elapsed) ** 1.5 * clampedIntensity }
		: null;
}

/** `#rrggbb` (or `#rgb`) to the 0xRRGGBB Pixi wants; falls back to white. */
export function clickEffectColorToNumber(color: string | null | undefined): number {
	const parsed = parseHexColor(color);
	return parsed ? (parsed.r << 16) | (parsed.g << 8) | parsed.b : 0xffffff;
}

export function parseHexColor(
	color: string | null | undefined,
): { r: number; g: number; b: number } | null {
	if (typeof color !== "string") {
		return null;
	}
	const hex = color.trim().replace(/^#/, "");
	const full =
		hex.length === 3
			? hex
					.split("")
					.map((c) => c + c)
					.join("")
			: hex;
	if (!/^[0-9a-fA-F]{6}$/.test(full)) {
		return null;
	}
	return {
		r: Number.parseInt(full.slice(0, 2), 16),
		g: Number.parseInt(full.slice(2, 4), 16),
		b: Number.parseInt(full.slice(4, 6), 16),
	};
}

/**
 * Draws the effect onto a Pixi Graphics (preview paths). Coordinates are in the
 * graphics' local space; `cursorHeight` is the rendered cursor height used as
 * the size unit.
 */
export function drawClickRippleOnGraphics(
	graphics: Graphics,
	x: number,
	y: number,
	cursorHeight: number,
	visual: ClickRippleVisual,
	color: string = DEFAULT_CLICK_EFFECT_COLOR,
) {
	if (cursorHeight <= 0) {
		return;
	}

	const tint = clickEffectColorToNumber(color);
	for (const layer of visual.layers) {
		const radius = layer.radius * cursorHeight;
		if (layer.strokeWidth <= 0) {
			graphics
				.circle(x, y, radius)
				.fill({ color: 0x000000, alpha: visual.shadowAlpha * 0.5 })
				.circle(x, y, radius)
				.fill({ color: tint, alpha: layer.alpha });
			continue;
		}
		const strokeWidth = Math.max(0.5, layer.strokeWidth * cursorHeight);
		graphics
			.circle(x, y, radius)
			.stroke({ width: strokeWidth * 1.4, color: 0x000000, alpha: visual.shadowAlpha })
			.circle(x, y, radius)
			.stroke({ width: strokeWidth, color: tint, alpha: layer.alpha });
	}
}

/**
 * Draws the effect onto a 2D canvas (export path). Coordinates are in canvas
 * pixels; `cursorHeight` is the rendered cursor height used as the size unit.
 */
export function drawClickRippleOnCanvas(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	cursorHeight: number,
	visual: ClickRippleVisual,
	color: string = DEFAULT_CLICK_EFFECT_COLOR,
) {
	if (cursorHeight <= 0) {
		return;
	}

	const rgb = parseHexColor(color) ?? { r: 255, g: 255, b: 255 };
	ctx.save();
	for (const layer of visual.layers) {
		const radius = layer.radius * cursorHeight;
		if (layer.strokeWidth <= 0) {
			ctx.beginPath();
			ctx.arc(x, y, radius, 0, Math.PI * 2);
			ctx.fillStyle = `rgba(0, 0, 0, ${(visual.shadowAlpha * 0.5).toFixed(4)})`;
			ctx.fill();
			ctx.beginPath();
			ctx.arc(x, y, radius, 0, Math.PI * 2);
			ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${layer.alpha.toFixed(4)})`;
			ctx.fill();
			continue;
		}
		const strokeWidth = Math.max(0.5, layer.strokeWidth * cursorHeight);
		ctx.beginPath();
		ctx.arc(x, y, radius, 0, Math.PI * 2);
		ctx.strokeStyle = `rgba(0, 0, 0, ${visual.shadowAlpha.toFixed(4)})`;
		ctx.lineWidth = strokeWidth * 1.4;
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(x, y, radius, 0, Math.PI * 2);
		ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${layer.alpha.toFixed(4)})`;
		ctx.lineWidth = strokeWidth;
		ctx.stroke();
	}
	ctx.restore();
}
