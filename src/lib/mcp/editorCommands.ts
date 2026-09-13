import {
	type AnnotationRegion,
	type AnnotationTextAnimation,
	clampFocusToDepth,
	clampPlaybackSpeed,
	DEFAULT_ANNOTATION_POSITION,
	DEFAULT_ANNOTATION_SIZE,
	DEFAULT_ANNOTATION_STYLE,
	DEFAULT_BLUR_DATA,
	DEFAULT_ZOOM_DEPTH,
	MAX_BLUR_BLOCK_SIZE,
	MAX_BLUR_INTENSITY,
	MAX_CURSOR_CLICK_BOUNCE,
	MAX_CURSOR_SIZE,
	MAX_ZOOM_SCALE,
	MIN_BLUR_BLOCK_SIZE,
	MIN_BLUR_INTENSITY,
	MIN_CURSOR_SIZE,
	MIN_ZOOM_SCALE,
	type SpeedRegion,
	type TrimRegion,
	type ZoomRegion,
} from "@/components/video-editor/types";
import type { EditorState } from "@/hooks/useEditorHistory";
import { isPortraitAspectRatio } from "@/utils/aspectRatioUtils";

/**
 * The typed command layer between an agent and the editor's document.
 *
 * Pure: every command takes the current state and returns a patch, never
 * touching React or Electron. The renderer applies the patch through the
 * editor's history, so one command list is one undo step for the user.
 *
 * Two rules hold throughout. Ids are ours to hand out, never the caller's —
 * the editor allocates its own sequentially and a caller-supplied id would
 * eventually collide. And every span is validated against the recording before
 * anything is applied: a batch either lands whole or not at all, so a mistake
 * in the fifth command cannot leave the first four half-written.
 */

export type CommandErrorCode =
	| "invalid-range"
	| "invalid-value"
	| "unknown-id"
	| "unknown-command"
	| "no-project";

export interface CommandFailure {
	ok: false;
	code: CommandErrorCode;
	message: string;
}

export interface CommandSuccess {
	ok: true;
	patch: Partial<EditorState>;
	/** Ids of anything created, in the order the commands ran. */
	createdIds: string[];
}

export type CommandOutcome = CommandSuccess | CommandFailure;

export interface TimeSpan {
	startMs: number;
	endMs: number;
}

export type EditorCommand =
	| ({
			op: "add_zoom";
			scale?: number;
			focus?: { cx: number; cy: number };
			followCursor?: boolean;
	  } & TimeSpan)
	| {
			op: "update_zoom";
			id: string;
			startMs?: number;
			endMs?: number;
			scale?: number;
			focus?: { cx: number; cy: number };
			followCursor?: boolean;
	  }
	| ({ op: "remove_range" } & TimeSpan)
	| ({ op: "set_speed"; speed: number } & TimeSpan)
	| ({
			op: "add_text";
			text: string;
			position?: { x: number; y: number };
			size?: { width: number; height: number };
			fontSize?: number;
			color?: string;
			animation?: AnnotationTextAnimation;
	  } & TimeSpan)
	| {
			op: "update_text";
			id: string;
			text?: string;
			startMs?: number;
			endMs?: number;
			position?: { x: number; y: number };
			fontSize?: number;
			color?: string;
			animation?: AnnotationTextAnimation;
	  }
	| { op: "remove_region"; id: string }
	| {
			op: "set_layout";
			padding?: number;
			borderRadius?: number;
			shadowIntensity?: number;
			wallpaper?: string;
	  }
	| ({
			op: "add_blur";
			style?: "blur" | "mosaic";
			shape?: "rectangle" | "oval";
			/** How strong, 1 to 100. Mapped onto the editor's own range. */
			strength?: number;
			position?: { x: number; y: number };
			size?: { width: number; height: number };
	  } & TimeSpan)
	| ({
			op: "add_image";
			/** Already-encoded image; the caller gives a path and the renderer reads it. */
			dataUrl: string;
			position?: { x: number; y: number };
			size?: { width: number; height: number };
	  } & TimeSpan)
	| {
			op: "set_webcam";
			layout?: "picture-in-picture" | "vertical-stack" | "dual-frame" | "no-webcam";
			shape?: "rectangle" | "circle" | "square" | "rounded";
			sizePercent?: number;
			position?: { cx: number; cy: number } | null;
			mirrored?: boolean;
			reactiveZoom?: boolean;
	  }
	| {
			op: "set_cursor";
			visible?: boolean;
			size?: number;
			smoothing?: number;
			motionBlur?: number;
			clickBounce?: number;
			clickRipple?: number;
	  };

