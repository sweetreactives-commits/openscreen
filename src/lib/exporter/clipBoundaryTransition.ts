import {
	combineOverlays,
	DEFAULT_TRANSITION_MS,
	overlayAfterSeam,
	overlayBeforeSeam,
	type TransitionOverlay,
	type TransitionStyle,
} from "@/lib/transitions";

/**
 * Smoothing over the joins between clips, in an export.
 *
 * A trim's seam is smoothed inside the frame renderer, which knows where the
 * cuts of the recording it is drawing are. A clip boundary is invisible there: a
 * card never goes through the renderer at all — it is drawn onto its own canvas
 * and encoded straight. What both kinds of clip do share is the single funnel
 * every output frame passes through, and that is where this belongs.
 *
 * The effect is the same as at a trim, and so is the maths (`@/lib/transitions`):
 * hold the last frame before the join and fade it over what follows. No second
 * decoder, no overlapping clips — and no change to anyone's length, so frame
 * counts and the audio offsets built on them are untouched. See "Сверка перед
 * этапом 9" in docs/architecture/multiclip.md.
 */

export interface ClipBoundaryOptions {
	style?: TransitionStyle;
	durationMs?: number;
	/** Output frames per second: one rendered frame lasts this long.	*/
	frameRate: number;
	width: number;
	height: number;
}

const NOTHING: TransitionOverlay = { frozenAlpha: 0, blackAlpha: 0 };

export class ClipBoundaryTransition {
	private readonly style: TransitionStyle;
	private readonly durationMs: number;
	private readonly frameMs: number;
	private readonly width: number;
	private readonly height: number;

	/** Output frame the current transition started on, or null when none is running. */
	private boundaryFrame: number | null = null;
	/** Where the clip being rendered is expected to end; null when it is the last one. */
	private endFrame: number | null = null;

	private frozen: HTMLCanvasElement | null = null;
	private scratch: HTMLCanvasElement | null = null;
	/** The canvas the previous frame was encoded from — a reference, not a copy. */
	private lastFrame: HTMLCanvasElement | null = null;

	constructor(options: ClipBoundaryOptions) {
		this.style = options.style ?? "none";
		this.durationMs = options.durationMs ?? DEFAULT_TRANSITION_MS;
		this.frameMs = 1000 / (options.frameRate || 30);
		this.width = options.width;
		this.height = options.height;
	}

	/** Nothing asked for: every frame goes through untouched. */
	get enabled(): boolean {
		return this.style !== "none";
	}

	/**
	 * The next clip's frames start at `frameIndex`.
	 *
	 * The start of a join is exact — the loop knows when it moves on. Where the
	 * clip *ends* has to be predicted, because a dip has to start darkening before
	 * the join arrives: `plannedFrames` is the same count the progress budget uses.
	 * A frame of drift there moves the darkening by one frame, which is not worth
	 * an exact count.
	 *
	 * The first clip of an export is not a join: there is nothing on one side of
	 * it, which makes it the start of the video rather than a cut.
	 */
	beginClip(frameIndex: number, plannedFrames: number, hasMoreClips: boolean): void {
		this.endFrame = hasMoreClips ? frameIndex + plannedFrames : null;
		if (!this.enabled || frameIndex === 0) return;
		this.boundaryFrame = frameIndex;
		// Nothing has been drawn for the new clip yet, so the canvas behind
		// `lastFrame` still holds the outgoing picture exactly.
		if (this.style === "dissolve") this.holdLastFrame();
	}

	/** What to draw over output frame `frameIndex`. */
	overlayAt(frameIndex: number): TransitionOverlay {
		if (!this.enabled) return NOTHING;

		// The first frame of the new clip is already one frame into the transition:
		// at full strength it would show the outgoing frame a second time.
		const after =
			this.boundaryFrame === null
				? NOTHING
				: overlayAfterSeam(
						this.style,
						this.durationMs,
						(frameIndex - this.boundaryFrame + 1) * this.frameMs,
					);
		const before = overlayBeforeSeam(
			this.style,
			this.durationMs,
			this.endFrame === null ? null : (this.endFrame - frameIndex) * this.frameMs,
		);
		return combineOverlays(before, after);
	}

	/**
	 * The canvas to encode as output frame `frameIndex`.
	 *
	 * The frame handed in is never drawn on: a card's canvas is painted once and
	 * encoded for every frame it lasts, so an overlay burnt into it would stay for
	 * the rest of the card.
	 */
	paint(canvas: HTMLCanvasElement, frameIndex: number): HTMLCanvasElement {
		if (!this.enabled) return canvas;

		const overlay = this.overlayAt(frameIndex);
		if (overlay.frozenAlpha <= 0 && overlay.blackAlpha <= 0) {
			this.lastFrame = canvas;
			return canvas;
		}

		const scratch = this.ensureCanvas("scratch");
		const ctx = scratch?.getContext("2d");
		if (!scratch || !ctx) return canvas;

		ctx.clearRect(0, 0, this.width, this.height);
		ctx.drawImage(canvas, 0, 0, this.width, this.height);
		if (overlay.frozenAlpha > 0 && this.frozen) {
			ctx.save();
			ctx.globalAlpha = overlay.frozenAlpha;
			ctx.drawImage(this.frozen, 0, 0, this.width, this.height);
			ctx.restore();
		}
		if (overlay.blackAlpha > 0) {
			ctx.save();
			ctx.globalAlpha = overlay.blackAlpha;
			ctx.fillStyle = "#000000";
			ctx.fillRect(0, 0, this.width, this.height);
			ctx.restore();
		}

		// What the viewer last saw, overlay and all: a join right after another one
		// should fade out of the picture that was actually on screen.
		this.lastFrame = scratch;
		return scratch;
	}

	private holdLastFrame(): void {
		const source = this.lastFrame;
		if (!source) return;
		const frozen = this.ensureCanvas("frozen");
		const ctx = frozen?.getContext("2d");
		if (!frozen || !ctx) return;
		ctx.clearRect(0, 0, this.width, this.height);
		ctx.drawImage(source, 0, 0, this.width, this.height);
	}

	private ensureCanvas(which: "frozen" | "scratch"): HTMLCanvasElement | null {
		const existing = which === "frozen" ? this.frozen : this.scratch;
		if (existing) return existing;
		const canvas = document.createElement("canvas");
		canvas.width = this.width;
		canvas.height = this.height;
		if (which === "frozen") this.frozen = canvas;
		else this.scratch = canvas;
		return canvas;
	}
}
