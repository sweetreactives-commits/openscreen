import { describe, expect, it } from "vitest";
import { projectMediaList } from "@/lib/recordingSession";
import { computeSequence } from "@/lib/sequence";
import { addIntroCard, addOutroCard, INITIAL_CLIPS, moveClip, updateCard } from "./clips";
import { DEFAULT_CURSOR_SETTINGS } from "./editorDefaults";
import {
	CLIP_EDITOR_KEYS,
	createProjectData,
	createProjectSnapshot,
	DEFAULT_CARD_DURATION_MS,
	hasProjectUnsavedChanges,
	isCardClip,
	MAX_CARD_DURATION_MS,
	MIN_CARD_DURATION_MS,
	normalizeCardDurationMs,
	normalizeProjectEditor,
	PROJECT_VERSION,
	type ProjectClipData,
	resolveProjectClips,
	resolveProjectEditor,
	resolveProjectMedia,
	sequenceInputsFromClips,
	splitEditorState,
	TOP_LEVEL_EDITOR_KEYS,
	validateProjectData,
} from "./projectPersistence";
import { MAX_CURSOR_CLICK_BOUNCE, MAX_CURSOR_SIZE, MIN_CURSOR_SIZE } from "./types";

describe("projectPersistence media compatibility", () => {
	it("accepts legacy projects with a single videoPath", () => {
		const project = {
			version: 1,
			videoPath: "/tmp/screen.webm",
			editor: {},
		};

		expect(validateProjectData(project)).toBe(true);
		expect(resolveProjectMedia(project)).toEqual({
			screenVideoPath: "/tmp/screen.webm",
		});
	});

	it("writes the current format: media lives on a clip, not at the top level", () => {
		const project = createProjectData(
			{
				screenVideoPath: "/tmp/screen.webm",
				webcamVideoPath: "/tmp/webcam.webm",
			},
			{
				wallpaper: "/wallpapers/wallpaper1.jpg",
				shadowIntensity: 0,
				showBlur: false,
				motionBlurAmount: 0,
				borderRadius: 0,
				padding: 50,
				cropRegion: { x: 0, y: 0, width: 1, height: 1 },
				zoomRegions: [],
				trimRegions: [],
				speedRegions: [],
				annotationRegions: [],
				aspectRatio: "16:9",
				webcamLayoutPreset: "picture-in-picture",
				webcamMaskShape: "circle",
				webcamMirrored: true,
				webcamSizePreset: 25,
				webcamPosition: null,
				exportQuality: "good",
				exportFormat: "mp4",
				gifFrameRate: 15,
				gifLoop: true,
				gifSizePreset: "medium",
			},
		);

		expect(project.version).toBe(PROJECT_VERSION);
		expect(project.clips).toHaveLength(1);
		expect(project.clips?.[0].media).toEqual({
			screenVideoPath: "/tmp/screen.webm",
			webcamVideoPath: "/tmp/webcam.webm",
		});
		// The regions went with the clip; the look of the video stayed shared.
		expect(project.clips?.[0].editor.zoomRegions).toEqual([]);
		expect(project.editor.wallpaper).toBe("/wallpapers/wallpaper1.jpg");
		expect(project.editor).not.toHaveProperty("zoomRegions");
		// And it is still found by everything that asks a project what it points at.
		expect(validateProjectData(project)).toBe(true);
		expect(resolveProjectMedia(project)).toEqual({
			screenVideoPath: "/tmp/screen.webm",
			webcamVideoPath: "/tmp/webcam.webm",
		});
	});

	it("normalizes webcam mask shape values safely", () => {
		expect(normalizeProjectEditor({ webcamMaskShape: "rounded" }).webcamMaskShape).toBe("rounded");
		expect(
			normalizeProjectEditor({ webcamMaskShape: "not-a-real-shape" as never }).webcamMaskShape,
		).toBe("rectangle");
	});

	it("normalizes webcam mirroring safely", () => {
		expect(normalizeProjectEditor({ webcamMirrored: true }).webcamMirrored).toBe(true);
		expect(normalizeProjectEditor({ webcamMirrored: false }).webcamMirrored).toBe(false);
		expect(normalizeProjectEditor({ webcamMirrored: "yes" as never }).webcamMirrored).toBe(false);
	});

	it("normalizes blur region type and mosaic block size safely", () => {
		const editor = normalizeProjectEditor({
			annotationRegions: [
				{
					id: "annotation-1",
					startMs: 0,
					endMs: 500,
					type: "blur",
					content: "",
					position: { x: 10, y: 10 },
					size: { width: 20, height: 20 },
					style: {
						color: "#fff",
						backgroundColor: "transparent",
						fontSize: 32,
						fontFamily: "Inter",
						fontWeight: "bold",
						fontStyle: "normal",
						textDecoration: "none",
						textAlign: "center",
					},
					zIndex: 1,
					blurData: {
						type: "mosaic",
						shape: "rectangle",
						color: "black",
						intensity: 999,
						blockSize: 999,
					},
				},
				{
					id: "annotation-2",
					startMs: 0,
					endMs: 500,
					type: "blur",
					content: "",
					position: { x: 10, y: 10 },
					size: { width: 20, height: 20 },
					style: {
						color: "#fff",
						backgroundColor: "transparent",
						fontSize: 32,
						fontFamily: "Inter",
						fontWeight: "bold",
						fontStyle: "normal",
						textDecoration: "none",
						textAlign: "center",
					},
					zIndex: 2,
					blurData: {
						type: "invalid" as never,
						shape: "rectangle",
						color: "invalid" as never,
						intensity: 10,
						blockSize: 0,
					},
				},
			],
		});

		expect(editor.annotationRegions[0].blurData?.type).toBe("mosaic");
		expect(editor.annotationRegions[0].blurData?.color).toBe("black");
		expect(editor.annotationRegions[0].blurData?.intensity).toBe(40);
		expect(editor.annotationRegions[0].blurData?.blockSize).toBe(48);
		expect(editor.annotationRegions[1].blurData?.type).toBe("mosaic");
		expect(editor.annotationRegions[1].blurData?.color).toBe("white");
		expect(editor.annotationRegions[1].blurData?.blockSize).toBe(4);
	});

	it("accepts the dual frame webcam layout preset", () => {
		expect(normalizeProjectEditor({ webcamLayoutPreset: "dual-frame" }).webcamLayoutPreset).toBe(
			"dual-frame",
		);
	});

	it("falls back from dual frame to picture in picture for portrait aspect ratios", () => {
		expect(
			normalizeProjectEditor({
				aspectRatio: "9:16",
				webcamLayoutPreset: "dual-frame",
			}).webcamLayoutPreset,
		).toBe("picture-in-picture");
	});

	it("clears webcamPosition when the normalized preset is not picture in picture", () => {
		expect(
			normalizeProjectEditor({
				webcamLayoutPreset: "dual-frame",
				webcamPosition: { cx: 0.2, cy: 0.8 },
			}).webcamPosition,
		).toBeNull();
	});
});