const WEBCAM_LAYOUTS = ["picture-in-picture", "vertical-stack", "dual-frame", "no-webcam"] as const;
const WEBCAM_SHAPES = ["rectangle", "circle", "square", "rounded"] as const;

function fail(code: CommandErrorCode, message: string): CommandFailure {
	return { ok: false, code, message };
}

/**
 * Ids the editor's own counter can never produce.
 *
 * The UI numbers regions `zoom-1`, `zoom-2`, … from a counter that survives
 * deletions, so it can sit ahead of anything present in the state. Allocating
 * "one past the highest id I can see" would sooner or later hand out an id the
 * UI is about to reuse. A random suffix sidesteps that entirely, and
 * `deriveNextId` ignores it because its pattern requires digits.
 */
function newId(prefix: string): string {
	const random = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
	return `${prefix}-${random}`;
}

function isFinitePositive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Rejects spans that are backwards, outside the recording, or not numbers at all. */
function validateSpan(
	span: Partial<TimeSpan>,
	durationMs: number,
	what: string,
): CommandFailure | null {
	if (!isFinitePositive(span.startMs) || !isFinitePositive(span.endMs)) {
		return fail("invalid-range", `${what} needs numeric startMs and endMs.`);
	}
	if (span.endMs <= span.startMs) {
		return fail(
			"invalid-range",
			`${what} ends at ${span.endMs}ms, at or before its start of ${span.startMs}ms.`,
		);
	}
	if (span.startMs < 0 || span.endMs > durationMs) {
		return fail(
			"invalid-range",
			`${what} spans ${span.startMs}–${span.endMs}ms, outside the recording (0–${Math.round(durationMs)}ms).`,
		);
	}
	return null;
}

