import { normalizeTextAnimation } from "@/lib/annotationTextAnimation";
import { normalizeBlurColor, normalizeBlurType } from "@/lib/blurEffects";
import { normalizeCursorThemeId } from "@/lib/cursor/cursorThemes";
import type { ExportFormat, ExportQuality, GifFrameRate, GifSizePreset } from "@/lib/exporter";
import type { ProjectMedia } from "@/lib/recordingSession";
import { projectMediaList } from "@/lib/recordingSession";
import type { SequenceClipInput } from "@/lib/sequence";
import { DEFAULT_WALLPAPER, WALLPAPER_PATHS } from "@/lib/wallpaper";
import { ASPECT_RATIOS, type AspectRatio, isPortraitAspectRatio } from "@/utils/aspectRatioUtils";
import { type ClipEntry, INITIAL_CLIPS } from "./clips";
import {
	DEFAULT_CURSOR_SETTINGS,
	DEFAULT_EDITOR_APPEARANCE_SETTINGS,
	DEFAULT_EDITOR_LAYOUT_SETTINGS,
	DEFAULT_EXPORT_SETTINGS,
	DEFAULT_GIF_SETTINGS,
	DEFAULT_WEBCAM_SETTINGS,
} from "./editorDefaults";
import {
	type AnnotationRegion,
	type CropRegion,
	clampPlaybackSpeed,
	DEFAULT_ANNOTATION_POSITION,
	DEFAULT_ANNOTATION_SIZE,
	DEFAULT_ANNOTATION_STYLE,
	DEFAULT_BLUR_BLOCK_SIZE,
	DEFAULT_BLUR_DATA,
	DEFAULT_BLUR_FREEHAND_POINTS,
	DEFAULT_BLUR_INTENSITY,
	DEFAULT_FIGURE_DATA,
	DEFAULT_PLAYBACK_SPEED,
	DEFAULT_WEBCAM_MIRRORED,
	DEFAULT_WEBCAM_REACTIVE_ZOOM,
	DEFAULT_ZOOM_DEPTH,
	DEFAULT_ZOOM_MOTION_BLUR,
	MAX_BLUR_BLOCK_SIZE,
	MAX_BLUR_INTENSITY,
	MAX_CURSOR_CLICK_BOUNCE,
	MAX_CURSOR_SIZE,
	MAX_PLAYBACK_SPEED,
	MIN_BLUR_BLOCK_SIZE,
	MIN_BLUR_INTENSITY,
	MIN_CURSOR_SIZE,
	MIN_PLAYBACK_SPEED,
	type RegionSource,
	type SpeedRegion,
	type TrimRegion,
	type WebcamLayoutPreset,
	type WebcamMaskShape,
	type WebcamPosition,
	type WebcamSizePreset,
	type ZoomRegion,
} from "./types";

const VALID_BLUR_SHAPES = new Set(["rectangle", "oval", "freehand"] as const);

// Old projects persisted machine-specific file:// URLs for bundled wallpapers.
// Match only the known install layouts (packaged resources/[assets/]wallpapers,
// dev public/wallpapers) so a user's own file under some "wallpapers" folder isn't
// silently replaced.
const LEGACY_FILE_WALLPAPER_RE =
	/^file:\/\/.*?\/(?:resources\/(?:assets\/)?|public\/)wallpapers\/(wallpaper\d+\.jpg)$/i;
const CANONICAL_WALLPAPERS = new Set(WALLPAPER_PATHS);

function normalizeWallpaperValue(value: string): string {
	const match = LEGACY_FILE_WALLPAPER_RE.exec(value);
	if (!match) return value;
	const canonical = `/wallpapers/${match[1]}`;
	return CANONICAL_WALLPAPERS.has(canonical) ? canonical : DEFAULT_WALLPAPER;
}

/**
 * 1 → single `videoPath`. 2 → explicit `media`. 3 → cursor look (size, smoothing,
 * motion blur, click bounce/ripple, clipping, visibility) moved into the project;
 * before that only `cursorTheme` was saved and the rest reset on every load.
 * 4 → `clips`: the project became a sequence, so media and the edits that address
 * it moved into a per-clip entry and the look of the finished video stayed at the
 * top level. See docs/architecture/multiclip.md.
 *
 * Older projects load fine — `normalizeProjectEditor` fills the gaps with
 * defaults, and anything before 4 reads as a sequence of exactly one clip.
 */