it("creates stable snapshots for identical project state", () => {
	const media = {
		screenVideoPath: "/tmp/screen.webm",
		webcamVideoPath: "/tmp/webcam.webm",
	};
	const editor = normalizeProjectEditor({
		wallpaper: "/wallpapers/wallpaper1.jpg",
		shadowIntensity: 0,
		showBlur: false,
		motionBlurAmount: 0,
		borderRadius: 0,
		padding: 50,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		zoomRegions: [],
		trimRegions: [],
		speedRegions: [],
		annotationRegions: [],
		aspectRatio: "16:9",
		webcamLayoutPreset: "picture-in-picture",
		webcamMaskShape: "circle",
		exportQuality: "good",
		exportFormat: "mp4",
		gifFrameRate: 15,
		gifLoop: true,
		gifSizePreset: "medium",
	});

	expect(createProjectSnapshot(media, editor)).toBe(createProjectSnapshot(media, editor));
});

it("detects unsaved changes from differing snapshots", () => {
	expect(hasProjectUnsavedChanges(null, null)).toBe(false);
	expect(hasProjectUnsavedChanges("same", "same")).toBe(false);
	expect(hasProjectUnsavedChanges("current", "baseline")).toBe(true);
});

describe("zoom region source normalization", () => {
	const zoom = (source?: unknown) => ({
		zoomRegions: [
			{ id: "zoom-1", startMs: 0, endMs: 1000, depth: 3, focus: { cx: 0.5, cy: 0.5 }, source },
		],
	});

	it("keeps wand-suggested zooms marked auto", () => {
		expect(normalizeProjectEditor(zoom("auto")).zoomRegions[0].source).toBe("auto");
	});

	it("keeps agent-proposed zooms marked agent", () => {
		expect(normalizeProjectEditor(zoom("agent")).zoomRegions[0].source).toBe("agent");
	});

	it("treats a missing source as manual, for projects saved before the field existed", () => {
		expect(normalizeProjectEditor(zoom(undefined)).zoomRegions[0].source).toBe("manual");
	});

	it("falls back to manual for unknown values", () => {
		expect(normalizeProjectEditor(zoom("something-else")).zoomRegions[0].source).toBe("manual");
	});
});