function applyOne(
	state: EditorState,
	command: EditorCommand,
	durationMs: number,
	createdIds: string[],
): EditorState | CommandFailure {
	switch (command.op) {
		case "add_zoom": {
			const invalid = validateSpan(command, durationMs, "A zoom");
			if (invalid) return invalid;

			const id = newId("zoom");
			createdIds.push(id);
			const region: ZoomRegion = {
				id,
				startMs: Math.round(command.startMs),
				endMs: Math.round(command.endMs),
				depth: DEFAULT_ZOOM_DEPTH,
				customScale: clamp(command.scale ?? 1.8, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE),
				focus: clampFocusToDepth(command.focus ?? { cx: 0.5, cy: 0.5 }, DEFAULT_ZOOM_DEPTH),
				focusMode: command.followCursor ? "auto" : "manual",
				// Marks it as a suggestion the user can still sweep away, without the
				// magic wand's toggle taking it with the wand's own.
				source: "agent",
			};
			return { ...state, zoomRegions: [...state.zoomRegions, region] };
		}

		case "update_zoom": {
			const index = state.zoomRegions.findIndex((region) => region.id === command.id);
			if (index === -1) return fail("unknown-id", `No zoom with id "${command.id}".`);

			const current = state.zoomRegions[index];
			const next: ZoomRegion = {
				...current,
				source: "manual",
				startMs: command.startMs ?? current.startMs,
				endMs: command.endMs ?? current.endMs,
				...(command.scale !== undefined
					? { customScale: clamp(command.scale, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE) }
					: {}),
				...(command.focus ? { focus: clampFocusToDepth(command.focus, current.depth) } : {}),
				...(command.followCursor !== undefined
					? { focusMode: command.followCursor ? ("auto" as const) : ("manual" as const) }
					: {}),
			};

			const invalid = validateSpan(next, durationMs, `Zoom "${command.id}"`);
			if (invalid) return invalid;

			const zoomRegions = [...state.zoomRegions];
			zoomRegions[index] = next;
			return { ...state, zoomRegions };
		}

		case "remove_range": {
			const invalid = validateSpan(command, durationMs, "A removed range");
			if (invalid) return invalid;

			const id = newId("trim");
			createdIds.push(id);
			const region: TrimRegion = {
				id,
				startMs: Math.round(command.startMs),
				endMs: Math.round(command.endMs),
				source: "agent",
			};
			return { ...state, trimRegions: [...state.trimRegions, region] };
		}

		case "set_speed": {
			const invalid = validateSpan(command, durationMs, "A speed change");
			if (invalid) return invalid;
			if (!isFinitePositive(command.speed) || command.speed <= 0) {
				return fail("invalid-value", "Speed must be a positive number.");
			}

			const id = newId("speed");
			createdIds.push(id);
			const region: SpeedRegion = {
				id,
				startMs: Math.round(command.startMs),
				endMs: Math.round(command.endMs),
				speed: clampPlaybackSpeed(command.speed),
				source: "agent",
			};
			return { ...state, speedRegions: [...state.speedRegions, region] };
		}

		case "add_text": {
			const invalid = validateSpan(command, durationMs, "A text annotation");
			if (invalid) return invalid;
			if (typeof command.text !== "string" || command.text.trim() === "") {
				return fail("invalid-value", "A text annotation needs non-empty text.");
			}

			const id = newId("annotation");
			createdIds.push(id);
			const zIndex =
				state.annotationRegions.reduce((max, region) => Math.max(max, region.zIndex), 0) + 1;
			const region: AnnotationRegion = {
				id,
				startMs: Math.round(command.startMs),
				endMs: Math.round(command.endMs),
				type: "text",
				content: command.text,
				textContent: command.text,
				position: command.position ?? DEFAULT_ANNOTATION_POSITION,
				size: command.size ?? DEFAULT_ANNOTATION_SIZE,
				style: {
					...DEFAULT_ANNOTATION_STYLE,
					...(command.fontSize !== undefined ? { fontSize: command.fontSize } : {}),
					...(command.color ? { color: command.color } : {}),
					...(command.animation ? { textAnimation: command.animation } : {}),
				},
				zIndex,
				source: "agent",
			};
			return { ...state, annotationRegions: [...state.annotationRegions, region] };
		}

		case "update_text": {
			const index = state.annotationRegions.findIndex((region) => region.id === command.id);
			if (index === -1) return fail("unknown-id", `No annotation with id "${command.id}".`);

			const current = state.annotationRegions[index];
			if (current.type !== "text") {
				return fail("invalid-value", `Annotation "${command.id}" is not a text annotation.`);
			}
			if (command.text !== undefined && command.text.trim() === "") {
				return fail("invalid-value", "A text annotation needs non-empty text.");
			}

			const next: AnnotationRegion = {
				...current,
				// An edit aimed at a specific region is a deliberate change, not a proposal.
				source: "manual",
				startMs: command.startMs ?? current.startMs,
				endMs: command.endMs ?? current.endMs,
				...(command.text !== undefined ? { content: command.text, textContent: command.text } : {}),
				...(command.position ? { position: command.position } : {}),
				style: {
					...current.style,
					...(command.fontSize !== undefined ? { fontSize: command.fontSize } : {}),
					...(command.color ? { color: command.color } : {}),
					...(command.animation ? { textAnimation: command.animation } : {}),
				},
			};

			const invalid = validateSpan(next, durationMs, `Annotation "${command.id}"`);
			if (invalid) return invalid;

			const annotationRegions = [...state.annotationRegions];
			annotationRegions[index] = next;
			return { ...state, annotationRegions };
		}

		case "add_blur": {
			const invalid = validateSpan(command, durationMs, "A blur region");
			if (invalid) return invalid;

			const type = command.style === "blur" ? "blur" : "mosaic";
			const shape = command.shape === "oval" ? "oval" : "rectangle";
			// One 1–100 dial for the agent, mapped onto whichever of the editor's two
			// ranges applies: a gaussian radius or a mosaic block size.
			const strength = clamp(command.strength ?? 50, 1, 100) / 100;
			const intensity = Math.round(
				MIN_BLUR_INTENSITY + strength * (MAX_BLUR_INTENSITY - MIN_BLUR_INTENSITY),
			);
			const blockSize = Math.round(
				MIN_BLUR_BLOCK_SIZE + strength * (MAX_BLUR_BLOCK_SIZE - MIN_BLUR_BLOCK_SIZE),
			);

			const id = newId("annotation");
			createdIds.push(id);
			const zIndex =
				state.annotationRegions.reduce((max, region) => Math.max(max, region.zIndex), 0) + 1;
			const region: AnnotationRegion = {
				id,
				startMs: Math.round(command.startMs),
				endMs: Math.round(command.endMs),
				type: "blur",
				content: "",
				position: command.position ?? DEFAULT_ANNOTATION_POSITION,
				size: command.size ?? DEFAULT_ANNOTATION_SIZE,
				style: DEFAULT_ANNOTATION_STYLE,
				zIndex,
				source: "agent",
				blurData: { ...DEFAULT_BLUR_DATA, type, shape, intensity, blockSize },
			};
			return { ...state, annotationRegions: [...state.annotationRegions, region] };
		}

		case "add_image": {
			const invalid = validateSpan(command, durationMs, "An image annotation");
			if (invalid) return invalid;
			if (typeof command.dataUrl !== "string" || !command.dataUrl.startsWith("data:image/")) {
				return fail("invalid-value", "An image annotation needs an image.");
			}

			const id = newId("annotation");
			createdIds.push(id);
			const zIndex =
				state.annotationRegions.reduce((max, region) => Math.max(max, region.zIndex), 0) + 1;
			const region: AnnotationRegion = {
				id,
				startMs: Math.round(command.startMs),
				endMs: Math.round(command.endMs),
				type: "image",
				content: "",
				imageContent: command.dataUrl,
				position: command.position ?? DEFAULT_ANNOTATION_POSITION,
				size: command.size ?? DEFAULT_ANNOTATION_SIZE,
				style: DEFAULT_ANNOTATION_STYLE,
				zIndex,
				source: "agent",
			};
			return { ...state, annotationRegions: [...state.annotationRegions, region] };
		}

		case "set_webcam": {
			const next = { ...state };

			if (command.layout !== undefined) {
				if (!WEBCAM_LAYOUTS.includes(command.layout)) {
					return fail("invalid-value", `Unknown webcam layout "${command.layout}".`);
				}
				// The editor forbids this pairing and its loader would rewrite it anyway.
				if (command.layout === "dual-frame" && isPortraitAspectRatio(state.aspectRatio)) {
					return fail(
						"invalid-value",
						"The dual-frame layout does not apply to a portrait aspect ratio.",
					);
				}
				next.webcamLayoutPreset = command.layout;
			}
			if (command.shape !== undefined) {
				if (!WEBCAM_SHAPES.includes(command.shape)) {
					return fail("invalid-value", `Unknown webcam shape "${command.shape}".`);
				}
				next.webcamMaskShape = command.shape;
			}
			if (command.sizePercent !== undefined) {
				if (!isFinitePositive(command.sizePercent)) {
					return fail("invalid-value", "Webcam size must be a number.");
				}
				next.webcamSizePreset = clamp(command.sizePercent, 10, 50);
			}
			if (command.position !== undefined) {
				if (command.position === null) {
					next.webcamPosition = null;
				} else if (
					!isFinitePositive(command.position.cx) ||
					!isFinitePositive(command.position.cy)
				) {
					return fail("invalid-value", "Webcam position needs numeric cx and cy.");
				} else {
					next.webcamPosition = {
						cx: clamp(command.position.cx, 0, 1),
						cy: clamp(command.position.cy, 0, 1),
					};
				}
			}
			if (command.mirrored !== undefined) next.webcamMirrored = command.mirrored === true;
			if (command.reactiveZoom !== undefined) {
				next.webcamReactiveZoom = command.reactiveZoom === true;
			}

			// Only the picture-in-picture layout has a free position, matching what
			// the project loader enforces on reload.
			if (next.webcamLayoutPreset !== "picture-in-picture") next.webcamPosition = null;

			return next;
		}

		case "remove_region": {
			const { id } = command;
			if (state.zoomRegions.some((region) => region.id === id)) {
				return { ...state, zoomRegions: state.zoomRegions.filter((region) => region.id !== id) };
			}
			if (state.trimRegions.some((region) => region.id === id)) {
				return { ...state, trimRegions: state.trimRegions.filter((region) => region.id !== id) };
			}
			if (state.speedRegions.some((region) => region.id === id)) {
				return { ...state, speedRegions: state.speedRegions.filter((region) => region.id !== id) };
			}
			if (state.annotationRegions.some((region) => region.id === id)) {
				return {
					...state,
					annotationRegions: state.annotationRegions.filter((region) => region.id !== id),
				};
			}
			return fail("unknown-id", `No region with id "${id}".`);
		}

		case "set_layout": {
			const next = { ...state };
			if (command.padding !== undefined) {
				if (!isFinitePositive(command.padding)) {
					return fail("invalid-value", "Padding must be a number.");
				}
				next.padding = clamp(command.padding, 0, 100);
			}
			if (command.borderRadius !== undefined) {
				if (!isFinitePositive(command.borderRadius)) {
					return fail("invalid-value", "Border radius must be a number.");
				}
				next.borderRadius = clamp(command.borderRadius, 0, 100);
			}
			if (command.shadowIntensity !== undefined) {
				if (!isFinitePositive(command.shadowIntensity)) {
					return fail("invalid-value", "Shadow intensity must be a number.");
				}
				next.shadowIntensity = clamp(command.shadowIntensity, 0, 100);
			}
			if (command.wallpaper !== undefined) {
				if (typeof command.wallpaper !== "string" || command.wallpaper === "") {
					return fail("invalid-value", "Wallpaper must be a non-empty string.");
				}
				next.wallpaper = command.wallpaper;
			}
			return next;
		}

		case "set_cursor": {
			const next = { ...state };
			if (command.visible !== undefined) {
				if (typeof command.visible !== "boolean") {
					return fail("invalid-value", "Cursor visibility must be true or false.");
				}
				next.showCursor = command.visible;
			}
			const numeric: Array<[keyof EditorState, number | undefined, number, number]> = [
				["cursorSize", command.size, MIN_CURSOR_SIZE, MAX_CURSOR_SIZE],
				["cursorSmoothing", command.smoothing, 0, 1],
				["cursorMotionBlur", command.motionBlur, 0, 1],
				["cursorClickBounce", command.clickBounce, 0, MAX_CURSOR_CLICK_BOUNCE],
				["cursorClickRipple", command.clickRipple, 0, 1],
			];
			for (const [key, value, min, max] of numeric) {
				if (value === undefined) continue;
				if (!isFinitePositive(value)) {
					return fail("invalid-value", `${key} must be a number.`);
				}
				(next as Record<string, unknown>)[key] = clamp(value, min, max);
			}
			return next;
		}

		default:
			return fail("unknown-command", `Unknown command: ${(command as { op: string }).op}`);
	}
}

