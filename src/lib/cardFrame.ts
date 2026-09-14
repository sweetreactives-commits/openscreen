/**
 * Drawing a card clip — a title slide with no recording behind it.
 *
 * One implementation, used by both the preview and the exporter, so a card
 * cannot look like one thing while editing and another in the finished file.
 * That has bitten this project before: an agent's image sat on the timeline and
 * rendered nowhere, because the two paths read different fields.
 *
 * A card is a still. The exporter draws it once and encodes the same pixels for
 * every frame it lasts.
 */

/** The app's own near-black, so a card reads as part of the product. */
export const DEFAULT_CARD_BACKGROUND = "#09090b";
export const DEFAULT_CARD_TEXT_COLOR = "#fafafa";

/** Share of the frame the text may occupy before it has to shrink. */
const TEXT_WIDTH_RATIO = 0.8;
const TEXT_HEIGHT_RATIO = 0.6;

/** Relative to the frame height, so a card looks the same at any resolution. */
const MAX_FONT_RATIO = 0.12;
const MIN_FONT_RATIO = 0.04;
const LINE_HEIGHT_RATIO = 1.25;

export interface CardTitleLayout {
	lines: string[];
	fontSize: number;
	lineHeight: number;
}

/**
 * Wraps and sizes a title to fit the frame.
 *
 * Takes its own measurer so the arithmetic can be tested without a canvas — the
 * real one hands it `ctx.measureText`.
 */
export function layoutCardTitle(
	title: string,
	frame: { width: number; height: number },
	measure: (text: string, fontSize: number) => number,
): CardTitleLayout {
	const maxWidth = frame.width * TEXT_WIDTH_RATIO;
	const maxHeight = frame.height * TEXT_HEIGHT_RATIO;
	const maxFont = Math.max(1, Math.round(frame.height * MAX_FONT_RATIO));
	const minFont = Math.max(1, Math.round(frame.height * MIN_FONT_RATIO));

	const words = title.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return { lines: [], fontSize: maxFont, lineHeight: Math.round(maxFont * LINE_HEIGHT_RATIO) };
	}

	let fallback: CardTitleLayout | null = null;

	for (let fontSize = maxFont; fontSize >= minFont; fontSize--) {
		const lines = wrap(words, maxWidth, fontSize, measure);
		const lineHeight = Math.round(fontSize * LINE_HEIGHT_RATIO);
		const layout = { lines, fontSize, lineHeight };

		// Remember the largest size that at least fits vertically, in case nothing
		// fits horizontally: a long unbroken word can never be made to fit, and
		// clipping one word beats refusing to draw the card at all.
		if (lines.length * lineHeight <= maxHeight) {
			if (!fallback) fallback = layout;
			if (lines.every((line) => measure(line, fontSize) <= maxWidth)) return layout;
		}
	}

	const lineHeight = Math.round(minFont * LINE_HEIGHT_RATIO);
	return (
		fallback ?? { lines: wrap(words, maxWidth, minFont, measure), fontSize: minFont, lineHeight }
	);
}

function wrap(
	words: readonly string[],
	maxWidth: number,
	fontSize: number,
	measure: (text: string, fontSize: number) => number,
): string[] {
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (current && measure(candidate, fontSize) > maxWidth) {
			lines.push(current);
			current = word;
		} else {
			current = candidate;
		}
	}

	if (current) lines.push(current);
	return lines;
}

export interface CardFrameOptions {
	width: number;
	height: number;
	title?: string;
	background?: string;
	textColor?: string;
	fontFamily?: string;
}

const DEFAULT_FONT_FAMILY =
	'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Paints one card onto a 2D context sized `width` by `height`. */
export function drawCardFrame(ctx: CanvasRenderingContext2D, options: CardFrameOptions): void {
	const { width, height } = options;
	const fontFamily = options.fontFamily ?? DEFAULT_FONT_FAMILY;

	ctx.save();
	ctx.fillStyle = options.background ?? DEFAULT_CARD_BACKGROUND;
	ctx.fillRect(0, 0, width, height);

	const title = options.title?.trim();
	if (title) {
		const measure = (text: string, fontSize: number) => {
			ctx.font = `600 ${fontSize}px ${fontFamily}`;
			return ctx.measureText(text).width;
		};
		const { lines, fontSize, lineHeight } = layoutCardTitle(title, { width, height }, measure);

		ctx.font = `600 ${fontSize}px ${fontFamily}`;
		ctx.fillStyle = options.textColor ?? DEFAULT_CARD_TEXT_COLOR;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";

		// Centred as a block: the first line sits half the block above the middle.
		const top = height / 2 - ((lines.length - 1) * lineHeight) / 2;
		lines.forEach((line, index) => {
			ctx.fillText(line, width / 2, top + index * lineHeight);
		});
	}

	ctx.restore();
}

/** How many frames a card lasts at the export frame rate. Always at least one. */
export function cardFrameCount(durationMs: number, frameRate: number): number {
	if (!(durationMs > 0) || !(frameRate > 0)) return 0;
	return Math.max(1, Math.round((durationMs / 1000) * frameRate));
}