describe("cursor look normalization (project version 3)", () => {
	it("fills cursor defaults for version 2 projects, which only stored the theme", () => {
		const normalized = normalizeProjectEditor({ cursorTheme: "system" });

		expect(normalized.showCursor).toBe(DEFAULT_CURSOR_SETTINGS.show);
		expect(normalized.cursorSize).toBe(DEFAULT_CURSOR_SETTINGS.size);
		expect(normalized.cursorSmoothing).toBe(DEFAULT_CURSOR_SETTINGS.smoothing);
		expect(normalized.cursorMotionBlur).toBe(DEFAULT_CURSOR_SETTINGS.motionBlur);
		expect(normalized.cursorClickBounce).toBe(DEFAULT_CURSOR_SETTINGS.clickBounce);
		expect(normalized.cursorClickRipple).toBe(DEFAULT_CURSOR_SETTINGS.clickRipple);
		expect(normalized.cursorClipToBounds).toBe(DEFAULT_CURSOR_SETTINGS.clipToBounds);
	});

	it("round-trips a saved cursor look", () => {
		const normalized = normalizeProjectEditor({
			showCursor: false,
			cursorSize: 4.2,
			cursorSmoothing: 0.8,
			cursorMotionBlur: 0.1,
			cursorClickBounce: 3,
			cursorClickRipple: 0.25,
			cursorClipToBounds: true,
		});

		expect(normalized.showCursor).toBe(false);
		expect(normalized.cursorSize).toBe(4.2);
		expect(normalized.cursorSmoothing).toBe(0.8);
		expect(normalized.cursorMotionBlur).toBe(0.1);
		expect(normalized.cursorClickBounce).toBe(3);
		expect(normalized.cursorClickRipple).toBe(0.25);
		expect(normalized.cursorClipToBounds).toBe(true);
	});

	it("clamps out-of-range numbers to the slider bounds", () => {
		const tooHigh = normalizeProjectEditor({
			cursorSize: 999,
			cursorSmoothing: 5,
			cursorMotionBlur: 5,
			cursorClickBounce: 999,
			cursorClickRipple: 5,
		});
		expect(tooHigh.cursorSize).toBe(MAX_CURSOR_SIZE);
		expect(tooHigh.cursorSmoothing).toBe(1);
		expect(tooHigh.cursorMotionBlur).toBe(1);
		expect(tooHigh.cursorClickBounce).toBe(MAX_CURSOR_CLICK_BOUNCE);
		expect(tooHigh.cursorClickRipple).toBe(1);

		const tooLow = normalizeProjectEditor({
			cursorSize: -3,
			cursorSmoothing: -1,
			cursorClickBounce: -1,
		});
		expect(tooLow.cursorSize).toBe(MIN_CURSOR_SIZE);
		expect(tooLow.cursorSmoothing).toBe(0);
		expect(tooLow.cursorClickBounce).toBe(0);
	});

	it("falls back to defaults for non-numeric and non-boolean junk", () => {
		const normalized = normalizeProjectEditor({
			showCursor: "yes" as never,
			cursorSize: Number.NaN,
			cursorClipToBounds: 1 as never,
		});

		expect(normalized.showCursor).toBe(DEFAULT_CURSOR_SETTINGS.show);
		expect(normalized.cursorSize).toBe(DEFAULT_CURSOR_SETTINGS.size);
		expect(normalized.cursorClipToBounds).toBe(DEFAULT_CURSOR_SETTINGS.clipToBounds);
	});
});