/** Fields a command can touch, so the patch carries only what changed. */
const PATCHABLE_KEYS: Array<keyof EditorState> = [
	"zoomRegions",
	"trimRegions",
	"speedRegions",
	"annotationRegions",
	"padding",
	"borderRadius",
	"shadowIntensity",
	"wallpaper",
	"showCursor",
	"cursorSize",
	"cursorSmoothing",
	"cursorMotionBlur",
	"cursorClickBounce",
	"cursorClickRipple",
	"webcamLayoutPreset",
	"webcamMaskShape",
	"webcamSizePreset",
	"webcamPosition",
	"webcamMirrored",
	"webcamReactiveZoom",
];

/**
 * Runs commands in order against a copy of the state and returns one patch.
 *
 * All or nothing: the first failure aborts and nothing is returned, so a bad
 * command late in a batch cannot leave the project half-edited.
 */
export function applyCommands(
	state: EditorState,
	commands: readonly EditorCommand[],
	durationMs: number,
): CommandOutcome {
	if (!(durationMs > 0)) {
		return fail("no-project", "No recording is loaded, so there is nothing to edit.");
	}
	if (!Array.isArray(commands) || commands.length === 0) {
		return fail("invalid-value", "No commands were given.");
	}

	const createdIds: string[] = [];
	let next = state;

	for (const [index, command] of commands.entries()) {
		const result = applyOne(next, command, durationMs, createdIds);
		if ("ok" in result && result.ok === false) {
			return { ...result, message: `Command ${index + 1} (${command.op}): ${result.message}` };
		}
		next = result as EditorState;
	}

	const patch: Partial<EditorState> = {};
	for (const key of PATCHABLE_KEYS) {
		if (next[key] !== state[key]) {
			(patch as Record<string, unknown>)[key] = next[key];
		}
	}

	return { ok: true, patch, createdIds };
}