export const PROJECT_VERSION = 4;

/**
 * The parts of the editor state that address one clip's own recording.
 *
 * These are in source time and belong to the clip: move it, and they move with
 * it. Everything else describes the finished video and is shared by every clip —
 * a demo whose background changes at a cut looks broken, not edited.
 */
export const CLIP_EDITOR_KEYS = [
	"cropRegion",
	"zoomRegions",
	"trimRegions",
	"speedRegions",
	"annotationRegions",
] as const;

export type ClipEditorState = Pick<ProjectEditorState, (typeof CLIP_EDITOR_KEYS)[number]>;
/** Held at the top level of the saved file rather than inside `editor`. */
export const TOP_LEVEL_EDITOR_KEYS = ["clips"] as const;

export type SequenceEditorState = Omit<
	ProjectEditorState,
	(typeof CLIP_EDITOR_KEYS)[number] | (typeof TOP_LEVEL_EDITOR_KEYS)[number]
>;

/**
 * One clip in the project, with the edits that address it.
 *
 * Two kinds. A **recording** carries `media` and takes its length from the video
 * file, so nothing about its duration is stored. A **card** carries no media at
 * all — a title slide, an intro or an outro — and so has to say how long it
 * lasts. Its annotations are ordinary annotations, which is the point: text,
 * fonts and animations already work, and a card needs no machinery of its own.
 */
export interface ProjectClipData {
	id: string;
	/** null on a card clip: there is no recording behind it. */
	media: ProjectMedia | null;
	/** Cards only. A recording's length comes from its file, not from the project. */
	durationMs?: number;
	/** Cards only: the line shown on it. */
	title?: string;
	/** Absent on a card, which has nothing to trim, zoom or annotate. */
	editor?: ClipEditorState;
}

/** True for a clip with no recording behind it — a title card, intro or outro. */
export function isCardClip(clip: Pick<ProjectClipData, "media">): boolean {
	return clip.media === null || clip.media === undefined;
}

/** How long a card lasts when the user has not said. */
export const DEFAULT_CARD_DURATION_MS = 3_000;

/** A card is at least long enough to read, and never long enough to be a mistake. */
export const MIN_CARD_DURATION_MS = 200;
export const MAX_CARD_DURATION_MS = 60_000;

export function normalizeCardDurationMs(value: unknown): number {
	if (!isFiniteNumber(value)) return DEFAULT_CARD_DURATION_MS;
	return clamp(Math.round(value), MIN_CARD_DURATION_MS, MAX_CARD_DURATION_MS);
}

export interface ProjectEditorState {
	/** The project's clips in order. Saved at the top level, not inside `editor`. */
	clips: ClipEntry[];
	wallpaper: string;
	shadowIntensity: number;
	showBlur: boolean;
	showTrimWaveform: boolean;
	motionBlurAmount: number;
	borderRadius: number;
	padding: number;
	cropRegion: CropRegion;
	zoomRegions: ZoomRegion[];
	autoZoomEnabled: boolean;
	autoFocusAll: boolean;
	trimRegions: TrimRegion[];
	speedRegions: SpeedRegion[];
	annotationRegions: AnnotationRegion[];
	aspectRatio: AspectRatio;
	webcamLayoutPreset: WebcamLayoutPreset;
	webcamMaskShape: WebcamMaskShape;
	webcamMirrored: boolean;
	webcamReactiveZoom: boolean;
	webcamSizePreset: WebcamSizePreset;
	webcamPosition: WebcamPosition | null;
	exportQuality: ExportQuality;
	exportFormat: ExportFormat;
	gifFrameRate: GifFrameRate;
	gifLoop: boolean;
	gifSizePreset: GifSizePreset;
	cursorTheme: string;
	showCursor: boolean;
	cursorSize: number;
	cursorSmoothing: number;
	cursorMotionBlur: number;
	cursorClickBounce: number;
	cursorClickRipple: number;
	cursorClipToBounds: boolean;
}

export interface EditorProjectData {
	version: number;
	/** Since v4. Older files carry `media` or `videoPath` instead. */
	clips?: ProjectClipData[];
	media?: ProjectMedia;
	/**
	 * From v4 this holds only the settings shared by the whole video; a v3 file's
	 * flat state still satisfies it, with the per-clip keys simply along for the ride
	 * until `resolveProjectEditor` sorts them out.
	 */
	editor: SequenceEditorState;
	videoPath?: string;
}