describe("wallpaper legacy normalization", () => {
	it("rewrites pre-fix packaged paths (resources/assets/wallpapers/…)", () => {
		const normalized = normalizeProjectEditor({
			wallpaper: "file:///opt/Openscreen/resources/assets/wallpapers/wallpaper5.jpg",
		});
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper5.jpg");
	});

	it("rewrites new packaged layout (resources/wallpapers/…)", () => {
		const normalized = normalizeProjectEditor({
			wallpaper: "file:///opt/Openscreen/resources/wallpapers/wallpaper3.jpg",
		});
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper3.jpg");
	});

	it("rewrites unpackaged dev layout (public/wallpapers/…)", () => {
		const normalized = normalizeProjectEditor({
			wallpaper: "file:///home/user/project/public/wallpapers/wallpaper1.jpg",
		});
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper1.jpg");
	});

	it("rewrites Windows-style file URLs with drive letter", () => {
		const normalized = normalizeProjectEditor({
			wallpaper: "file:///C:/Users/me/openscreen/resources/wallpapers/wallpaper2.jpg",
		});
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper2.jpg");
	});

	it("leaves canonical relative paths untouched", () => {
		const normalized = normalizeProjectEditor({ wallpaper: "/wallpapers/wallpaper2.jpg" });
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper2.jpg");
	});

	it("leaves data URIs untouched", () => {
		const dataUri = "data:image/png;base64,AAA";
		expect(normalizeProjectEditor({ wallpaper: dataUri }).wallpaper).toBe(dataUri);
	});

	it("leaves colors and gradients untouched", () => {
		expect(normalizeProjectEditor({ wallpaper: "#1a1a2e" }).wallpaper).toBe("#1a1a2e");
		expect(
			normalizeProjectEditor({ wallpaper: "linear-gradient(90deg, red, blue)" }).wallpaper,
		).toBe("linear-gradient(90deg, red, blue)");
	});

	it("does NOT rewrite user files outside the known install layout", () => {
		const userPath = "file:///home/user/Pictures/wallpapers/wallpaper1.jpg";
		expect(normalizeProjectEditor({ wallpaper: userPath }).wallpaper).toBe(userPath);
	});

	it("falls back to default for bundled paths outside WALLPAPER_PATHS", () => {
		const normalized = normalizeProjectEditor({
			wallpaper: "file:///opt/Openscreen/resources/wallpapers/wallpaper99.jpg",
		});
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper1.jpg");
	});
});

describe("project format v4: clips", () => {
	const media = { screenVideoPath: "/tmp/screen.webm" };

	/** A v3 file: media at the top level, every edit in one flat editor object. */
	const legacyV3 = {
		version: 3,
		media,
		editor: {
			wallpaper: "/wallpapers/wallpaper2.jpg",
			padding: 42,
			zoomRegions: [
				{ id: "zoom-1", startMs: 0, endMs: 1_000, depth: 2, focus: { cx: 0.5, cy: 0.5 } },
			],
			trimRegions: [{ id: "trim-1", startMs: 2_000, endMs: 3_000 }],
		},
	};

	it("reads a v3 project as a sequence of one clip, losing nothing", () => {
		expect(validateProjectData(legacyV3)).toBe(true);
		expect(resolveProjectMedia(legacyV3)).toEqual(media);

		const editor = resolveProjectEditor(legacyV3);
		expect(editor.wallpaper).toBe("/wallpapers/wallpaper2.jpg");
		expect(editor.padding).toBe(42);
		expect(editor.zoomRegions).toHaveLength(1);
		expect(editor.trimRegions[0]).toMatchObject({ startMs: 2_000, endMs: 3_000 });
	});

	it("reads a v1 project, which had only a videoPath", () => {
		const legacyV1 = { version: 1, videoPath: "/tmp/old.webm", editor: {} };
		expect(resolveProjectMedia(legacyV1)).toEqual({ screenVideoPath: "/tmp/old.webm" });
		expect(resolveProjectEditor(legacyV1).zoomRegions).toEqual([]);
	});

	it("survives a round trip: load a v3 file, save it, load it again", () => {
		const loaded = resolveProjectEditor(legacyV3);
		const saved = createProjectData(media, loaded);
		const reloaded = resolveProjectEditor(saved);

		expect(saved.version).toBe(4);
		expect(reloaded).toEqual(loaded);
		expect(resolveProjectMedia(saved)).toEqual(media);
	});

	it("splits the state so no key is dropped or duplicated", () => {
		const editor = normalizeProjectEditor({});
		const { clip, sequence } = splitEditorState(editor);

		const clipKeys = Object.keys(clip);
		const sequenceKeys = Object.keys(sequence);

		expect(clipKeys.sort()).toEqual([...CLIP_EDITOR_KEYS].sort());
		expect(clipKeys.filter((key) => sequenceKeys.includes(key))).toEqual([]);

		// Three destinations, and every key must reach exactly one of them: the
		// clip, the shared settings, or the top level of the file.
		expect([...clipKeys, ...sequenceKeys, ...TOP_LEVEL_EDITOR_KEYS].sort()).toEqual(
			Object.keys(editor).sort(),
		);
		expect(sequenceKeys.filter((key) => TOP_LEVEL_EDITOR_KEYS.includes(key as never))).toEqual([]);
	});

	it("keeps the clip id stable, or every save would look like a change", () => {
		const editor = normalizeProjectEditor({});
		const first = createProjectSnapshot(media, editor);
		const second = createProjectSnapshot(media, editor);

		expect(first).toBe(second);
		expect(hasProjectUnsavedChanges(second, first)).toBe(false);
	});

	it("notices a real edit through the new shape", () => {
		const baseline = createProjectSnapshot(media, normalizeProjectEditor({}));
		const edited = createProjectSnapshot(
			media,
			normalizeProjectEditor({ trimRegions: [{ id: "trim-1", startMs: 0, endMs: 500 }] }),
		);

		expect(hasProjectUnsavedChanges(edited, baseline)).toBe(true);
	});

	it("reads media from every clip, so the main process can vet them all", () => {
		const twoClips = {
			version: 4,
			clips: [
				{ id: "clip-1", media, editor: {} },
				{ id: "clip-2", media: { screenVideoPath: "/tmp/second.webm" }, editor: {} },
			],
			editor: {},
		};

		expect(projectMediaList(twoClips)).toEqual([media, { screenVideoPath: "/tmp/second.webm" }]);
		// The editor still opens the first one.
		expect(resolveProjectMedia(twoClips)).toEqual(media);
	});

	it("ignores a clip entry that carries no usable path", () => {
		const broken = {
			version: 4,
			clips: [
				{ id: "clip-1", editor: {} },
				{ id: "clip-2", media, editor: {} },
			],
			editor: {},
		};
		expect(projectMediaList(broken)).toEqual([media]);
	});
});

