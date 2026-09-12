import { describe, expect, it } from "vitest";
import { DEFAULT_CURSOR_SETTINGS } from "./editorDefaults";
import {
	createProjectData,
	createProjectSnapshot,
	hasProjectUnsavedChanges,
	normalizeProjectEditor,
	PROJECT_VERSION,
	resolveProjectMedia,
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

	it("creates version 2 projects with explicit media", () => {
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
		expect(project.media).toEqual({
			screenVideoPath: "/tmp/screen.webm",
			webcamVideoPath: "/tmp/webcam.webm",
		});
		expect(validateProjectData(project)).toBe(true);
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