/** Splits the flat editor state the app works in into its per-clip half and the rest. */
export function splitEditorState(editor: ProjectEditorState): {
	clip: ClipEditorState;
	sequence: SequenceEditorState;
} {
	const clip = {} as Record<string, unknown>;
	const sequence = { ...editor } as Record<string, unknown>;

	for (const key of CLIP_EDITOR_KEYS) {
		clip[key] = editor[key];
		delete sequence[key];
	}
	for (const key of TOP_LEVEL_EDITOR_KEYS) {
		delete sequence[key];
	}

	return { clip: clip as ClipEditorState, sequence: sequence as SequenceEditorState };
}

/** Unknown or missing origins read as "manual", which is how old projects load. */
function normalizeRegionSource(value: unknown): RegionSource {
	return value === "auto" || value === "agent" ? value : "manual";
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function computeNormalizedWebcamLayoutPreset(
	webcamLayoutPreset: Partial<ProjectEditorState>["webcamLayoutPreset"],
	normalizedAspectRatio: AspectRatio,
): WebcamLayoutPreset {
	switch (webcamLayoutPreset) {
		case "picture-in-picture":
		case "no-webcam":
			return webcamLayoutPreset;
		case "vertical-stack":
			return isPortraitAspectRatio(normalizedAspectRatio)
				? webcamLayoutPreset
				: DEFAULT_WEBCAM_SETTINGS.layoutPreset;
		case "dual-frame":
			return isPortraitAspectRatio(normalizedAspectRatio)
				? DEFAULT_WEBCAM_SETTINGS.layoutPreset
				: webcamLayoutPreset;
		default:
			return DEFAULT_WEBCAM_SETTINGS.layoutPreset;
	}
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function encodePathSegments(pathname: string, keepWindowsDrive = false): string {
	return pathname
		.split("/")
		.map((segment, index) => {
			if (!segment) {
				return segment;
			}
			if (keepWindowsDrive && index === 0 && /^[a-zA-Z]:$/.test(segment)) {
				return segment;
			}
			return encodeURIComponent(segment);
		})
		.join("/");
}

export function toFileUrl(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	if (normalized.match(/^[a-zA-Z]:/)) {
		return `file:///${encodePathSegments(normalized, true)}`;
	}
	if (normalized.startsWith("//")) {
		const withoutPrefix = normalized.slice(2);
		const [host = "", ...segments] = withoutPrefix.split("/");
		return `file://${host}/${encodePathSegments(segments.join("/"))}`;
	}
	const absolutePath = normalized.startsWith("/") ? normalized : `/${normalized}`;
	return `file://${encodePathSegments(absolutePath)}`;
}

export function fromFileUrl(fileUrl: string): string {
	if (!fileUrl.startsWith("file://")) {
		return fileUrl;
	}

	try {
		const url = new URL(fileUrl);
		const pathname = decodeURIComponent(url.pathname);

		if (url.host && url.host !== "localhost") {
			return `//${url.host}${pathname}`;
		}

		if (/^\/[a-zA-Z]:/.test(pathname)) {
			return pathname.slice(1);
		}

		return pathname;
	} catch {
		const fallbackPath = decodeURIComponent(fileUrl.replace(/^file:\/\//, ""));
		return fallbackPath.replace(/^\/([a-zA-Z]:)/, "$1");
	}
}

export function deriveNextId(prefix: string, ids: string[]): number {
	const max = ids.reduce((acc, id) => {
		const match = id.match(new RegExp(`^${prefix}-(\\d+)$`));
		if (!match) return acc;
		const value = Number(match[1]);
		return Number.isFinite(value) ? Math.max(acc, value) : acc;
	}, 0);
	return max + 1;
}

/**
 * Turns the project's clips into what the sequence needs to lay them out.
 *
 * A card knows its own length; a recording's comes from its video file, which
 * the project never stores and only the loaded editor knows — hence the lookup
 * rather than a field. A recording whose duration is not known yet contributes
 * nothing, which is what the timeline should show while it loads.
 */
export function sequenceInputsFromClips(
	clips: readonly ProjectClipData[],
	recordingDurationMs: (clip: ProjectClipData) => number,
): SequenceClipInput[] {
	return clips.map((clip) => {
		if (isCardClip(clip)) {
			// A card has nothing to trim or speed up: it is one still moment.
			return { id: clip.id, sourceDurationMs: normalizeCardDurationMs(clip.durationMs) };
		}

		const durationMs = recordingDurationMs(clip);
		return {
			id: clip.id,
			sourceDurationMs: isFiniteNumber(durationMs) ? Math.max(0, durationMs) : 0,
			trimRegions: clip.editor?.trimRegions,
			speedRegions: clip.editor?.speedRegions,
		};
	});
}

export function validateProjectData(candidate: unknown): candidate is EditorProjectData {
	if (!candidate || typeof candidate !== "object") return false;
	const project = candidate as Partial<EditorProjectData>;
	if (typeof project.version !== "number") return false;
	if (!resolveProjectMedia(project)) return false;
	if (!project.editor || typeof project.editor !== "object") return false;
	return true;
}

export function resolveProjectMedia(
	candidate: Partial<EditorProjectData> | { media?: unknown; videoPath?: unknown },
): ProjectMedia | null {
	// The editor still shows one recording at a time, so this answers with the
	// first clip. Reading every format lives in projectMediaList, which the main
	// process shares — the two must never disagree about what a project points at.
	return projectMediaList(candidate)[0] ?? null;
}

/**
 * The flat editor state the app works in, assembled from however the file stored it.
 *
 * From v4 that means folding the open clip's own edits back together with the
 * settings that belong to the whole video; older files already have them in one
 * object.
 */
/**
 * The clip list as the editor holds it. Anything older than v4 is one recording.
 *
 * A file with no recording at all would leave the editor with nowhere to put the
 * video it has open, so the recording is put back if the file somehow lacks one.
 */
export function resolveProjectClips(candidate: Partial<EditorProjectData>): ClipEntry[] {
	const stored = candidate.clips;
	if (!Array.isArray(stored) || stored.length === 0) return [...INITIAL_CLIPS];

	const clips: ClipEntry[] = stored.map((clip) =>
		isCardClip(clip)
			? {
					id: String(clip.id),
					kind: "card",
					durationMs: normalizeCardDurationMs(clip.durationMs),
					...(typeof clip.title === "string" ? { title: clip.title } : {}),
				}
			: { id: String(clip.id), kind: "recording" },
	);

	return clips.some((clip) => clip.kind === "recording") ? clips : [...INITIAL_CLIPS, ...clips];
}

export function resolveProjectEditor(candidate: Partial<EditorProjectData>): ProjectEditorState {
	const sequence = (candidate.editor ?? {}) as Partial<ProjectEditorState>;
	// The recording's own edits, which is not necessarily the first clip: a project
	// that opens with an intro card has one before it.
	const clipEditor = candidate.clips?.find((clip) => !isCardClip(clip))?.editor;
	const clips = resolveProjectClips(candidate);
	return normalizeProjectEditor({ ...sequence, ...(clipEditor ?? {}), clips });
}

/**
 * Defensive pass over the clip list. A project with no recording in it would
 * leave the editor's open video with nowhere to sit, so one is put back.
 */
function normalizeClipEntries(value: unknown): ClipEntry[] {
	if (!Array.isArray(value) || value.length === 0) return [...INITIAL_CLIPS];

	const clips: ClipEntry[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const clip = entry as Partial<ClipEntry>;
		if (typeof clip.id !== "string" || !clip.id) continue;

		clips.push(
			clip.kind === "card"
				? {
						id: clip.id,
						kind: "card",
						durationMs: normalizeCardDurationMs(clip.durationMs),
						...(typeof clip.title === "string" ? { title: clip.title } : {}),
					}
				: { id: clip.id, kind: "recording" },
		);
	}

	if (clips.length === 0) return [...INITIAL_CLIPS];
	return clips.some((clip) => clip.kind === "recording") ? clips : [...INITIAL_CLIPS, ...clips];
}

export function normalizeProjectEditor(editor: Partial<ProjectEditorState>): ProjectEditorState {
	const validAspectRatios = new Set<AspectRatio>(ASPECT_RATIOS);
	const normalizedAspectRatio: AspectRatio = validAspectRatios.has(
		editor.aspectRatio as AspectRatio,
	)
		? (editor.aspectRatio as AspectRatio)
		: DEFAULT_EDITOR_LAYOUT_SETTINGS.aspectRatio;
	const normalizedWebcamLayoutPreset = computeNormalizedWebcamLayoutPreset(
		editor.webcamLayoutPreset,
		normalizedAspectRatio,
	);
	const normalizedWebcamPosition: WebcamPosition | null =
		normalizedWebcamLayoutPreset === "picture-in-picture" &&
		editor.webcamPosition &&
		typeof editor.webcamPosition === "object" &&
		isFiniteNumber((editor.webcamPosition as WebcamPosition).cx) &&
		isFiniteNumber((editor.webcamPosition as WebcamPosition).cy)
			? {
					cx: clamp((editor.webcamPosition as WebcamPosition).cx, 0, 1),
					cy: clamp((editor.webcamPosition as WebcamPosition).cy, 0, 1),
				}
			: DEFAULT_WEBCAM_SETTINGS.position;

	const normalizedZoomRegions: ZoomRegion[] = Array.isArray(editor.zoomRegions)
		? editor.zoomRegions
				.filter((region): region is ZoomRegion => Boolean(region && typeof region.id === "string"))
				.map((region) => {
					const rawStart = isFiniteNumber(region.startMs) ? Math.round(region.startMs) : 0;
					const rawEnd = isFiniteNumber(region.endMs) ? Math.round(region.endMs) : rawStart + 1000;
					const startMs = Math.max(0, Math.min(rawStart, rawEnd));
					const endMs = Math.max(startMs + 1, rawEnd);

					const validPreset =
						region.rotationPreset === "iso" ||
						region.rotationPreset === "left" ||
						region.rotationPreset === "right"
							? region.rotationPreset
							: undefined;
					return {
						id: region.id,
						startMs,
						endMs,
						depth: [1, 2, 3, 4, 5, 6].includes(region.depth) ? region.depth : DEFAULT_ZOOM_DEPTH,
						focus: {
							cx: clamp(isFiniteNumber(region.focus?.cx) ? region.focus.cx : 0.5, 0, 1),
							cy: clamp(isFiniteNumber(region.focus?.cy) ? region.focus.cy : 0.5, 0, 1),
						},
						focusMode: region.focusMode === "auto" ? "auto" : "manual",
						source: normalizeRegionSource(region.source),
						...(validPreset ? { rotationPreset: validPreset } : {}),
					};
				})
		: [];

	const normalizedTrimRegions: TrimRegion[] = Array.isArray(editor.trimRegions)
		? editor.trimRegions
				.filter((region): region is TrimRegion => Boolean(region && typeof region.id === "string"))
				.map((region) => {
					const rawStart = isFiniteNumber(region.startMs) ? Math.round(region.startMs) : 0;
					const rawEnd = isFiniteNumber(region.endMs) ? Math.round(region.endMs) : rawStart + 1000;
					const startMs = Math.max(0, Math.min(rawStart, rawEnd));
					const endMs = Math.max(startMs + 1, rawEnd);
					return {
						id: region.id,
						startMs,
						endMs,
						source: normalizeRegionSource(region.source),
					};
				})
		: [];

	const normalizedSpeedRegions: SpeedRegion[] = Array.isArray(editor.speedRegions)
		? editor.speedRegions
				.filter((region): region is SpeedRegion => Boolean(region && typeof region.id === "string"))
				.map((region) => {
					const rawStart = isFiniteNumber(region.startMs) ? Math.round(region.startMs) : 0;
					const rawEnd = isFiniteNumber(region.endMs) ? Math.round(region.endMs) : rawStart + 1000;
					const startMs = Math.max(0, Math.min(rawStart, rawEnd));
					const endMs = Math.max(startMs + 1, rawEnd);

					const speed =
						isFiniteNumber(region.speed) &&
						region.speed >= MIN_PLAYBACK_SPEED &&
						region.speed <= MAX_PLAYBACK_SPEED
							? clampPlaybackSpeed(region.speed)
							: DEFAULT_PLAYBACK_SPEED;

					return {
						id: region.id,
						startMs,
						endMs,
						speed,
						source: normalizeRegionSource(region.source),
					};
				})
		: [];

	const normalizedAnnotationRegions: AnnotationRegion[] = Array.isArray(editor.annotationRegions)
		? editor.annotationRegions
				.filter((region): region is AnnotationRegion =>
					Boolean(region && typeof region.id === "string"),
				)
				.map((region, index) => {
					const rawStart = isFiniteNumber(region.startMs) ? Math.round(region.startMs) : 0;
					const rawEnd = isFiniteNumber(region.endMs) ? Math.round(region.endMs) : rawStart + 1000;
					const startMs = Math.max(0, Math.min(rawStart, rawEnd));
					const endMs = Math.max(startMs + 1, rawEnd);
					const blurShape =
						typeof region.blurData?.shape === "string" &&
						VALID_BLUR_SHAPES.has(region.blurData.shape)
							? region.blurData.shape
							: DEFAULT_BLUR_DATA.shape;
					const blurType = normalizeBlurType(region.blurData?.type);
					const blurColor = normalizeBlurColor(region.blurData?.color);

					return {
						id: region.id,
						startMs,
						endMs,
						type:
							region.type === "image" || region.type === "figure" || region.type === "blur"
								? region.type
								: "text",
						content: typeof region.content === "string" ? region.content : "",
						textContent: typeof region.textContent === "string" ? region.textContent : undefined,
						imageContent: typeof region.imageContent === "string" ? region.imageContent : undefined,
						annotationSource:
							region.annotationSource === "auto-caption" ? ("auto-caption" as const) : undefined,
						source: normalizeRegionSource(region.source),
						position: {
							x: clamp(
								isFiniteNumber(region.position?.x)
									? region.position.x
									: DEFAULT_ANNOTATION_POSITION.x,
								0,
								100,
							),
							y: clamp(
								isFiniteNumber(region.position?.y)
									? region.position.y
									: DEFAULT_ANNOTATION_POSITION.y,
								0,
								100,
							),
						},
						size: {
							width: clamp(
								isFiniteNumber(region.size?.width)
									? region.size.width
									: DEFAULT_ANNOTATION_SIZE.width,
								1,
								200,
							),
							height: clamp(
								isFiniteNumber(region.size?.height)
									? region.size.height
									: DEFAULT_ANNOTATION_SIZE.height,
								1,
								200,
							),
						},
						style: {
							...DEFAULT_ANNOTATION_STYLE,
							...(region.style && typeof region.style === "object" ? region.style : {}),
							textAnimation: normalizeTextAnimation(region.style?.textAnimation),
						},
						zIndex: isFiniteNumber(region.zIndex) ? region.zIndex : index + 1,
						figureData: region.figureData
							? {
									...DEFAULT_FIGURE_DATA,
									...region.figureData,
								}
							: undefined,
						blurData:
							region.blurData && typeof region.blurData === "object"
								? {
										...DEFAULT_BLUR_DATA,
										...region.blurData,
										type: blurType,
										shape: blurShape,
										color: blurColor,
										intensity: isFiniteNumber(region.blurData.intensity)
											? clamp(region.blurData.intensity, MIN_BLUR_INTENSITY, MAX_BLUR_INTENSITY)
											: DEFAULT_BLUR_INTENSITY,
										blockSize: isFiniteNumber(region.blurData.blockSize)
											? clamp(region.blurData.blockSize, MIN_BLUR_BLOCK_SIZE, MAX_BLUR_BLOCK_SIZE)
											: DEFAULT_BLUR_BLOCK_SIZE,
										freehandPoints: Array.isArray(region.blurData.freehandPoints)
											? region.blurData.freehandPoints
													.filter(
														(
															point,
														): point is {
															x: number;
															y: number;
														} =>
															Boolean(
																point &&
																	isFiniteNumber((point as { x?: unknown }).x) &&
																	isFiniteNumber((point as { y?: unknown }).y),
															),
													)
													.map((point) => ({
														x: clamp(point.x, 0, 100),
														y: clamp(point.y, 0, 100),
													}))
											: DEFAULT_BLUR_FREEHAND_POINTS,
									}
								: undefined,
					};
				})
		: [];

	const rawCropX = isFiniteNumber(editor.cropRegion?.x)
		? editor.cropRegion.x
		: DEFAULT_EDITOR_LAYOUT_SETTINGS.cropRegion.x;
	const rawCropY = isFiniteNumber(editor.cropRegion?.y)
		? editor.cropRegion.y
		: DEFAULT_EDITOR_LAYOUT_SETTINGS.cropRegion.y;
	const rawCropWidth = isFiniteNumber(editor.cropRegion?.width)
		? editor.cropRegion.width
		: DEFAULT_EDITOR_LAYOUT_SETTINGS.cropRegion.width;
	const rawCropHeight = isFiniteNumber(editor.cropRegion?.height)
		? editor.cropRegion.height
		: DEFAULT_EDITOR_LAYOUT_SETTINGS.cropRegion.height;

	const cropX = clamp(rawCropX, 0, 1);
	const cropY = clamp(rawCropY, 0, 1);
	const cropWidth = clamp(rawCropWidth, 0.01, 1 - cropX);
	const cropHeight = clamp(rawCropHeight, 0.01, 1 - cropY);

	// Cursor look moved into the project in version 3. Version 2 projects carry only
	// cursorTheme, so every other knob falls back to its default here.
	const normalizedCursor = {
		cursorTheme: normalizeCursorThemeId(editor.cursorTheme),
		showCursor:
			typeof editor.showCursor === "boolean" ? editor.showCursor : DEFAULT_CURSOR_SETTINGS.show,
		cursorSize: isFiniteNumber(editor.cursorSize)
			? clamp(editor.cursorSize, MIN_CURSOR_SIZE, MAX_CURSOR_SIZE)
			: DEFAULT_CURSOR_SETTINGS.size,
		cursorSmoothing: isFiniteNumber(editor.cursorSmoothing)
			? clamp(editor.cursorSmoothing, 0, 1)
			: DEFAULT_CURSOR_SETTINGS.smoothing,
		cursorMotionBlur: isFiniteNumber(editor.cursorMotionBlur)
			? clamp(editor.cursorMotionBlur, 0, 1)
			: DEFAULT_CURSOR_SETTINGS.motionBlur,
		cursorClickBounce: isFiniteNumber(editor.cursorClickBounce)
			? clamp(editor.cursorClickBounce, 0, MAX_CURSOR_CLICK_BOUNCE)
			: DEFAULT_CURSOR_SETTINGS.clickBounce,
		cursorClickRipple: isFiniteNumber(editor.cursorClickRipple)
			? clamp(editor.cursorClickRipple, 0, 1)
			: DEFAULT_CURSOR_SETTINGS.clickRipple,
		cursorClipToBounds:
			typeof editor.cursorClipToBounds === "boolean"
				? editor.cursorClipToBounds
				: DEFAULT_CURSOR_SETTINGS.clipToBounds,
	};

	return {
		...normalizedCursor,
		clips: normalizeClipEntries(editor.clips),
		wallpaper:
			typeof editor.wallpaper === "string"
				? normalizeWallpaperValue(editor.wallpaper)
				: DEFAULT_EDITOR_LAYOUT_SETTINGS.wallpaper,
		shadowIntensity:
			typeof editor.shadowIntensity === "number"
				? editor.shadowIntensity
				: DEFAULT_EDITOR_APPEARANCE_SETTINGS.shadowIntensity,
		showBlur:
			typeof editor.showBlur === "boolean"
				? editor.showBlur
				: DEFAULT_EDITOR_APPEARANCE_SETTINGS.showBlur,
		showTrimWaveform:
			typeof editor.showTrimWaveform === "boolean"
				? editor.showTrimWaveform
				: DEFAULT_EDITOR_APPEARANCE_SETTINGS.showTrimWaveform,
		motionBlurAmount: isFiniteNumber(editor.motionBlurAmount)
			? clamp(editor.motionBlurAmount, 0, 1)
			: typeof (editor as { motionBlurEnabled?: unknown }).motionBlurEnabled === "boolean"
				? (editor as { motionBlurEnabled?: boolean }).motionBlurEnabled
					? DEFAULT_ZOOM_MOTION_BLUR
					: DEFAULT_EDITOR_APPEARANCE_SETTINGS.motionBlurAmount
				: DEFAULT_EDITOR_APPEARANCE_SETTINGS.motionBlurAmount,
		borderRadius:
			typeof editor.borderRadius === "number"
				? editor.borderRadius
				: DEFAULT_EDITOR_APPEARANCE_SETTINGS.borderRadius,
		padding: isFiniteNumber(editor.padding)
			? clamp(editor.padding, 0, 100)
			: DEFAULT_EDITOR_LAYOUT_SETTINGS.padding,
		cropRegion: {
			x: cropX,
			y: cropY,
			width: cropWidth,
			height: cropHeight,
		},
		zoomRegions: normalizedZoomRegions,
		// Default on for legacy projects so re-opens match the new default. The
		// on-load auto-suggest pass is gated separately, so this won't add zooms.
		autoZoomEnabled: typeof editor.autoZoomEnabled === "boolean" ? editor.autoZoomEnabled : true,
		autoFocusAll: typeof editor.autoFocusAll === "boolean" ? editor.autoFocusAll : false,
		trimRegions: normalizedTrimRegions,
		speedRegions: normalizedSpeedRegions,
		annotationRegions: normalizedAnnotationRegions,
		aspectRatio: normalizedAspectRatio,
		webcamLayoutPreset: normalizedWebcamLayoutPreset,
		webcamMaskShape:
			editor.webcamMaskShape === "rectangle" ||
			editor.webcamMaskShape === "circle" ||
			editor.webcamMaskShape === "square" ||
			editor.webcamMaskShape === "rounded"
				? editor.webcamMaskShape
				: DEFAULT_WEBCAM_SETTINGS.maskShape,
		webcamMirrored:
			typeof editor.webcamMirrored === "boolean" ? editor.webcamMirrored : DEFAULT_WEBCAM_MIRRORED,
		webcamReactiveZoom:
			typeof editor.webcamReactiveZoom === "boolean"
				? editor.webcamReactiveZoom
				: DEFAULT_WEBCAM_REACTIVE_ZOOM,
		webcamSizePreset:
			typeof editor.webcamSizePreset === "number" && isFiniteNumber(editor.webcamSizePreset)
				? Math.max(10, Math.min(50, editor.webcamSizePreset))
				: DEFAULT_WEBCAM_SETTINGS.sizePreset,
		webcamPosition: normalizedWebcamPosition,
		exportQuality:
			editor.exportQuality === "medium" || editor.exportQuality === "source"
				? editor.exportQuality
				: DEFAULT_EXPORT_SETTINGS.quality,
		exportFormat: editor.exportFormat === "gif" ? "gif" : DEFAULT_EXPORT_SETTINGS.format,
		gifFrameRate:
			editor.gifFrameRate === 15 ||
			editor.gifFrameRate === 20 ||
			editor.gifFrameRate === 25 ||
			editor.gifFrameRate === 30
				? editor.gifFrameRate
				: DEFAULT_GIF_SETTINGS.frameRate,
		gifLoop: typeof editor.gifLoop === "boolean" ? editor.gifLoop : DEFAULT_GIF_SETTINGS.loop,
		gifSizePreset:
			editor.gifSizePreset === "medium" ||
			editor.gifSizePreset === "large" ||
			editor.gifSizePreset === "original"
				? editor.gifSizePreset
				: DEFAULT_GIF_SETTINGS.sizePreset,
	};
}

export function createProjectData(
	media: ProjectMedia,
	editor: ProjectEditorState,
): EditorProjectData {
	const { clip, sequence } = splitEditorState(editor);
	const entries = editor.clips?.length ? editor.clips : INITIAL_CLIPS;

	return {
		version: PROJECT_VERSION,
		// The recording's edits are the flat state the editor was working in; a card
		// has none, only how long it lasts and what it says.
		clips: entries.map((entry) =>
			entry.kind === "card"
				? {
						id: entry.id,
						media: null,
						durationMs: normalizeCardDurationMs(entry.durationMs),
						...(entry.title === undefined ? {} : { title: entry.title }),
					}
				: { id: entry.id, media, editor: clip },
		),
		editor: sequence,
	};
}

export function createProjectSnapshot(
	media: ProjectMedia,
	editor: Partial<ProjectEditorState>,
): string {
	return JSON.stringify(createProjectData(media, normalizeProjectEditor(editor)));
}

export function hasProjectUnsavedChanges(
	currentSnapshot: string | null,
	baselineSnapshot: string | null,
): boolean {
	return Boolean(
		currentSnapshot !== null && baselineSnapshot !== null && currentSnapshot !== baselineSnapshot,
	);
}