describe("card clips", () => {
	const media = { screenVideoPath: "/tmp/screen.webm" };
	const noRecordings = () => 0;

	const card = (id: string, durationMs?: number): ProjectClipData => ({
		id,
		media: null,
		...(durationMs === undefined ? {} : { durationMs }),
		editor: {} as never,
	});

	const recording = (id: string): ProjectClipData => ({
		id,
		media,
		editor: {} as never,
	});

	it("tells a card apart from a recording", () => {
		expect(isCardClip(card("intro"))).toBe(true);
		expect(isCardClip(recording("clip-1"))).toBe(false);
	});

	it("gives a card its stored length, and a default when it has none", () => {
		const [stored, defaulted] = sequenceInputsFromClips(
			[card("intro", 5_000), card("outro")],
			noRecordings,
		);

		expect(stored.sourceDurationMs).toBe(5_000);
		expect(defaulted.sourceDurationMs).toBe(DEFAULT_CARD_DURATION_MS);
	});

	it("refuses a card length that is absurd rather than trusting the file", () => {
		expect(normalizeCardDurationMs(-1)).toBe(MIN_CARD_DURATION_MS);
		expect(normalizeCardDurationMs(10 * 60 * 1000)).toBe(MAX_CARD_DURATION_MS);
		expect(normalizeCardDurationMs("soon" as never)).toBe(DEFAULT_CARD_DURATION_MS);
		expect(normalizeCardDurationMs(Number.NaN)).toBe(DEFAULT_CARD_DURATION_MS);
	});

	it("asks the caller how long a recording is, since the project never stores it", () => {
		const durations = sequenceInputsFromClips([recording("clip-1")], () => 8_000);
		expect(durations[0].sourceDurationMs).toBe(8_000);
	});

	it("treats a recording of unknown length as empty, not as broken", () => {
		const [input] = sequenceInputsFromClips([recording("clip-1")], () => Number.NaN);
		expect(input.sourceDurationMs).toBe(0);
	});

	it("lays an intro card, a recording and an outro card end to end", () => {
		const clips = [card("intro", 2_000), recording("clip-1"), card("outro", 1_000)];
		const sequence = computeSequence(sequenceInputsFromClips(clips, () => 10_000));

		expect(sequence.clips.map((c) => [c.outStartMs, c.outEndMs])).toEqual([
			[0, 2_000],
			[2_000, 12_000],
			[12_000, 13_000],
		]);
		expect(sequence.durationMs).toBe(13_000);
	});

	it("carries a recording's trims into the sequence, and a card has none to carry", () => {
		const edited: ProjectClipData = {
			id: "clip-1",
			media,
			editor: { trimRegions: [{ id: "trim-1", startMs: 0, endMs: 4_000 }] } as never,
		};
		const [cardInput, recordingInput] = sequenceInputsFromClips(
			[card("intro", 1_000), edited],
			() => 10_000,
		);

		expect(cardInput.trimRegions).toBeUndefined();
		expect(recordingInput.trimRegions).toHaveLength(1);

		// The trim shortens the recording, so the whole video is 4s shorter.
		const sequence = computeSequence([cardInput, recordingInput]);
		expect(sequence.durationMs).toBe(7_000);
	});

	it("leaves cards out of the media list, so nothing tries to open them", () => {
		const project = {
			version: 4,
			clips: [card("intro", 1_000), recording("clip-1")],
			editor: {},
		};

		// This is what the main process vets, and a card has no file to vet.
		expect(projectMediaList(project)).toEqual([media]);
		expect(resolveProjectMedia(project)).toEqual(media);
	});
});

describe("cards through save and load", () => {
	const media = { screenVideoPath: "/tmp/screen.webm" };

	it("keeps an intro and an outro across a round trip", () => {
		const editor = normalizeProjectEditor({
			clips: addOutroCard(addIntroCard(INITIAL_CLIPS, { title: "Hello", durationMs: 2_000 }), {
				title: "Thanks",
			}),
			trimRegions: [{ id: "trim-1", startMs: 0, endMs: 500 }],
		});

		const saved = createProjectData(media, editor);
		expect(saved.clips?.map((clip) => clip.id)).toEqual(["card-1", "clip-1", "card-2"]);
		// Only the recording carries the edits; the cards carry text and a length.
		expect(saved.clips?.[0]).toMatchObject({ media: null, title: "Hello", durationMs: 2_000 });
		expect(saved.clips?.[0].editor).toBeUndefined();
		expect(saved.clips?.[1].editor?.trimRegions).toHaveLength(1);

		const reloaded = resolveProjectEditor(saved);
		expect(reloaded.clips).toEqual(editor.clips);
		expect(reloaded.trimRegions).toHaveLength(1);
	});

	it("finds the recording's edits even when a card comes first", () => {
		const editor = normalizeProjectEditor({
			clips: addIntroCard(INITIAL_CLIPS, { title: "Hello" }),
			zoomRegions: [
				{ id: "zoom-1", startMs: 0, endMs: 1_000, depth: 2, focus: { cx: 0.5, cy: 0.5 } },
			],
		});

		// clips[0] is the card, so reading the first clip's edits would lose the zoom.
		const reloaded = resolveProjectEditor(createProjectData(media, editor));
		expect(reloaded.zoomRegions).toHaveLength(1);
	});

	it("keeps clips out of the saved editor object, where they would be duplicated", () => {
		const saved = createProjectData(media, normalizeProjectEditor({}));
		expect(saved.editor).not.toHaveProperty("clips");
		expect(saved.clips).toHaveLength(1);
	});

	it("puts the recording back if a file somehow has only cards", () => {
		const clips = resolveProjectClips({
			version: 4,
			clips: [{ id: "card-1", media: null, durationMs: 1_000 }],
		} as never);

		expect(clips.some((clip) => clip.kind === "recording")).toBe(true);
	});

	it("does not report a saved project as dirty just for having cards", () => {
		const editor = normalizeProjectEditor({
			clips: addIntroCard(INITIAL_CLIPS, { title: "Hello" }),
		});
		const first = createProjectSnapshot(media, editor);
		const second = createProjectSnapshot(media, editor);
		expect(hasProjectUnsavedChanges(second, first)).toBe(false);
	});

	it("notices a card being added, renamed or reordered", () => {
		const base = normalizeProjectEditor({});
		const baseline = createProjectSnapshot(media, base);

		const withCard = normalizeProjectEditor({
			clips: addIntroCard(INITIAL_CLIPS, { title: "Hello" }),
		});
		const added = createProjectSnapshot(media, withCard);
		expect(hasProjectUnsavedChanges(added, baseline)).toBe(true);

		const renamed = createProjectSnapshot(
			media,
			normalizeProjectEditor({ clips: updateCard(withCard.clips, "card-1", { title: "Hi" }) }),
		);
		expect(hasProjectUnsavedChanges(renamed, added)).toBe(true);

		const moved = createProjectSnapshot(
			media,
			normalizeProjectEditor({ clips: moveClip(withCard.clips, "card-1", 1) }),
		);
		expect(hasProjectUnsavedChanges(moved, added)).toBe(true);
	});
});
