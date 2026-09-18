import type { Span } from "dnd-timeline";
import { FolderOpen, Languages, Save, Video } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import { decodeAudioPeaks, getCachedAudioPeaks } from "@/hooks/useAudioPeaks";
import { INITIAL_EDITOR_STATE, useEditorHistory } from "@/hooks/useEditorHistory";
import { useMcpCommands } from "@/hooks/useMcpCommands";
import { type Locale } from "@/i18n/config";
import { getAvailableLocales, getLocaleName } from "@/i18n/loader";
import {
	captionSegmentsToAnnotationRegions,
	extractMono16kFromVideoUrl,
	MAX_CAPTION_AUDIO_SEC,
	reconcileAutoCaptionTimelineGaps,
	shiftTrimRegionsMsForCaptionBuffer,
	transcribeMono16kToSegments,
	trimLeadingSilenceMono16k,
} from "@/lib/captioning";
import { clickTimestampsFrom, hasEditableCursorOverlay } from "@/lib/cursor/clickTimestamps";
import { hasNativeCursorRecordingData } from "@/lib/cursor/nativeCursor";
import {
	calculateEffectiveSourceDimensions,
	calculateMp4ExportSettings,
	calculateOutputDimensions,
	type ExportFormat,
	type ExportProgress,
	type ExportQuality,
	type ExportSettings,
	GIF_SIZE_PRESETS,
	GifExporter,
	type GifFrameRate,
	type GifSizePreset,
	VideoExporter,
} from "@/lib/exporter";
import type { ExportSequenceClip } from "@/lib/exporter/exportSequence";
import { computeFrameStepTime } from "@/lib/frameStep";
import type { ExportRunner } from "@/lib/mcp/exportJob";
import { acceptProposals, countProposals, discardProposals } from "@/lib/mcp/proposals";
import { lastPathSegment } from "@/lib/mcp/walkthrough";
import type { CursorCaptureMode, ProjectMedia, RecordingSession } from "@/lib/recordingSession";
import { matchesShortcut } from "@/lib/shortcuts";
import { findSilenceCuts, type SilenceTrimSettings } from "@/lib/silenceTrim";
import { findBoringStretches, type TimelapseSettings } from "@/lib/timelapse";
import {
	getExportFolder,
	getProjectFolder,
	loadUserPreferences,
	parentDirectoryOf,
	saveUserPreferences,
} from "@/lib/userPreferences";
import { BackgroundLoadError } from "@/lib/wallpaper";
import { nativeBridgeClient, useCursorRecordingData, useCursorTelemetry } from "@/native";
import type { CursorRecordingData, NativePlatform } from "@/native/contracts";
import {
	getAspectRatioValue,
	getNativeAspectRatioValue,
	isPortraitAspectRatio,
} from "@/utils/aspectRatioUtils";
import { ClipStrip } from "./ClipStrip";
import {
	addIntroCard,
	addOutroCard,
	addRecording,
	type ClipEntry,
	checkoutNewRecording,
	checkoutRecording,
	emptyClipEditor,
	isCardEntry,
	moveClip,
	recordingEntries,
	recordingIndex,
	removeCard,
	removeRecording,
	updateCard,
} from "./clips";
import { EditorEmptyState } from "./EditorEmptyState";
import { ExportDialog } from "./ExportDialog";
import {
	DEFAULT_EXPORT_SETTINGS,
	DEFAULT_GIF_SETTINGS,
	DEFAULT_SOURCE_DIMENSIONS,
} from "./editorDefaults";
import PlaybackControls from "./PlaybackControls";
import { ProposalReviewBar } from "./ProposalReviewBar";
import {
	createProjectData,
	createProjectSnapshot,
	deriveNextId,
	fromFileUrl,
	hasProjectUnsavedChanges,
	normalizeCardDurationMs,
	type ProjectEditorState,
	resolveProjectEditor,
	resolveProjectMedia,
	toFileUrl,
	validateProjectData,
} from "./projectPersistence";
import { RecordingsLibrary } from "./RecordingsLibrary";
import { type SequenceEntry, SequencePreview } from "./SequencePreview";
import { SettingsPanel } from "./SettingsPanel";
import TimelineEditor from "./timeline/TimelineEditor";
import {
	type AutoZoomSuggestion,
	findZoomSuggestions,
	type ZoomSuggestionScan,
} from "./timeline/zoomSuggestionUtils";
import {
	type AnnotationRegion,
	type BlurData,
	type CursorTelemetryPoint,
	clampFocusToDepth,
	clampPlaybackSpeed,
	DEFAULT_ANNOTATION_POSITION,
	DEFAULT_ANNOTATION_SIZE,
	DEFAULT_ANNOTATION_STYLE,
	DEFAULT_BLUR_DATA,
	DEFAULT_FIGURE_DATA,
	DEFAULT_PLAYBACK_SPEED,
	DEFAULT_ZOOM_DEPTH,
	type FigureData,
	type PlaybackSpeed,
	type RegionSource,
	type Rotation3DPreset,
	type SpeedRegion,
	type TrimRegion,
	ZOOM_DEPTH_SCALES,
	type ZoomDepth,
	type ZoomFocus,
	type ZoomFocusMode,
	type ZoomRegion,
} from "./types";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";
import VideoPlayback, { VideoPlaybackRef } from "./VideoPlayback";

/** Single Sonner slot so auto-caption phases update in place instead of stacking. */
const AUTO_CAPTION_PROGRESS_TOAST_ID = "auto-caption-progress";

interface ExportDiagnostics {
	formatLabel: "GIF" | "Video";
	reason?: string;
	sourcePath?: string | null;
	width?: number;
	height?: number;
	frameRate?: number;
	codec?: string;
	bitrate?: number;
}

function getFileNameForDiagnostics(filePath?: string | null) {
	if (!filePath) return "unknown";

	try {
		const url = new URL(filePath);
		if (url.protocol === "file:") {
			return decodeURIComponent(url.pathname).split(/[\\/]/).pop() || filePath;
		}
	} catch {
		// Treat non-URL values as filesystem paths.
	}

	return filePath.split(/[\\/]/).pop() || filePath;
}

function buildExportDiagnosticMessage(diagnostics: ExportDiagnostics) {
	const details = [
		diagnostics.reason ? `Reason: ${diagnostics.reason}` : null,
		`Source: ${getFileNameForDiagnostics(diagnostics.sourcePath)}`,
		diagnostics.width && diagnostics.height
			? `Output: ${diagnostics.width}x${diagnostics.height}${
					diagnostics.frameRate ? ` @ ${diagnostics.frameRate} fps` : ""
				}`
			: null,
		diagnostics.codec ? `Codec: ${diagnostics.codec}` : null,
		diagnostics.bitrate ? `Bitrate: ${Math.round(diagnostics.bitrate / 1_000_000)} Mbps` : null,
		`VideoEncoder: ${"VideoEncoder" in window ? "available" : "unavailable"}`,
	].filter(Boolean);

	return `${diagnostics.formatLabel} export failed\n${details.join("\n")}`;
}

/** Why a scan for boring stretches came back with nothing. */
const TIMELAPSE_REFUSAL_KEYS = {
	"no-audio": "silence.noAudio",
	"nothing-found": "timelapse.nothingFound",
} as const;

/** Why the wand found nothing to suggest, and what the user can do about it. */
const AUTO_ZOOM_REFUSAL_KEYS = {
	"no-cursor-data": "errors.noCursorTelemetry",
	"unusable-cursor-data": "errors.noUsableTelemetry",
	"nothing-found": "errors.noDwellMoments",
	"no-room": "errors.noAutoZoomSlots",
} as const;

const AUTO_ZOOM_REFUSAL_DESCRIPTION_KEYS = {
	"no-cursor-data": "errors.noCursorTelemetryDescription",
	"unusable-cursor-data": "errors.noUsableTelemetryDescription",
	"nothing-found": "errors.noDwellMomentsDescription",
	"no-room": "errors.noAutoZoomSlotsDescription",
} as const;

/** Why a scan for dead air came back with nothing, in words the user can act on. */
const SILENCE_REFUSAL_KEYS = {
	"no-audio": "silence.noAudio",
	"nothing-found": "silence.nothingFound",
	"all-quiet": "silence.allQuiet",
} as const;

function buildSaveDiagnosticMessage(formatLabel: "GIF" | "Video", reason?: string) {
	return `${formatLabel} export save failed${reason ? `\nReason: ${reason}` : ""}`;
}

/**
 * A region the user has just edited is theirs, not an agent's proposal any more.
 *
 * Without this, someone who fixed up a proposed caption and then chose "discard
 * proposals" would lose their own correction along with the rest.
 */
function owned<T extends { source?: RegionSource }>(region: T): T {
	return region.source === "agent" ? { ...region, source: "manual" } : region;
}

const CAPTION_WORD_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

export default function VideoEditor() {
	const {
		state: editorState,
		pushState,
		updateState,
		commitState,
		undo,
		redo,
		resetState,
	} = useEditorHistory(INITIAL_EDITOR_STATE);

	const {
		clips,
		activeClipId,
		zoomRegions,
		autoZoomEnabled,
		autoFocusAll,
		trimRegions,
		speedRegions,
		annotationRegions,
		cropRegion,
		wallpaper,
		shadowIntensity,
		showBlur,
		showTrimWaveform,
		motionBlurAmount,
		transitionStyle,
		transitionMs,
		silenceSensitivity,
		silenceMinPauseMs,
		silencePaddingMs,
		timelapseSpeed,
		timelapseMinMs,
		borderRadius,
		padding,
		aspectRatio,
		webcamLayoutPreset,
		webcamMaskShape,
		webcamMirrored,
		webcamReactiveZoom,
		webcamSizePreset,
		webcamPosition,
		showCursor,
		cursorSize,
		cursorSmoothing,
		cursorMotionBlur,
		cursorClickBounce,
		cursorClickRipple,
		cursorClipToBounds,
		cursorTheme,
	} = editorState;

	// Non-undoable state
	const [videoPath, setVideoPath] = useState<string | null>(null);
	const [videoSourcePath, setVideoSourcePath] = useState<string | null>(null);
	const [webcamVideoPath, setWebcamVideoPath] = useState<string | null>(null);
	const [webcamVideoSourcePath, setWebcamVideoSourcePath] = useState<string | null>(null);
	const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const currentTimeRef = useRef(currentTime);
	currentTimeRef.current = currentTime;
	const durationRef = useRef(duration);
	durationRef.current = duration;
	// The saved-state baseline is captured from an async effect, by which time user
	// preferences have already been applied to the editor. Reading the constant
	// there would compare the user's padding and aspect ratio against the defaults
	// and call an untouched recording unsaved.
	const editorStateRef = useRef(editorState);
	editorStateRef.current = editorState;
	const [selectedZoomId, setSelectedZoomId] = useState<string | null>(null);
	const [isPreviewingZoom, setIsPreviewingZoom] = useState(false);
	const [selectedTrimId, setSelectedTrimId] = useState<string | null>(null);
	const [selectedSpeedId, setSelectedSpeedId] = useState<string | null>(null);
	const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
	const [selectedBlurId, setSelectedBlurId] = useState<string | null>(null);
	const [isExporting, setIsExporting] = useState(false);
	const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
	const [exportError, setExportError] = useState<string | null>(null);
	const [showExportDialog, setShowExportDialog] = useState(false);
	const [showNewRecordingDialog, setShowNewRecordingDialog] = useState(false);
	const [exportQuality, setExportQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_SETTINGS.quality,
	);
	const [exportFormat, setExportFormat] = useState<ExportFormat>(DEFAULT_EXPORT_SETTINGS.format);
	const [gifFrameRate, setGifFrameRate] = useState<GifFrameRate>(DEFAULT_GIF_SETTINGS.frameRate);
	const [gifLoop, setGifLoop] = useState(DEFAULT_GIF_SETTINGS.loop);
	const [gifSizePreset, setGifSizePreset] = useState<GifSizePreset>(
		DEFAULT_GIF_SETTINGS.sizePreset,
	);
	const [exportedFilePath, setExportedFilePath] = useState<string | null>(null);
	const exportOutcomeRef = useRef<{ ok: boolean; path?: string; message?: string } | null>(null);
	const [lastSavedSnapshot, setLastSavedSnapshot] = useState<string | null>(null);
	const [unsavedExport, setUnsavedExport] = useState<{
		arrayBuffer: ArrayBuffer;
		fileName: string;
		format: string;
	} | null>(null);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [showCloseConfirmDialog, setShowCloseConfirmDialog] = useState(false);
	// Unsaved-changes confirmation for New Project / Load Project / Back to Recording.
	// The window-close flow uses showCloseConfirmDialog above.
	// Which card the strip has open. Selection is not undoable, like every other
	// selection in the editor.
	const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
	const [sequencePreviewOpen, setSequencePreviewOpen] = useState(false);
	const [sequenceEntries, setSequenceEntries] = useState<SequenceEntry[] | null>(null);
	const sequencePreviewOpenRef = useRef(false);
	sequencePreviewOpenRef.current = sequencePreviewOpen;
	// Cursor files of recordings that are not open never change, and the sequence is
	// rebuilt on every edit while it is being watched: read each file once.
	const inactiveCursorCacheRef = useRef(
		new Map<string, Promise<[CursorTelemetryPoint[], CursorRecordingData | null]>>(),
	);

	const [confirmDialogVariant, setConfirmDialogVariant] = useState<
		"newProject" | "loadProject" | null
	>(null);
	const playerContainerRef = useRef<HTMLDivElement | null>(null);
	const cursorTelemetrySourcePath = videoSourcePath ?? (videoPath ? fromFileUrl(videoPath) : null);
	const { samples: cursorTelemetry, error: cursorTelemetryError } =
		useCursorTelemetry(cursorTelemetrySourcePath);
	const { data: cursorRecordingData, error: cursorRecordingDataError } =
		useCursorRecordingData(cursorTelemetrySourcePath);
	const cursorClickTimestamps = useMemo<number[]>(
		() => clickTimestampsFrom(cursorRecordingData, cursorTelemetry),
		[cursorRecordingData, cursorTelemetry],
	);

	const [nativePlatform, setNativePlatform] = useState<NativePlatform | null>(null);
	const [recordingCursorCaptureMode, setRecordingCursorCaptureMode] =
		useState<CursorCaptureMode | null>(null);

	const videoPlaybackRef = useRef<VideoPlaybackRef>(null);

	const nextZoomIdRef = useRef(1);
	const nextTrimIdRef = useRef(1);
	const nextSpeedIdRef = useRef(1);

	const { shortcuts, isMac } = useShortcuts();
	// Windows recordings include captured cursor assets. macOS hides the system
	// cursor in ScreenCaptureKit and renders telemetry samples with OpenScreen's
	// default arrow asset for the editable overlay.
	const hasEditableCursorRecording = hasEditableCursorOverlay(
		recordingCursorCaptureMode,
		nativePlatform,
		cursorRecordingData,
	);
	const effectiveShowCursor = showCursor && hasEditableCursorRecording;
	const showCursorSettings = hasEditableCursorRecording;
	const { locale, setLocale, t: rawT } = useI18n();
	const t = useScopedT("editor");
	const tTimeline = useScopedT("timeline");
	const ts = useScopedT("settings");
	const availableLocales = getAvailableLocales();

	const nextAnnotationIdRef = useRef(1);
	const nextAnnotationZIndexRef = useRef(1);
	const isAutoCaptioningRef = useRef(false);
	const [isAutoCaptioning, setIsAutoCaptioning] = useState(false);
	const [showAutoCaptionsDialog, setShowAutoCaptionsDialog] = useState(false);
	const [captionWordsMin, setCaptionWordsMin] = useState(2);
	const [captionWordsMax, setCaptionWordsMax] = useState(7);
	const exporterRef = useRef<VideoExporter | null>(null);

	const annotationOnlyRegions = useMemo(
		() => annotationRegions.filter((region) => region.type !== "blur"),
		[annotationRegions],
	);
	const blurRegions = useMemo(
		() => annotationRegions.filter((region) => region.type === "blur"),
		[annotationRegions],
	);

	const currentProjectMedia = useMemo<ProjectMedia | null>(() => {
		const screenVideoPath = videoSourcePath ?? (videoPath ? fromFileUrl(videoPath) : null);
		if (!screenVideoPath) {
			return null;
		}

		const webcamSourcePath =
			webcamVideoSourcePath ?? (webcamVideoPath ? fromFileUrl(webcamVideoPath) : null);
		return {
			screenVideoPath,
			...(webcamSourcePath ? { webcamVideoPath: webcamSourcePath } : {}),
			...(recordingCursorCaptureMode ? { cursorCaptureMode: recordingCursorCaptureMode } : {}),
		};
	}, [
		videoPath,
		videoSourcePath,
		webcamVideoPath,
		webcamVideoSourcePath,
		recordingCursorCaptureMode,
	]);

	const applyLoadedProject = useCallback(
		async (candidate: unknown, path?: string | null, openAtClipId?: string) => {
			if (!validateProjectData(candidate)) {
				return false;
			}

			const project = candidate;
			const projectMedia = resolveProjectMedia(project, openAtClipId);
			if (!projectMedia) {
				return false;
			}
			const sourcePath = projectMedia.screenVideoPath;
			const webcamSourcePath = projectMedia.webcamVideoPath ?? null;
			const projectCursorCaptureMode = projectMedia.cursorCaptureMode ?? null;
			const normalizedEditor = resolveProjectEditor(project, openAtClipId);
			const inferredDurationMs = Math.max(
				0,
				...normalizedEditor.zoomRegions.map((region) => region.endMs),
				...normalizedEditor.trimRegions.map((region) => region.endMs),
				...normalizedEditor.speedRegions.map((region) => region.endMs),
				...normalizedEditor.annotationRegions.map((region) => region.endMs),
			);

			try {
				videoPlaybackRef.current?.pause();
			} catch {
				// no-op
			}
			setIsPlaying(false);
			setCurrentTime(0);
			setDuration(inferredDurationMs > 0 ? inferredDurationMs / 1000 : 0);

			setError(null);
			setVideoSourcePath(sourcePath);
			setVideoPath(toFileUrl(sourcePath));
			setWebcamVideoSourcePath(webcamSourcePath);
			setWebcamVideoPath(webcamSourcePath ? toFileUrl(webcamSourcePath) : null);
			setRecordingCursorCaptureMode(projectCursorCaptureMode);
			setCurrentProjectPath(path ?? null);

			// A loaded project keeps its zooms exactly as saved, so never auto-suggest
			// over it (even if it has zero zooms because the user deleted them all).
			autoProcessedSourceRef.current = sourcePath;

			pushState({
				wallpaper: normalizedEditor.wallpaper,
				shadowIntensity: normalizedEditor.shadowIntensity,
				showBlur: normalizedEditor.showBlur,
				showTrimWaveform: normalizedEditor.showTrimWaveform,
				motionBlurAmount: normalizedEditor.motionBlurAmount,
				transitionStyle: normalizedEditor.transitionStyle,
				transitionMs: normalizedEditor.transitionMs,
				borderRadius: normalizedEditor.borderRadius,
				padding: normalizedEditor.padding,
				cropRegion: normalizedEditor.cropRegion,
				clips: normalizedEditor.clips,
				activeClipId: normalizedEditor.activeClipId,
				zoomRegions: normalizedEditor.zoomRegions,
				autoZoomEnabled: normalizedEditor.autoZoomEnabled,
				autoFocusAll: normalizedEditor.autoFocusAll,
				trimRegions: normalizedEditor.trimRegions,
				speedRegions: normalizedEditor.speedRegions,
				annotationRegions: normalizedEditor.annotationRegions,
				aspectRatio: normalizedEditor.aspectRatio,
				webcamLayoutPreset: normalizedEditor.webcamLayoutPreset,
				webcamMaskShape: normalizedEditor.webcamMaskShape,
				webcamMirrored: normalizedEditor.webcamMirrored,
				webcamReactiveZoom: normalizedEditor.webcamReactiveZoom,
				webcamSizePreset: normalizedEditor.webcamSizePreset,
				webcamPosition: normalizedEditor.webcamPosition,
				showCursor: normalizedEditor.showCursor,
				cursorSize: normalizedEditor.cursorSize,
				cursorSmoothing: normalizedEditor.cursorSmoothing,
				cursorMotionBlur: normalizedEditor.cursorMotionBlur,
				cursorClickBounce: normalizedEditor.cursorClickBounce,
				cursorClickRipple: normalizedEditor.cursorClickRipple,
				cursorClipToBounds: normalizedEditor.cursorClipToBounds,
				cursorTheme: normalizedEditor.cursorTheme,
			});
			setExportQuality(normalizedEditor.exportQuality);
			setExportFormat(normalizedEditor.exportFormat);
			setGifFrameRate(normalizedEditor.gifFrameRate);
			setGifLoop(normalizedEditor.gifLoop);
			setGifSizePreset(normalizedEditor.gifSizePreset);

			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);

			nextZoomIdRef.current = deriveNextId(
				"zoom",
				normalizedEditor.zoomRegions.map((region) => region.id),
			);
			nextTrimIdRef.current = deriveNextId(
				"trim",
				normalizedEditor.trimRegions.map((region) => region.id),
			);
			nextSpeedIdRef.current = deriveNextId(
				"speed",
				normalizedEditor.speedRegions.map((region) => region.id),
			);
			nextAnnotationIdRef.current = deriveNextId(
				"annotation",
				normalizedEditor.annotationRegions.map((region) => region.id),
			);
			nextAnnotationZIndexRef.current =
				normalizedEditor.annotationRegions.reduce(
					(max, region) => Math.max(max, region.zIndex),
					0,
				) + 1;

			setLastSavedSnapshot(
				createProjectSnapshot(
					{
						screenVideoPath: sourcePath,
						...(webcamSourcePath ? { webcamVideoPath: webcamSourcePath } : {}),
						...(projectCursorCaptureMode ? { cursorCaptureMode: projectCursorCaptureMode } : {}),
					},
					normalizedEditor,
				),
			);
			return true;
		},
		[pushState],
	);

	/**
	 * Puts a project back with the take just recorded appended and open.
	 *
	 * The project is loaded exactly as it was parked, so the recording that was open
	 * then keeps its edits; the new take goes on the end, becomes the one being
	 * edited, and starts with nothing on it. The project reads as unsaved
	 * afterwards, which it is — the file on disk has no such take in it.
	 */
	const applyRetake = useCallback(
		async (project: unknown, path: string | null, session: RecordingSession) => {
			if (!validateProjectData(project)) return false;
			const openedMedia = resolveProjectMedia(project);
			if (!openedMedia) return false;
			if (!(await applyLoadedProject(project, path))) return false;

			const screenVideoPath = fromFileUrl(session.screenVideoPath);
			const webcamVideoPath = session.webcamVideoPath ? fromFileUrl(session.webcamVideoPath) : null;
			pushState((prev) => {
				const result = checkoutNewRecording(prev.clips, prev.activeClipId, openedMedia, {
					cropRegion: prev.cropRegion,
					zoomRegions: prev.zoomRegions,
					trimRegions: prev.trimRegions,
					speedRegions: prev.speedRegions,
					annotationRegions: prev.annotationRegions,
				});
				return { clips: result.clips, activeClipId: result.activeClipId, ...emptyClipEditor() };
			});

			setVideoSourcePath(screenVideoPath);
			setVideoPath(toFileUrl(screenVideoPath));
			setWebcamVideoSourcePath(webcamVideoPath);
			setWebcamVideoPath(webcamVideoPath ? toFileUrl(webcamVideoPath) : null);
			setRecordingCursorCaptureMode(session.cursorCaptureMode ?? null);
			setCurrentTime(0);
			setDuration(0);
			// A take that has just been recorded gets zoom suggestions like any other.
			autoProcessedSourceRef.current = null;
			return true;
		},
		[applyLoadedProject, pushState],
	);

	// What gets written to the project file: the undoable editor state plus the export
	// settings, which sit outside history. Built in one place so the snapshot and the
	// save path can't drift apart as fields are added.
	const projectEditorState = useMemo<ProjectEditorState>(
		() => ({
			...editorState,
			exportQuality,
			exportFormat,
			gifFrameRate,
			gifLoop,
			gifSizePreset,
		}),
		[editorState, exportQuality, exportFormat, gifFrameRate, gifLoop, gifSizePreset],
	);

	const currentProjectSnapshot = useMemo(() => {
		if (!currentProjectMedia) {
			return null;
		}
		return createProjectSnapshot(currentProjectMedia, projectEditorState);
	}, [currentProjectMedia, projectEditorState]);

	const hasUnsavedChanges = hasProjectUnsavedChanges(currentProjectSnapshot, lastSavedSnapshot);

	useEffect(() => {
		async function loadInitialData() {
			try {
				// A take just recorded for an open project: put the project back, with the
				// new take appended and open. Asked before anything else, because the
				// recording handoff has already made that take the current session.
				const retake = await window.electronAPI.consumePendingRetake();
				if (retake.success && retake.project) {
					const sessionResult = await window.electronAPI.getCurrentRecordingSession();
					const session = sessionResult.success ? sessionResult.session : null;
					if (session) {
						const applied = await applyRetake(retake.project, retake.path ?? null, session);
						if (applied) return;
					}
				}

				const currentProjectResult = await nativeBridgeClient.project.loadCurrentProjectFile();
				if (currentProjectResult.success && currentProjectResult.project) {
					const restored = await applyLoadedProject(
						currentProjectResult.project,
						currentProjectResult.path ?? null,
					);
					if (restored) {
						return;
					}
				}

				const currentSessionResult = await window.electronAPI.getCurrentRecordingSession();
				if (currentSessionResult.success && currentSessionResult.session) {
					const session = currentSessionResult.session;
					const sourcePath = fromFileUrl(session.screenVideoPath);
					const webcamSourcePath = session.webcamVideoPath
						? fromFileUrl(session.webcamVideoPath)
						: null;
					setVideoSourcePath(sourcePath);
					setVideoPath(toFileUrl(sourcePath));
					setWebcamVideoSourcePath(webcamSourcePath);
					setWebcamVideoPath(webcamSourcePath ? toFileUrl(webcamSourcePath) : null);
					setRecordingCursorCaptureMode(session.cursorCaptureMode ?? null);
					setCurrentProjectPath(null);
					setLastSavedSnapshot(
						createProjectSnapshot(
							{
								screenVideoPath: sourcePath,
								...(webcamSourcePath ? { webcamVideoPath: webcamSourcePath } : {}),
								...(session.cursorCaptureMode
									? { cursorCaptureMode: session.cursorCaptureMode }
									: {}),
							},
							editorStateRef.current,
						),
					);
					return;
				}

				const result = await nativeBridgeClient.project.getCurrentVideoPath();
				if (result.success && result.path) {
					setVideoSourcePath(result.path);
					setVideoPath(toFileUrl(result.path));
					setRecordingCursorCaptureMode(null);
					setCurrentProjectPath(null);
					setLastSavedSnapshot(
						createProjectSnapshot({ screenVideoPath: result.path }, editorStateRef.current),
					);
				}
				// No video/project/session, so leave videoPath null and let the
				// EditorEmptyState dashboard render instead of an error screen.
			} catch (err) {
				setError("Error loading video: " + String(err));
			} finally {
				setLoading(false);
			}
		}

		loadInitialData();
	}, [applyLoadedProject, applyRetake]);

	// Avoid overwriting saved prefs with defaults before they've loaded.
	const [prefsHydrated, setPrefsHydrated] = useState(false);

	// Load persisted user preferences on mount (intentionally runs once)
	useEffect(() => {
		const prefs = loadUserPreferences();
		updateState({
			padding: prefs.padding,
			aspectRatio: prefs.aspectRatio,
		});
		setExportQuality(prefs.exportQuality);
		setExportFormat(prefs.exportFormat);
		setPrefsHydrated(true);
	}, [updateState]);

	// Auto-save user preferences when settings change
	useEffect(() => {
		if (!prefsHydrated) return;
		saveUserPreferences({ padding, aspectRatio, exportQuality, exportFormat });
	}, [prefsHydrated, padding, aspectRatio, exportQuality, exportFormat]);

	const saveProject = useCallback(
		async (forceSaveAs: boolean) => {
			if (!videoPath) {
				toast.error(t("errors.noVideoLoaded"));
				return false;
			}

			if (!currentProjectMedia) {
				toast.error(t("errors.unableToDetermineSourcePath"));
				return false;
			}

			const projectData = createProjectData(currentProjectMedia, projectEditorState);

			const fileNameBase =
				currentProjectMedia.screenVideoPath
					.split(/[\\/]/)
					.pop()
					?.replace(/\.[^.]+$/, "") || `project-${Date.now()}`;
			// Normalize the same way as currentProjectSnapshot so the post-save
			// baseline compares equal and hasUnsavedChanges clears.
			const projectSnapshot = createProjectSnapshot(currentProjectMedia, projectEditorState);
			const result = await nativeBridgeClient.project.saveProjectFile(
				projectData,
				fileNameBase,
				forceSaveAs ? undefined : (currentProjectPath ?? undefined),
			);

			if (result.canceled) {
				toast.info(t("project.saveCanceled"));
				return false;
			}

			if (!result.success) {
				toast.error(result.message || t("project.failedToSave"));
				return false;
			}

			if (result.path) {
				setCurrentProjectPath(result.path);
			}
			setLastSavedSnapshot(projectSnapshot);

			toast.success(t("project.savedTo", { path: result.path ?? "" }));
			return true;
		},
		[currentProjectMedia, currentProjectPath, projectEditorState, videoPath, t],
	);

	useEffect(() => {
		window.electronAPI.setHasUnsavedChanges(hasUnsavedChanges);
	}, [hasUnsavedChanges]);

	useEffect(() => {
		const cleanup = window.electronAPI.onRequestSaveBeforeClose(async () => {
			return saveProject(false);
		});
		return () => cleanup();
	}, [saveProject]);

	useEffect(() => {
		const cleanup = window.electronAPI.onRequestCloseConfirm(() => {
			setShowCloseConfirmDialog(true);
		});
		return () => cleanup();
	}, []);

	const handleCloseConfirmSave = useCallback(() => {
		setShowCloseConfirmDialog(false);
		window.electronAPI.sendCloseConfirmResponse("save");
	}, []);

	const handleCloseConfirmDiscard = useCallback(() => {
		setShowCloseConfirmDialog(false);
		window.electronAPI.sendCloseConfirmResponse("discard");
	}, []);

	const handleCloseConfirmCancel = useCallback(() => {
		setShowCloseConfirmDialog(false);
		window.electronAPI.sendCloseConfirmResponse("cancel");
	}, []);

	const handleSaveProject = useCallback(async () => {
		await saveProject(false);
	}, [saveProject]);

	const handleSaveProjectAs = useCallback(async () => {
		await saveProject(true);
	}, [saveProject]);

	/**
	 * Hands the app back to the recorder.
	 *
	 * This tears the editor window down for real: the main process force-closes it,
	 * which deliberately bypasses the unsaved-changes guard on the window. So every
	 * caller has to have dealt with unsaved work already — see handleNewRecording.
	 */
	/**
	 * Puts the project aside before the editor window is destroyed.
	 *
	 * The take that is about to be recorded belongs to this project, so the project
	 * has to survive the window. A saved file with nothing unsaved on top of it
	 * needs no copy — it already says all this. Shared with the agent's path, which
	 * must park exactly the same way rather than approximately.
	 */
	const parkProjectForRetake = useCallback(async () => {
		if (!currentProjectMedia) return true;
		const upToDateOnDisk = Boolean(currentProjectPath) && !hasUnsavedChanges;
		const result = await window.electronAPI.beginRetake({
			projectData: upToDateOnDisk
				? null
				: createProjectData(currentProjectMedia, projectEditorState),
			projectPath: currentProjectPath,
		});
		return result?.success !== false;
	}, [currentProjectMedia, currentProjectPath, hasUnsavedChanges, projectEditorState]);

	const doNewRecording = useCallback(async () => {
		await parkProjectForRetake();

		const result = await window.electronAPI.startNewRecording();
		if (result.success) {
			setShowNewRecordingDialog(false);
		} else {
			console.error("Failed to start new recording:", result.error);
			setError("Failed to start new recording: " + (result.error || "Unknown error"));
		}
	}, [parkProjectForRetake]);

	/**
	 * "Back to recording" — record another take for this project.
	 *
	 * Nothing is at stake any more: the project is parked before the editor window
	 * goes away, and the take that comes back is appended to it. Before that it
	 * asked what to do about unsaved work, because the force-close took every
	 * unsaved edit with it.
	 */
	const handleNewRecording = useCallback(() => {
		setShowNewRecordingDialog(true);
	}, []);

	const doLoadProject = useCallback(async () => {
		const result = await nativeBridgeClient.project.loadProjectFile(getProjectFolder());

		if (result.canceled) {
			return;
		}

		if (!result.success) {
			toast.error(result.message || t("project.failedToLoad"));
			return;
		}

		const restored = await applyLoadedProject(result.project, result.path ?? null);
		if (!restored) {
			toast.error(t("project.invalidFormat"));
			return;
		}

		if (result.path) {
			const folder = parentDirectoryOf(result.path);
			if (folder) {
				saveUserPreferences({ projectFolder: folder });
			}
		}

		toast.success(t("project.loadedFrom", { path: result.path ?? "" }));
	}, [applyLoadedProject, t]);

	const handleLoadProject = useCallback(async () => {
		if (hasUnsavedChanges) {
			setConfirmDialogVariant("loadProject");
			return;
		}
		await doLoadProject();
	}, [hasUnsavedChanges, doLoadProject]);

	const handleLoadProjectConfirmSave = useCallback(async () => {
		setConfirmDialogVariant(null);
		const saved = await saveProject(false);
		if (saved) {
			await doLoadProject();
		}
	}, [saveProject, doLoadProject]);

	const handleLoadProjectConfirmDiscard = useCallback(async () => {
		setConfirmDialogVariant(null);
		await doLoadProject();
	}, [doLoadProject]);

	// New Project: clear all media/project/editor state back to the empty
	// Studio dashboard. Prompts to save first when there are unsaved changes.
	const doNewProject = useCallback(async () => {
		await nativeBridgeClient.project.clearCurrentVideoPath();
		setVideoPath(null);
		setVideoSourcePath(null);
		setWebcamVideoPath(null);
		setWebcamVideoSourcePath(null);
		setCurrentProjectPath(null);
		setLastSavedSnapshot(null);
		// Reset undoable editor state + undo/redo history to a clean slate.
		resetState();
		// Reset non-undoable selection state.
		setSelectedZoomId(null);
		setSelectedTrimId(null);
		setSelectedSpeedId(null);
		setSelectedAnnotationId(null);
		setSelectedBlurId(null);
		// Reset playback.
		setCurrentTime(0);
		setIsPlaying(false);
		// Cursor look resets with the rest of the editor state above.
		// Reset region ID counters.
		nextZoomIdRef.current = 1;
		nextTrimIdRef.current = 1;
		nextSpeedIdRef.current = 1;
		nextAnnotationIdRef.current = 1;
		nextAnnotationZIndexRef.current = 1;
	}, [resetState]);

	const handleNewProject = useCallback(async () => {
		if (hasUnsavedChanges) {
			setConfirmDialogVariant("newProject");
			return;
		}
		await doNewProject();
	}, [hasUnsavedChanges, doNewProject]);

	const handleNewProjectConfirmSave = useCallback(async () => {
		setConfirmDialogVariant(null);
		const saved = await saveProject(false);
		if (saved) {
			await doNewProject();
		}
	}, [saveProject, doNewProject]);

	const handleNewProjectConfirmDiscard = useCallback(async () => {
		setConfirmDialogVariant(null);
		await doNewProject();
	}, [doNewProject]);

	// One dialog serves both departures that can cost unsaved work, so the pair of
	// handlers is looked up rather than picked apart with nested conditionals at the
	// call site. Going to the recorder is no longer one of them: it parks the project.
	const confirmHandlers = {
		newProject: { save: handleNewProjectConfirmSave, discard: handleNewProjectConfirmDiscard },
		loadProject: { save: handleLoadProjectConfirmSave, discard: handleLoadProjectConfirmDiscard },
	}[confirmDialogVariant ?? "newProject"];

	useEffect(() => {
		const removeNewProjectListener = window.electronAPI.onMenuNewProject(handleNewProject);
		const removeLoadListener = window.electronAPI.onMenuLoadProject(handleLoadProject);
		const removeSaveListener = window.electronAPI.onMenuSaveProject(handleSaveProject);
		const removeSaveAsListener = window.electronAPI.onMenuSaveProjectAs(handleSaveProjectAs);
		const removeLibraryListener = window.electronAPI.onMenuOpenLibrary?.(() =>
			setLibraryOpen(true),
		);

		return () => {
			removeNewProjectListener?.();
			removeLoadListener?.();
			removeSaveListener?.();
			removeSaveAsListener?.();
			removeLibraryListener?.();
		};
	}, [handleNewProject, handleLoadProject, handleSaveProject, handleSaveProjectAs]);

	useEffect(() => {
		let canceled = false;
		nativeBridgeClient.system
			.getPlatform()
			.then((platform) => {
				if (!canceled) {
					setNativePlatform(platform);
				}
			})
			.catch((error) => {
				console.warn("Unable to resolve native platform for cursor settings:", error);
				if (!canceled) {
					setNativePlatform(null);
				}
			});

		return () => {
			canceled = true;
		};
	}, []);

	useEffect(() => {
		if (cursorTelemetryError) {
			console.warn("Unable to load cursor telemetry:", cursorTelemetryError);
		}
	}, [cursorTelemetryError]);

	useEffect(() => {
		if (cursorRecordingDataError) {
			console.warn("Unable to load cursor recording data:", cursorRecordingDataError);
		}
	}, [cursorRecordingDataError]);

	function togglePlayPause() {
		const playback = videoPlaybackRef.current;
		const video = playback?.video;
		if (!playback || !video) return;

		if (isPlaying) {
			playback.pause();
		} else {
			playback.play().catch((err) => console.error("Video play failed:", err));
		}
	}

	const toggleFullscreen = useCallback(() => {
		setIsFullscreen((prev) => !prev);
	}, []);

	useEffect(() => {
		if (!isFullscreen) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setIsFullscreen(false);
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isFullscreen]);

	function handleSeek(time: number) {
		const video = videoPlaybackRef.current?.video;
		if (!video) return;
		video.currentTime = time;
	}

	const handleSelectZoom = useCallback((id: string | null) => {
		setSelectedZoomId(id);
		if (id) {
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
		}
	}, []);

	const handleSelectTrim = useCallback((id: string | null) => {
		setSelectedTrimId(id);
		if (id) {
			setSelectedZoomId(null);
			setSelectedSpeedId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
		}
	}, []);

	const handleSelectAnnotation = useCallback((id: string | null) => {
		setSelectedAnnotationId(id);
		if (id) {
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedBlurId(null);
		}
	}, []);

	const handleSelectBlur = useCallback((id: string | null) => {
		setSelectedBlurId(id);
		if (id) {
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedAnnotationId(null);
			setSelectedSpeedId(null);
		}
	}, []);

	const handleZoomAdded = useCallback(
		(span: Span) => {
			const id = `zoom-${nextZoomIdRef.current++}`;
			const newRegion: ZoomRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
				depth: DEFAULT_ZOOM_DEPTH,
				customScale: ZOOM_DEPTH_SCALES[DEFAULT_ZOOM_DEPTH],
				focus: { cx: 0.5, cy: 0.5 },
				// Auto-Focus on means new zooms follow the cursor too.
				focusMode: autoFocusAll ? "auto" : undefined,
				source: "manual",
			};
			pushState((prev) => ({ zoomRegions: [...prev.zoomRegions, newRegion] }));
			setSelectedZoomId(id);
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
		},
		[pushState, autoFocusAll],
	);

	// What the cursor did in this recording, read against the zooms already placed.
	// Shared by the on-load auto-suggest pass and the wand toggle; only the toggle
	// reports the outcome, since the on-load pass is not something the user asked for.
	const scanAutoZooms = useCallback(
		(existingRegions: ZoomRegion[]): ZoomSuggestionScan => {
			const totalMs = Math.round(duration * 1000);
			return findZoomSuggestions({
				cursorTelemetry,
				clickTimesMs: cursorClickTimestamps,
				totalMs,
				existingRegions,
				defaultDurationMs: Math.max(1000, Math.round(totalMs * 0.05)),
			});
		},
		[cursorTelemetry, cursorClickTimestamps, duration],
	);

	const zoomRegionsFrom = useCallback(
		(suggestions: AutoZoomSuggestion[]): ZoomRegion[] =>
			suggestions.map((suggestion) => ({
				id: `zoom-${nextZoomIdRef.current++}`,
				startMs: Math.round(suggestion.span.start),
				endMs: Math.round(suggestion.span.end),
				depth: DEFAULT_ZOOM_DEPTH,
				customScale: ZOOM_DEPTH_SCALES[DEFAULT_ZOOM_DEPTH],
				focus: clampFocusToDepth(suggestion.focus, DEFAULT_ZOOM_DEPTH),
				focusMode: autoFocusAll ? ("auto" as const) : undefined,
				source: "auto" as const,
			})),
		[autoFocusAll],
	);

	// Auto-suggest zooms once per fresh recording (no existing zooms, telemetry
	// available, wand enabled). Loaded projects are marked processed elsewhere so
	// they're never touched. The ref guard runs this once per source and survives undo.
	const autoProcessedSourceRef = useRef<string | null>(null);
	useEffect(() => {
		if (!autoZoomEnabled || !cursorTelemetrySourcePath) return;
		if (autoProcessedSourceRef.current === cursorTelemetrySourcePath) return;
		if (cursorTelemetry.length < 2 || duration <= 0) return;
		// Only auto-suggest for a fresh recording; don't disturb existing zooms.
		if (zoomRegions.length > 0) {
			autoProcessedSourceRef.current = cursorTelemetrySourcePath;
			return;
		}
		const scan = scanAutoZooms([]);
		autoProcessedSourceRef.current = cursorTelemetrySourcePath;
		if (!scan.ok) return;
		const newRegions = zoomRegionsFrom(scan.suggestions);
		pushState((prev) => ({ zoomRegions: [...prev.zoomRegions, ...newRegions] }));
	}, [
		autoZoomEnabled,
		cursorTelemetrySourcePath,
		cursorTelemetry,
		duration,
		zoomRegions,
		scanAutoZooms,
		zoomRegionsFrom,
		pushState,
	]);

	// Wand toggle: ON regenerates suggestions around existing zooms; OFF removes
	// only untouched auto zooms (manual, edited-to-manual, and agent-proposed
	// zooms survive — the user never asked the wand for those).
	const handleToggleAutoZoom = useCallback(
		(enabled: boolean) => {
			if (!enabled) {
				pushState((prev) => ({
					autoZoomEnabled: false,
					zoomRegions: prev.zoomRegions.filter((region) => region.source !== "auto"),
				}));
				return;
			}

			autoProcessedSourceRef.current = cursorTelemetrySourcePath;
			const scan = scanAutoZooms(zoomRegions);
			if (!scan.ok) {
				// The wand still turns on — it is a standing preference for this project,
				// not a one-shot — but silence here is what made it look broken.
				pushState({ autoZoomEnabled: true });
				toast.info(tTimeline(AUTO_ZOOM_REFUSAL_KEYS[scan.reason]), {
					description: tTimeline(AUTO_ZOOM_REFUSAL_DESCRIPTION_KEYS[scan.reason]),
				});
				return;
			}

			const newRegions = zoomRegionsFrom(scan.suggestions);
			pushState((prev) => ({
				autoZoomEnabled: true,
				zoomRegions: [...prev.zoomRegions, ...newRegions],
			}));
			toast.success(
				tTimeline(
					newRegions.length === 1
						? "success.addedZoomSuggestions"
						: "success.addedZoomSuggestionsPlural",
					{ count: String(newRegions.length) },
				),
			);
		},
		[pushState, scanAutoZooms, zoomRegionsFrom, zoomRegions, cursorTelemetrySourcePath, tTimeline],
	);

	// Flip every zoom between auto (cursor-follow) and manual at once.
	const handleToggleAutoFocusAll = useCallback(
		(on: boolean) => {
			pushState((prev) => ({
				autoFocusAll: on,
				zoomRegions: prev.zoomRegions.map((region) => ({
					...region,
					focusMode: on ? "auto" : "manual",
				})),
			}));
		},
		[pushState],
	);

	const handleTrimAdded = useCallback(
		(span: Span) => {
			const id = `trim-${nextTrimIdRef.current++}`;
			const newRegion: TrimRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
			};
			pushState((prev) => ({ trimRegions: [...prev.trimRegions, newRegion] }));
			setSelectedTrimId(id);
			setSelectedZoomId(null);
			setSelectedSpeedId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
		},
		[pushState],
	);

	/**
	 * Cutting the dead air out of the open recording.
	 *
	 * The detector and the peaks it reads already exist — for the waveform and for
	 * the agent's audio profile. What is decided here is what to do with them: the
	 * user's own trims are searched around and never touched, while the cuts this
	 * made last time are replaced wholesale, exactly as the auto-zoom wand does.
	 * Dragging one promotes it to manual, so an adjusted cut survives all of this.
	 */
	const [isScanningSilence, setIsScanningSilence] = useState(false);

	const hasSilenceCuts = useMemo(
		() => trimRegions.some((region) => region.source === "auto"),
		[trimRegions],
	);

	const silenceSettings = useMemo<SilenceTrimSettings>(
		() => ({
			sensitivity: silenceSensitivity,
			minPauseMs: silenceMinPauseMs,
			paddingMs: silencePaddingMs,
		}),
		[silenceSensitivity, silenceMinPauseMs, silencePaddingMs],
	);

	/** Turns a scan into the trims it stands for, or reports why there are none. */
	const silenceTrimsFrom = useCallback(
		(peaks: Float32Array | null, settings: SilenceTrimSettings, existing: TrimRegion[]) => {
			const scan = findSilenceCuts(peaks, Math.round(duration * 1000), settings, existing);
			if (!scan.ok) {
				toast.info(tTimeline(SILENCE_REFUSAL_KEYS[scan.reason]));
				return null;
			}
			return scan.cuts.map<TrimRegion>((cut) => ({
				id: `trim-${nextTrimIdRef.current++}`,
				startMs: cut.startMs,
				endMs: cut.endMs,
				source: "auto" as const,
			}));
		},
		[duration, tTimeline],
	);

	const handleRemoveSilence = useCallback(async () => {
		if (hasSilenceCuts) {
			pushState((prev) => ({
				trimRegions: prev.trimRegions.filter((region) => region.source !== "auto"),
			}));
			return;
		}
		if (!videoPath) return;

		setIsScanningSilence(true);
		try {
			const peaks = await decodeAudioPeaks(videoPath);
			const kept = trimRegions.filter((region) => region.source !== "auto");
			const added = silenceTrimsFrom(peaks, silenceSettings, kept);
			if (!added) return;
			pushState((prev) => ({
				trimRegions: [...prev.trimRegions.filter((region) => region.source !== "auto"), ...added],
			}));
		} finally {
			setIsScanningSilence(false);
		}
	}, [hasSilenceCuts, videoPath, trimRegions, silenceSettings, silenceTrimsFrom, pushState]);

	/**
	 * A setting moved. Re-cut in the same step, so tuning is one undo, not two.
	 *
	 * Only from peaks already decoded: this runs on every drag of a slider, and the
	 * decode has certainly happened by now — the cuts being adjusted came from it.
	 */
	const handleSilenceSettingsChange = useCallback(
		(patch: Partial<SilenceTrimSettings>) => {
			const next = { ...silenceSettings, ...patch };
			const fields = {
				silenceSensitivity: next.sensitivity,
				silenceMinPauseMs: next.minPauseMs,
				silencePaddingMs: next.paddingMs,
			};
			const peaks = hasSilenceCuts ? getCachedAudioPeaks(videoPath ?? undefined) : null;
			if (!peaks) {
				pushState(() => fields);
				return;
			}
			const kept = trimRegions.filter((region) => region.source !== "auto");
			const added = silenceTrimsFrom(peaks, next, kept);
			pushState((prev) => ({
				...fields,
				trimRegions: [
					...prev.trimRegions.filter((region) => region.source !== "auto"),
					...(added ?? []),
				],
			}));
		},
		[silenceSettings, hasSilenceCuts, videoPath, trimRegions, silenceTrimsFrom, pushState],
	);

	/**
	 * Speeding up the stretches where nothing is happening.
	 *
	 * The sibling of the dead-air cuts and built the same way, on the same two
	 * analyses the agent already uses. It keeps out of the cuts' way rather than
	 * competing with them: a stretch that already carries a trim or a speed of the
	 * user's own is a question that has been answered.
	 */
	const [isScanningBoring, setIsScanningBoring] = useState(false);

	const hasTimelapse = useMemo(
		() => speedRegions.some((region) => region.source === "auto"),
		[speedRegions],
	);

	const timelapseSettings = useMemo<TimelapseSettings>(
		() => ({
			sensitivity: silenceSensitivity,
			speed: timelapseSpeed,
			minBoringMs: timelapseMinMs,
		}),
		[silenceSensitivity, timelapseSpeed, timelapseMinMs],
	);

	const timelapseRegionsFrom = useCallback(
		(peaks: Float32Array | null, settings: TimelapseSettings, keptSpeeds: SpeedRegion[]) => {
			const scan = findBoringStretches(
				peaks,
				Math.round(duration * 1000),
				cursorClickTimestamps,
				settings,
				trimRegions,
				keptSpeeds,
			);
			if (!scan.ok) {
				toast.info(tTimeline(TIMELAPSE_REFUSAL_KEYS[scan.reason]));
				return null;
			}
			return scan.stretches.map<SpeedRegion>((stretch) => ({
				id: `speed-${nextSpeedIdRef.current++}`,
				startMs: stretch.startMs,
				endMs: stretch.endMs,
				speed: clampPlaybackSpeed(settings.speed),
				source: "auto" as const,
			}));
		},
		[duration, cursorClickTimestamps, trimRegions, tTimeline],
	);

	const handleTimelapse = useCallback(async () => {
		if (hasTimelapse) {
			pushState((prev) => ({
				speedRegions: prev.speedRegions.filter((region) => region.source !== "auto"),
			}));
			return;
		}
		if (!videoPath) return;

		setIsScanningBoring(true);
		try {
			const peaks = await decodeAudioPeaks(videoPath);
			const kept = speedRegions.filter((region) => region.source !== "auto");
			const added = timelapseRegionsFrom(peaks, timelapseSettings, kept);
			if (!added) return;
			pushState((prev) => ({
				speedRegions: [...prev.speedRegions.filter((region) => region.source !== "auto"), ...added],
			}));
		} finally {
			setIsScanningBoring(false);
		}
	}, [hasTimelapse, videoPath, speedRegions, timelapseSettings, timelapseRegionsFrom, pushState]);

	const handleTimelapseSettingsChange = useCallback(
		(patch: Partial<TimelapseSettings>) => {
			const next = { ...timelapseSettings, ...patch };
			const fields = { timelapseSpeed: next.speed, timelapseMinMs: next.minBoringMs };
			const peaks = hasTimelapse ? getCachedAudioPeaks(videoPath ?? undefined) : null;
			if (!peaks) {
				pushState(() => fields);
				return;
			}
			const kept = speedRegions.filter((region) => region.source !== "auto");
			const added = timelapseRegionsFrom(peaks, next, kept);
			pushState((prev) => ({
				...fields,
				speedRegions: [
					...prev.speedRegions.filter((region) => region.source !== "auto"),
					...(added ?? []),
				],
			}));
		},
		[timelapseSettings, hasTimelapse, videoPath, speedRegions, timelapseRegionsFrom, pushState],
	);

	const handleZoomSpanChange = useCallback(
		(id: string, span: Span) => {
			pushState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) =>
					region.id === id
						? {
								...region,
								startMs: Math.round(span.start),
								endMs: Math.round(span.end),
								source: "manual",
							}
						: region,
				),
			}));
		},
		[pushState],
	);

	const handleTrimSpanChange = useCallback(
		(id: string, span: Span) => {
			pushState((prev) => ({
				trimRegions: prev.trimRegions.map((region) =>
					region.id === id
						? {
								...region,
								startMs: Math.round(span.start),
								endMs: Math.round(span.end),
								// Adjusting a proposal is accepting it: it must not be
								// swept away by "discard proposals" afterwards.
								source: "manual" as const,
							}
						: region,
				),
			}));
		},
		[pushState],
	);

	// Focus drag: updateState for live preview, commitState on pointer-up.
	const handleZoomFocusChange = useCallback(
		(id: string, focus: ZoomFocus) => {
			updateState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) =>
					region.id === id
						? { ...region, focus: clampFocusToDepth(focus, region.depth), source: "manual" }
						: region,
				),
			}));
		},
		[updateState],
	);

	const handleZoomDepthChange = useCallback(
		(depth: ZoomDepth) => {
			if (!selectedZoomId) return;
			pushState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) =>
					region.id === selectedZoomId
						? {
								...region,
								depth,
								customScale: ZOOM_DEPTH_SCALES[depth],
								focus: clampFocusToDepth(region.focus, depth),
								source: "manual",
							}
						: region,
				),
			}));
		},
		[selectedZoomId, pushState],
	);

	const handleZoomCustomScaleChange = useCallback(
		(scale: number) => {
			if (!selectedZoomId) return;
			const rounded = Math.round(scale * 100) / 100;
			if (!Number.isFinite(rounded)) return;
			updateState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) =>
					region.id === selectedZoomId
						? { ...region, customScale: rounded, source: "manual" }
						: region,
				),
			}));
		},
		[selectedZoomId, updateState],
	);

	const handleZoomCustomScaleCommit = useCallback(() => {
		commitState();
	}, [commitState]);

	const handleZoomFocusModeChange = useCallback(
		(focusMode: ZoomFocusMode) => {
			if (!selectedZoomId) return;
			pushState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) =>
					region.id === selectedZoomId ? { ...region, focusMode, source: "manual" } : region,
				),
			}));
		},
		[selectedZoomId, pushState],
	);

	const handleZoomDelete = useCallback(
		(id: string) => {
			pushState((prev) => ({
				zoomRegions: prev.zoomRegions.filter((r) => r.id !== id),
			}));
			if (selectedZoomId === id) {
				setSelectedZoomId(null);
			}
		},
		[selectedZoomId, pushState],
	);

	const handleZoomRotationPresetChange = useCallback(
		(preset: Rotation3DPreset | null) => {
			if (!selectedZoomId) return;
			pushState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) => {
					if (region.id !== selectedZoomId) return region;
					if (preset === null) {
						const { rotationPreset: _p, ...rest } = region;
						return { ...rest, source: "manual" };
					}
					return { ...region, rotationPreset: preset, source: "manual" };
				}),
			}));
		},
		[selectedZoomId, pushState],
	);

	const handleTrimDelete = useCallback(
		(id: string) => {
			pushState((prev) => ({
				trimRegions: prev.trimRegions.filter((r) => r.id !== id),
			}));
			if (selectedTrimId === id) {
				setSelectedTrimId(null);
			}
		},
		[selectedTrimId, pushState],
	);

	const handleSelectSpeed = useCallback((id: string | null) => {
		setSelectedSpeedId(id);
		if (id) {
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
		}
	}, []);

	const handleSpeedAdded = useCallback(
		(span: Span) => {
			const id = `speed-${nextSpeedIdRef.current++}`;
			const newRegion: SpeedRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
				speed: DEFAULT_PLAYBACK_SPEED,
			};
			pushState((prev) => ({
				speedRegions: [...prev.speedRegions, newRegion],
			}));
			setSelectedSpeedId(id);
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
		},
		[pushState],
	);

	const handleSpeedSpanChange = useCallback(
		(id: string, span: Span) => {
			pushState((prev) => ({
				speedRegions: prev.speedRegions.map((region) =>
					region.id === id
						? {
								...region,
								startMs: Math.round(span.start),
								endMs: Math.round(span.end),
								// Adjusting a proposal is accepting it: it must not be
								// swept away by "discard proposals" afterwards.
								source: "manual" as const,
							}
						: region,
				),
			}));
		},
		[pushState],
	);

	const handleSpeedDelete = useCallback(
		(id: string) => {
			pushState((prev) => ({
				speedRegions: prev.speedRegions.filter((region) => region.id !== id),
			}));
			if (selectedSpeedId === id) {
				setSelectedSpeedId(null);
			}
		},
		[selectedSpeedId, pushState],
	);

	const handleSpeedChange = useCallback(
		(speed: PlaybackSpeed) => {
			if (!selectedSpeedId) return;
			pushState((prev) => ({
				speedRegions: prev.speedRegions.map((region) =>
					region.id === selectedSpeedId ? owned({ ...region, speed }) : region,
				),
			}));
		},
		[selectedSpeedId, pushState],
	);

	const handleAnnotationAdded = useCallback(
		(span: Span) => {
			const id = `annotation-${nextAnnotationIdRef.current++}`;
			const zIndex = nextAnnotationZIndexRef.current++;
			const newRegion: AnnotationRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
				type: "text",
				content: "Enter text...",
				position: { ...DEFAULT_ANNOTATION_POSITION },
				size: { ...DEFAULT_ANNOTATION_SIZE },
				style: { ...DEFAULT_ANNOTATION_STYLE },
				zIndex,
			};
			pushState((prev) => ({
				annotationRegions: [...prev.annotationRegions, newRegion],
			}));
			setSelectedAnnotationId(id);
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedBlurId(null);
		},
		[pushState],
	);

	const handleBlurAdded = useCallback(
		(span: Span) => {
			const id = `annotation-${nextAnnotationIdRef.current++}`;
			const zIndex = nextAnnotationZIndexRef.current++;
			const newRegion: AnnotationRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
				type: "blur",
				content: "",
				position: { ...DEFAULT_ANNOTATION_POSITION },
				size: { ...DEFAULT_ANNOTATION_SIZE },
				style: { ...DEFAULT_ANNOTATION_STYLE },
				zIndex,
				blurData: { ...DEFAULT_BLUR_DATA },
			};
			pushState((prev) => ({
				annotationRegions: [...prev.annotationRegions, newRegion],
			}));
			setSelectedBlurId(id);
			setSelectedAnnotationId(null);
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
		},
		[pushState],
	);

	const handleAnnotationSpanChange = useCallback(
		(id: string, span: Span) => {
			pushState((prev) => {
				const editedAutoCaption =
					prev.annotationRegions.find((region) => region.id === id)?.annotationSource ===
					"auto-caption";
				const next = prev.annotationRegions.map((region) =>
					region.id === id
						? {
								...region,
								startMs: Math.round(span.start),
								endMs: Math.round(span.end),
								// Adjusting a proposal is accepting it: it must not be
								// swept away by "discard proposals" afterwards.
								source: "manual" as const,
							}
						: region,
				);
				return {
					annotationRegions: editedAutoCaption ? reconcileAutoCaptionTimelineGaps(next) : next,
				};
			});
		},
		[pushState],
	);

	const handleAnnotationDuplicate = useCallback(
		(id: string) => {
			const duplicateId = `annotation-${nextAnnotationIdRef.current++}`;
			const duplicateZIndex = nextAnnotationZIndexRef.current++;
			pushState((prev) => {
				const source = prev.annotationRegions.find((region) => region.id === id);
				if (!source) return {};

				const { annotationSource: _stripCaptionLink, ...sourceWithoutCaptionLink } = source;

				const duplicate: AnnotationRegion = {
					...sourceWithoutCaptionLink,
					id: duplicateId,
					zIndex: duplicateZIndex,
					position: { x: source.position.x + 4, y: source.position.y + 4 },
					size: { ...source.size },
					style: { ...source.style },
					figureData: source.figureData ? { ...source.figureData } : undefined,
				};

				return { annotationRegions: [...prev.annotationRegions, duplicate] };
			});
			setSelectedAnnotationId(duplicateId);
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedBlurId(null);
		},
		[pushState],
	);

	const handleAnnotationDelete = useCallback(
		(id: string) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.filter((r) => r.id !== id),
			}));
			if (selectedAnnotationId === id) {
				setSelectedAnnotationId(null);
			}
			if (selectedBlurId === id) {
				setSelectedBlurId(null);
			}
		},
		[selectedAnnotationId, selectedBlurId, pushState],
	);

	const handleAnnotationContentChange = useCallback(
		(id: string, content: string) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) => {
					if (region.id !== id) return region;
					if (region.type === "text") {
						return owned({ ...region, content, textContent: content });
					} else if (region.type === "image") {
						return owned({ ...region, content, imageContent: content });
					}
					return owned({ ...region, content });
				}),
			}));
		},
		[pushState],
	);

	const handleAnnotationTypeChange = useCallback(
		(id: string, type: AnnotationRegion["type"]) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) => {
					if (region.id !== id) return region;
					const updatedRegion = owned({ ...region, type });
					if (type === "text") {
						updatedRegion.content = region.textContent || "Enter text...";
					} else if (type === "image") {
						updatedRegion.content = region.imageContent || "";
					} else if (type === "figure") {
						updatedRegion.content = "";
						if (!region.figureData) {
							updatedRegion.figureData = { ...DEFAULT_FIGURE_DATA };
						}
					} else if (type === "blur") {
						updatedRegion.content = "";
						if (!region.blurData) {
							updatedRegion.blurData = { ...DEFAULT_BLUR_DATA };
						}
					}
					return updatedRegion;
				}),
			}));

			if (type === "blur" && selectedAnnotationId === id) {
				setSelectedAnnotationId(null);
				setSelectedBlurId(id);
				setSelectedSpeedId(null);
			} else if (type !== "blur" && selectedBlurId === id) {
				setSelectedBlurId(null);
				setSelectedAnnotationId(id);
			}
		},
		[pushState, selectedAnnotationId, selectedBlurId],
	);

	const handleAnnotationStyleChange = useCallback(
		(id: string, style: Partial<AnnotationRegion["style"]>) => {
			pushState((prev) => {
				const touched = prev.annotationRegions.find((r) => r.id === id);
				const syncAutoCaptions = touched?.annotationSource === "auto-caption";
				return {
					annotationRegions: prev.annotationRegions.map((region) => {
						if (syncAutoCaptions && region.annotationSource === "auto-caption") {
							return owned({ ...region, style: { ...region.style, ...style } });
						}
						return region.id === id
							? owned({ ...region, style: { ...region.style, ...style } })
							: region;
					}),
				};
			});
		},
		[pushState],
	);

	const handleAnnotationFigureDataChange = useCallback(
		(id: string, figureData: FigureData) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) =>
					region.id === id ? owned({ ...region, figureData }) : region,
				),
			}));
		},
		[pushState],
	);

	const handleBlurDataPreviewChange = useCallback(
		(id: string, blurData: BlurData) => {
			updateState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) =>
					region.id === id
						? {
								...region,
								blurData,
								// Freehand drawing area is the full video surface.
								...(blurData.shape === "freehand"
									? {
											position: { x: 0, y: 0 },
											size: { width: 100, height: 100 },
										}
									: {}),
							}
						: region,
				),
			}));
		},
		[updateState],
	);

	const handleBlurDataPanelChange = useCallback(
		(id: string, blurData: BlurData) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) =>
					region.id === id
						? {
								...region,
								blurData,
								...(blurData.shape === "freehand"
									? {
											position: { x: 0, y: 0 },
											size: { width: 100, height: 100 },
										}
									: {}),
							}
						: region,
				),
			}));
		},
		[pushState],
	);

	const handleAnnotationPositionChange = useCallback(
		(id: string, position: { x: number; y: number }) => {
			pushState((prev) => {
				const moved = prev.annotationRegions.find((r) => r.id === id);
				const syncAutoCaptions = moved?.annotationSource === "auto-caption";
				return {
					annotationRegions: prev.annotationRegions.map((region) => {
						if (syncAutoCaptions && region.annotationSource === "auto-caption") {
							return owned({ ...region, position });
						}
						return region.id === id ? owned({ ...region, position }) : region;
					}),
				};
			});
		},
		[pushState],
	);

	const handleAnnotationSizeChange = useCallback(
		(id: string, size: { width: number; height: number }) => {
			pushState((prev) => {
				const resized = prev.annotationRegions.find((r) => r.id === id);
				const syncAutoCaptions = resized?.annotationSource === "auto-caption";
				return {
					annotationRegions: prev.annotationRegions.map((region) => {
						if (syncAutoCaptions && region.annotationSource === "auto-caption") {
							return owned({ ...region, size });
						}
						return region.id === id ? owned({ ...region, size }) : region;
					}),
				};
			});
		},
		[pushState],
	);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const mod = e.ctrlKey || e.metaKey;
			const key = e.key.toLowerCase();

			if (mod && key === "z" && !e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				undo();
				return;
			}
			if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
				e.preventDefault();
				e.stopPropagation();
				redo();
				return;
			}

			// The sequence preview has its own clock and handles its own keys; stepping
			// or starting the editor's hidden player underneath would only make noise.
			if (sequencePreviewOpenRef.current) return;

			// Frame-step navigation (arrow keys, no modifiers)
			if (
				(e.key === "ArrowLeft" || e.key === "ArrowRight") &&
				!e.ctrlKey &&
				!e.metaKey &&
				!e.shiftKey &&
				!e.altKey
			) {
				const target = e.target;
				if (
					target instanceof HTMLInputElement ||
					target instanceof HTMLTextAreaElement ||
					target instanceof HTMLSelectElement ||
					(target instanceof HTMLElement &&
						(target.isContentEditable ||
							target.closest('[role="separator"], [role="slider"], [role="spinbutton"]')))
				) {
					return;
				}
				e.preventDefault();
				const video = videoPlaybackRef.current?.video;
				if (!video) {
					return;
				}
				const direction = e.key === "ArrowLeft" ? "backward" : "forward";
				const newTime = computeFrameStepTime(
					video.currentTime,
					Number.isFinite(video.duration) ? video.duration : durationRef.current,
					direction,
				);
				video.currentTime = newTime;
				return;
			}

			const isInput =
				e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

			if (e.key === "Tab" && !isInput) {
				e.preventDefault();
			}

			if (matchesShortcut(e, shortcuts.playPause, isMac)) {
				// Let space pass through inside inputs/textareas.
				if (isInput) {
					return;
				}
				e.preventDefault();
				const playback = videoPlaybackRef.current;
				if (playback?.video) {
					playback.video.paused ? playback.play().catch(console.error) : playback.pause();
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown, { capture: true });
		return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
	}, [undo, redo, shortcuts, isMac]);

	useEffect(() => {
		if (selectedZoomId && !zoomRegions.some((region) => region.id === selectedZoomId)) {
			setSelectedZoomId(null);
		}
	}, [selectedZoomId, zoomRegions]);

	useEffect(() => {
		if (selectedTrimId && !trimRegions.some((region) => region.id === selectedTrimId)) {
			setSelectedTrimId(null);
		}
	}, [selectedTrimId, trimRegions]);

	useEffect(() => {
		if (
			selectedAnnotationId &&
			!annotationOnlyRegions.some((region) => region.id === selectedAnnotationId)
		) {
			setSelectedAnnotationId(null);
		}
		if (selectedBlurId && !blurRegions.some((region) => region.id === selectedBlurId)) {
			setSelectedBlurId(null);
		}
	}, [selectedAnnotationId, selectedBlurId, annotationOnlyRegions, blurRegions]);

	useEffect(() => {
		if (selectedSpeedId && !speedRegions.some((region) => region.id === selectedSpeedId)) {
			setSelectedSpeedId(null);
		}
	}, [selectedSpeedId, speedRegions]);

	const handleShowExportedFile = useCallback(async (filePath: string) => {
		try {
			const result = await window.electronAPI.revealInFolder(filePath);
			if (!result.success) {
				const errorMessage = result.error || result.message || "Failed to reveal item in folder.";
				console.error("Failed to reveal in folder:", errorMessage);
				toast.error(errorMessage);
			}
		} catch (error) {
			const errorMessage = String(error);
			console.error("Error calling revealInFolder IPC:", errorMessage);
			toast.error(`Error revealing in folder: ${errorMessage}`);
		}
	}, []);

	const handleExportSaved = useCallback(
		(formatLabel: "GIF" | "Video", filePath: string) => {
			setExportedFilePath(filePath);
			const folder = parentDirectoryOf(filePath);
			if (folder) {
				saveUserPreferences({ exportFolder: folder });
			}
			toast.success(
				t("export.exportedSuccessfully", {
					format: formatLabel,
				}),
				{
					description: filePath,
					action: {
						label: rawT("common.actions.showInFolder"),
						onClick: () => {
							void handleShowExportedFile(filePath);
						},
					},
				},
			);
		},
		[handleShowExportedFile, t, rawT],
	);

	const handleSaveUnsavedExport = useCallback(async () => {
		if (!unsavedExport) return;
		try {
			const pickResult = await window.electronAPI.pickExportSavePath(
				unsavedExport.fileName,
				getExportFolder(),
			);
			if (pickResult.canceled || !pickResult.success || !pickResult.path) {
				toast.info("Export canceled");
				return;
			}
			const saveResult = await window.electronAPI.writeExportToPath(
				unsavedExport.arrayBuffer,
				pickResult.path,
			);
			if (saveResult.success && saveResult.path) {
				setUnsavedExport(null);
				handleExportSaved(unsavedExport.format === "gif" ? "GIF" : "Video", saveResult.path);
			} else {
				toast.error(
					buildSaveDiagnosticMessage(
						unsavedExport.format === "gif" ? "GIF" : "Video",
						saveResult.message || "Failed to save export",
					),
				);
			}
		} catch (error) {
			console.error("Error saving unsaved export:", error);
			toast.error(
				buildSaveDiagnosticMessage(
					unsavedExport.format === "gif" ? "GIF" : "Video",
					error instanceof Error ? error.message : "Failed to save exported video",
				),
			);
		}
	}, [unsavedExport, handleExportSaved]);

	/** Everything recorded so far, opened from the File menu or the launch screen. */
	const [libraryOpen, setLibraryOpen] = useState(false);

	/** Same landing place as picking a file, minus the file dialog. */
	const handleInsertFromLibrary = useCallback(
		(picked: string) => {
			pushState((prev) => ({ clips: addRecording(prev.clips, { screenVideoPath: picked }) }));
		},
		[pushState],
	);

	/** Adds a video file as another recording at the end, without switching to it. */
	const handleAddVideoClip = useCallback(async () => {
		const result = await window.electronAPI.pickVideoClip();
		if (result.canceled) return;
		const picked = result.path;
		if (!result.success || !picked) {
			toast.error(tTimeline("clips.addVideoFailed"));
			return;
		}
		pushState((prev) => ({ clips: addRecording(prev.clips, { screenVideoPath: picked }) }));
	}, [pushState, tTimeline]);

	const handleRemoveRecording = useCallback(
		(id: string) => {
			pushState((prev) => ({ clips: removeRecording(prev.clips, id, prev.activeClipId) }));
		},
		[pushState],
	);

	/**
	 * Opens another recording for editing.
	 *
	 * This starts a fresh undo history, the same as opening a project does. The
	 * video on screen lives outside the history, so undo that reached back past the
	 * switch would put the previous recording's edits over this recording's video.
	 *
	 * It does not make the project dirty: every recording's media and edits are
	 * written the same way whichever one is being edited, so the saved file is
	 * unchanged by switching.
	 */
	const handleActivateRecording = useCallback(
		(id: string) => {
			const media = currentProjectMedia;
			if (!media) return;
			const current = editorStateRef.current;
			const result = checkoutRecording(
				current.clips,
				current.activeClipId,
				media,
				{
					cropRegion: current.cropRegion,
					zoomRegions: current.zoomRegions,
					trimRegions: current.trimRegions,
					speedRegions: current.speedRegions,
					annotationRegions: current.annotationRegions,
				},
				id,
			);
			if (!result) return;

			try {
				videoPlaybackRef.current?.pause();
			} catch {
				// no-op
			}
			setIsPlaying(false);
			setCurrentTime(0);
			const inferredDurationMs = Math.max(
				0,
				...result.editor.zoomRegions.map((region) => region.endMs),
				...result.editor.trimRegions.map((region) => region.endMs),
				...result.editor.speedRegions.map((region) => region.endMs),
				...result.editor.annotationRegions.map((region) => region.endMs),
			);
			setDuration(inferredDurationMs > 0 ? inferredDurationMs / 1000 : 0);

			const { screenVideoPath, webcamVideoPath: webcamSource } = result.media;
			setVideoSourcePath(screenVideoPath);
			setVideoPath(toFileUrl(screenVideoPath));
			setWebcamVideoSourcePath(webcamSource ?? null);
			setWebcamVideoPath(webcamSource ? toFileUrl(webcamSource) : null);
			setRecordingCursorCaptureMode(result.media.cursorCaptureMode ?? null);
			// Its zooms are whatever it already has, even none: never auto-suggest over them.
			autoProcessedSourceRef.current = screenVideoPath;

			resetState({
				...current,
				...result.editor,
				clips: result.clips,
				activeClipId: result.activeClipId,
			});

			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
			setSelectedCardId(null);

			nextZoomIdRef.current = deriveNextId(
				"zoom",
				result.editor.zoomRegions.map((region) => region.id),
			);
			nextTrimIdRef.current = deriveNextId(
				"trim",
				result.editor.trimRegions.map((region) => region.id),
			);
			nextSpeedIdRef.current = deriveNextId(
				"speed",
				result.editor.speedRegions.map((region) => region.id),
			);
			nextAnnotationIdRef.current = deriveNextId(
				"annotation",
				result.editor.annotationRegions.map((region) => region.id),
			);
			nextAnnotationZIndexRef.current =
				result.editor.annotationRegions.reduce((max, region) => Math.max(max, region.zIndex), 0) +
				1;
		},
		[currentProjectMedia, resetState],
	);

	/**
	 * A recording's cursor files, read once per file.
	 *
	 * Only the open recording's cursor data is loaded by the editor itself; the rest
	 * is read on demand — by the export, the sequence preview and an agent asking
	 * about another clip. None of it changes once recorded, so it is cached.
	 */
	const loadClipCursorFiles = useCallback((sourcePath: string) => {
		let files = inactiveCursorCacheRef.current.get(sourcePath);
		if (!files) {
			files = Promise.all([
				nativeBridgeClient.cursor.getTelemetry(sourcePath).catch(() => []),
				nativeBridgeClient.cursor.getRecordingData(sourcePath).catch(() => null),
			]);
			inactiveCursorCacheRef.current.set(sourcePath, files);
		}
		return files;
	}, []);

	const loadClipTelemetry = useCallback(
		async (sourcePath: string) => (await loadClipCursorFiles(sourcePath))[0],
		[loadClipCursorFiles],
	);

	/**
	 * Every clip in order, as both the export and the sequence preview need it.
	 *
	 * The open recording contributes what the editor already has loaded. Every other
	 * recording's cursor data is read from its files (once), because nothing else has
	 * loaded it, and is gated exactly like the open one's — a take whose cursor is
	 * baked into the picture gets no overlay, or it would show two cursors.
	 */
	const buildSequenceEntries = useCallback(async (): Promise<SequenceEntry[]> => {
		if (!videoPath) return [];

		const sequence: SequenceEntry[] = [];
		for (const clip of clips) {
			if (clip.kind === "card") {
				sequence.push({
					id: clip.id,
					clip: {
						kind: "card",
						card: { durationMs: normalizeCardDurationMs(clip.durationMs), title: clip.title },
					},
				});
				continue;
			}

			if (clip.id === activeClipId) {
				sequence.push({
					id: clip.id,
					clip: {
						kind: "recording",
						recording: {
							videoUrl: videoPath,
							webcamVideoUrl: webcamVideoPath || undefined,
							zoomRegions,
							trimRegions,
							speedRegions,
							annotationRegions,
							cropRegion,
							cursorRecordingData: hasEditableCursorRecording ? cursorRecordingData : null,
							cursorTelemetry,
							cursorClickTimestamps,
						},
					},
				});
				continue;
			}

			if (!clip.media || !clip.editor) continue;
			const sourcePath = clip.media.screenVideoPath;
			const [telemetry, recordingData] = await loadClipCursorFiles(sourcePath);
			const overlay = hasEditableCursorOverlay(
				clip.media.cursorCaptureMode,
				nativePlatform,
				recordingData,
			);

			sequence.push({
				id: clip.id,
				clip: {
					kind: "recording",
					recording: {
						videoUrl: toFileUrl(sourcePath),
						webcamVideoUrl: clip.media.webcamVideoPath
							? toFileUrl(clip.media.webcamVideoPath)
							: undefined,
						zoomRegions: clip.editor.zoomRegions,
						trimRegions: clip.editor.trimRegions,
						speedRegions: clip.editor.speedRegions,
						annotationRegions: clip.editor.annotationRegions,
						cropRegion: clip.editor.cropRegion,
						cursorRecordingData: overlay ? recordingData : null,
						cursorTelemetry: telemetry,
						cursorClickTimestamps: clickTimestampsFrom(recordingData, telemetry),
					},
				},
			});
		}
		return sequence;
	}, [
		clips,
		activeClipId,
		videoPath,
		webcamVideoPath,
		zoomRegions,
		trimRegions,
		speedRegions,
		annotationRegions,
		cropRegion,
		hasEditableCursorRecording,
		cursorRecordingData,
		cursorTelemetry,
		cursorClickTimestamps,
		nativePlatform,
		loadClipCursorFiles,
	]);

	/**
	 * What to export once the project holds more than one recording.
	 *
	 * With a single recording this returns undefined and the export keeps its classic
	 * shape, which is the only one the source-copy fast path accepts.
	 */
	const buildExportSequence = useCallback(async (): Promise<ExportSequenceClip[] | undefined> => {
		if (recordingEntries(clips).length < 2 || !videoPath) return undefined;
		return (await buildSequenceEntries()).map((entry) => entry.clip);
	}, [clips, videoPath, buildSequenceEntries]);

	// While the sequence is being watched it follows every edit, so what plays is
	// always what would be exported.
	useEffect(() => {
		if (!sequencePreviewOpen) {
			setSequenceEntries(null);
			return;
		}
		let cancelled = false;
		void buildSequenceEntries().then((entries) => {
			if (!cancelled) setSequenceEntries(entries);
		});
		return () => {
			cancelled = true;
		};
	}, [sequencePreviewOpen, buildSequenceEntries]);

	const openSequencePreview = useCallback(() => {
		try {
			videoPlaybackRef.current?.pause();
		} catch {
			// no-op
		}
		setSequencePreviewOpen(true);
	}, []);

	const closeSequencePreview = useCallback(() => setSequencePreviewOpen(false), []);

	// The exporter is told only "these stills come first, these come last" — it has
	// no business knowing about the project's clip model. Splitting at the recording
	// is what turns one into the other.
	const exportCards = useMemo(() => {
		const at = recordingIndex(clips);
		const toCard = (clip: ClipEntry) => ({
			durationMs: normalizeCardDurationMs(clip.durationMs),
			title: clip.title,
		});
		if (at === -1) return { before: [], after: clips.filter(isCardEntry).map(toCard) };
		return {
			before: clips.slice(0, at).filter(isCardEntry).map(toCard),
			after: clips
				.slice(at + 1)
				.filter(isCardEntry)
				.map(toCard),
		};
	}, [clips]);

	const handleExport = useCallback(
		async (settings: ExportSettings, targetPathOverride?: string) => {
			// handleExport reports through toasts and component state, which a
			// programmatic caller cannot observe. This carries the outcome back.
			exportOutcomeRef.current = null;
			if (!videoPath) {
				toast.error("No video loaded");
				return;
			}

			const video = videoPlaybackRef.current?.video;
			if (!video) {
				toast.error("Video not ready");
				return;
			}

			// Pick the save path before exporting, otherwise the save dialog can end up
			// hidden behind other windows after a long-running export. An agent-driven
			// export brings its own path, already checked against the export folder.
			let targetPath = targetPathOverride;
			if (!targetPath) {
				const isGifFormat = settings.format === "gif";
				const targetFileName = `export-${Date.now()}.${isGifFormat ? "gif" : "mp4"}`;
				const pickResult = await window.electronAPI.pickExportSavePath(
					targetFileName,
					getExportFolder(),
				);
				if (pickResult.canceled || !pickResult.success || !pickResult.path) {
					setShowExportDialog(false);
					return;
				}
				targetPath = pickResult.path;
			}
			// Named from the path actually being written, so the fallback that keeps an
			// unsaved export in memory suggests the same name the user just saw.
			const targetFileName = lastPathSegment(targetPath) || `export-${Date.now()}`;

			setSequencePreviewOpen(false);
			setIsExporting(true);
			setExportProgress(null);
			setExportError(null);
			setExportedFilePath(null);

			try {
				const wasPlaying = isPlaying;
				if (wasPlaying) {
					videoPlaybackRef.current?.pause();
				}

				const sourceWidth = video.videoWidth || DEFAULT_SOURCE_DIMENSIONS.width;
				const sourceHeight = video.videoHeight || DEFAULT_SOURCE_DIMENSIONS.height;
				const effectiveSourceDimensions = calculateEffectiveSourceDimensions(
					sourceWidth,
					sourceHeight,
					cropRegion,
				);
				const aspectRatioValue =
					aspectRatio === "native"
						? getNativeAspectRatioValue(sourceWidth, sourceHeight, cropRegion)
						: getAspectRatioValue(aspectRatio);

				// Preview container dimensions, used for scaling.
				const playbackRef = videoPlaybackRef.current;
				const containerElement = playbackRef?.containerRef?.current;
				const previewWidth = containerElement?.clientWidth || DEFAULT_SOURCE_DIMENSIONS.width;
				const previewHeight = containerElement?.clientHeight || DEFAULT_SOURCE_DIMENSIONS.height;

				// Several recordings go out as a sequence; one keeps the classic shape.
				const exportSequence = await buildExportSequence();
				// In a sequence each recording decides for itself whether it has an overlay
				// cursor to draw, so the global scale only says whether cursors are shown.
				const exportCursorScale = exportSequence
					? showCursor
						? cursorSize
						: 0
					: effectiveShowCursor
						? cursorSize
						: 0;

				if (settings.format === "gif" && settings.gifConfig) {
					// GIF Export
					const gifExporter = new GifExporter({
						videoUrl: videoPath,
						webcamVideoUrl: webcamVideoPath || undefined,
						width: settings.gifConfig.width,
						height: settings.gifConfig.height,
						frameRate: settings.gifConfig.frameRate,
						loop: settings.gifConfig.loop,
						sizePreset: settings.gifConfig.sizePreset,
						wallpaper,
						cards: exportCards,
						sequence: exportSequence,
						zoomRegions,
						trimRegions,
						speedRegions,
						showShadow: shadowIntensity > 0,
						shadowIntensity,
						showBlur,
						motionBlurAmount,
						transitionStyle,
						transitionMs,
						borderRadius,
						padding,
						videoPadding: padding,
						cropRegion,
						cursorRecordingData,
						cursorScale: exportCursorScale,
						cursorSmoothing,
						cursorMotionBlur,
						cursorClickBounce,
						cursorClickRipple,
						cursorClipToBounds,
						cursorTheme,
						annotationRegions,
						webcamLayoutPreset,
						webcamMaskShape,
						webcamMirrored,
						webcamReactiveZoom,
						webcamSizePreset,
						webcamPosition,
						previewWidth,
						previewHeight,
						cursorTelemetry,
						cursorClickTimestamps,
						onProgress: (progress: ExportProgress) => {
							setExportProgress(progress);
						},
					});

					exporterRef.current = gifExporter as unknown as VideoExporter;
					const result = await gifExporter.export();

					if (result.success && result.blob) {
						const arrayBuffer = await result.blob.arrayBuffer();

						if (result.warnings) {
							for (const warning of result.warnings) {
								toast.warning(warning);
							}
						}

						const saveResult = await window.electronAPI.writeExportToPath(arrayBuffer, targetPath);

						if (saveResult.success && saveResult.path) {
							setUnsavedExport(null);
							exportOutcomeRef.current = { ok: true, path: saveResult.path };
							handleExportSaved("GIF", saveResult.path);
						} else {
							setUnsavedExport({ arrayBuffer, fileName: targetFileName, format: "gif" });
							exportOutcomeRef.current = {
								ok: false,
								message: saveResult.message || "Failed to save GIF",
							};
							const message = buildSaveDiagnosticMessage(
								"GIF",
								saveResult.message || "Failed to save GIF",
							);
							setExportError(message);
							toast.error(message);
						}
					} else {
						exportOutcomeRef.current = {
							ok: false,
							message: result.error || "GIF export failed",
						};
						const message = buildExportDiagnosticMessage({
							formatLabel: "GIF",
							reason: result.error || "GIF export failed",
							sourcePath: videoSourcePath ?? videoPath,
							width: settings.gifConfig.width,
							height: settings.gifConfig.height,
							frameRate: settings.gifConfig.frameRate,
						});
						setExportError(message);
						toast.error(message);
					}
				} else {
					// MP4 Export
					const quality = settings.quality || exportQuality;
					const {
						width: exportWidth,
						height: exportHeight,
						bitrate,
					} = calculateMp4ExportSettings({
						quality,
						sourceWidth: effectiveSourceDimensions.width,
						sourceHeight: effectiveSourceDimensions.height,
						aspectRatioValue,
					});

					const exporter = new VideoExporter({
						videoUrl: videoPath,
						webcamVideoUrl: webcamVideoPath || undefined,
						width: exportWidth,
						height: exportHeight,
						frameRate: 60,
						bitrate,
						codec: "avc1.640033",
						wallpaper,
						cards: exportCards,
						sequence: exportSequence,
						zoomRegions,
						trimRegions,
						speedRegions,
						showShadow: shadowIntensity > 0,
						shadowIntensity,
						showBlur,
						motionBlurAmount,
						transitionStyle,
						transitionMs,
						borderRadius,
						padding,
						cropRegion,
						cursorRecordingData,
						cursorScale: exportCursorScale,
						cursorSmoothing,
						cursorMotionBlur,
						cursorClickBounce,
						cursorClickRipple,
						cursorClipToBounds,
						cursorTheme,
						annotationRegions,
						webcamLayoutPreset,
						webcamMaskShape,
						webcamMirrored,
						webcamReactiveZoom,
						webcamSizePreset,
						webcamPosition,
						previewWidth,
						previewHeight,
						cursorTelemetry,
						cursorClickTimestamps,
						onProgress: (progress: ExportProgress) => {
							setExportProgress(progress);
						},
					});

					exporterRef.current = exporter;
					const result = await exporter.export();

					if (result.success && result.blob) {
						const arrayBuffer = await result.blob.arrayBuffer();

						if (result.warnings) {
							for (const warning of result.warnings) {
								toast.warning(warning);
							}
						}

						const saveResult = await window.electronAPI.writeExportToPath(arrayBuffer, targetPath);

						if (saveResult.success && saveResult.path) {
							setUnsavedExport(null);
							exportOutcomeRef.current = { ok: true, path: saveResult.path };
							handleExportSaved("Video", saveResult.path);
						} else {
							setUnsavedExport({ arrayBuffer, fileName: targetFileName, format: "mp4" });
							exportOutcomeRef.current = {
								ok: false,
								message: saveResult.message || "Failed to save video",
							};
							const message = buildSaveDiagnosticMessage(
								"Video",
								saveResult.message || "Failed to save video",
							);
							setExportError(message);
							toast.error(message);
						}
					} else {
						exportOutcomeRef.current = {
							ok: false,
							message: result.error || "Export failed",
						};
						const message = buildExportDiagnosticMessage({
							formatLabel: "Video",
							reason: result.error || "Export failed",
							sourcePath: videoSourcePath ?? videoPath,
							width: exportWidth,
							height: exportHeight,
							frameRate: 60,
							codec: "avc1.640033",
							bitrate,
						});
						setExportError(message);
						toast.error(message);
					}
				}

				if (wasPlaying) {
					videoPlaybackRef.current?.play();
				}
			} catch (error) {
				console.error("Export error:", error);
				exportOutcomeRef.current = {
					ok: false,
					message: error instanceof Error ? error.message : "Unknown export error",
				};
				if (error instanceof BackgroundLoadError) {
					const message = t("errors.exportBackgroundLoadFailed", { url: error.displayUrl });
					setExportError(message);
					toast.error(message);
				} else {
					const errorMessage = error instanceof Error ? error.message : "Unknown error";
					const message = buildExportDiagnosticMessage({
						formatLabel: settings.format === "gif" ? "GIF" : "Video",
						reason: errorMessage,
						sourcePath: videoSourcePath ?? videoPath,
					});
					setExportError(message);
					toast.error(t("errors.exportFailedWithError", { error: message }));
				}
			} finally {
				setIsExporting(false);
				exporterRef.current = null;
				// Reset so the next export can reopen the dialog (second export
				// otherwise wouldn't show the save dialog).
				setShowExportDialog(false);
				setExportProgress(null);
			}
		},
		[
			videoPath,
			videoSourcePath,
			webcamVideoPath,
			wallpaper,
			zoomRegions,
			trimRegions,
			speedRegions,
			shadowIntensity,
			showBlur,
			motionBlurAmount,
			transitionStyle,
			transitionMs,
			borderRadius,
			padding,
			cropRegion,
			cursorRecordingData,
			annotationRegions,
			isPlaying,
			aspectRatio,
			webcamLayoutPreset,
			webcamMaskShape,
			webcamMirrored,
			webcamReactiveZoom,
			webcamSizePreset,
			webcamPosition,
			exportQuality,
			handleExportSaved,
			cursorTelemetry,
			cursorClickTimestamps,
			effectiveShowCursor,
			cursorSize,
			cursorSmoothing,
			cursorMotionBlur,
			cursorClickBounce,
			cursorClickRipple,
			cursorClipToBounds,
			cursorTheme,
			t,
			exportCards,
			showCursor,
			buildExportSequence,
		],
	);

	/** Export settings for a format, from whatever the panel is currently set to. */
	// The new list is built once and the id read back out of it, rather than
	// predicted separately: two calls to nextCardId could disagree.
	const addCardAndSelect = useCallback(
		(build: (clips: ClipEntry[]) => ClipEntry[]) => {
			const next = build(clips);
			pushState({ clips: next });
			const added = next.find((clip) => !clips.some((existing) => existing.id === clip.id));
			if (added) setSelectedCardId(added.id);
		},
		[clips, pushState],
	);

	const handleAddIntroCard = useCallback(
		() => addCardAndSelect((current) => addIntroCard(current)),
		[addCardAndSelect],
	);

	const handleAddOutroCard = useCallback(
		() => addCardAndSelect((current) => addOutroCard(current)),
		[addCardAndSelect],
	);

	const handleRemoveCard = useCallback(
		(id: string) => {
			pushState((prev) => ({ clips: removeCard(prev.clips, id) }));
			setSelectedCardId((current) => (current === id ? null : current));
		},
		[pushState],
	);

	const handleMoveClip = useCallback(
		(id: string, toIndex: number) => {
			pushState((prev) => ({ clips: moveClip(prev.clips, id, toIndex) }));
		},
		[pushState],
	);

	// Typing a title and dragging the duration are live series: one undo step for
	// the whole edit, committed when the field is let go.
	const handleUpdateCard = useCallback(
		(id: string, patch: { title?: string; durationMs?: number }) => {
			updateState((prev) => ({ clips: updateCard(prev.clips, id, patch) }));
		},
		[updateState],
	);

	const buildExportSettings = useCallback(
		(format: ExportFormat): ExportSettings | null => {
			const video = videoPlaybackRef.current?.video;
			if (!video) return null;

			const sourceWidth = video.videoWidth || DEFAULT_SOURCE_DIMENSIONS.width;
			const sourceHeight = video.videoHeight || DEFAULT_SOURCE_DIMENSIONS.height;
			const effectiveSourceDimensions = calculateEffectiveSourceDimensions(
				sourceWidth,
				sourceHeight,
				cropRegion,
			);
			const aspectRatioValue =
				aspectRatio === "native"
					? getNativeAspectRatioValue(sourceWidth, sourceHeight, cropRegion)
					: getAspectRatioValue(aspectRatio);
			const gifDimensions = calculateOutputDimensions(
				effectiveSourceDimensions.width,
				effectiveSourceDimensions.height,
				gifSizePreset,
				GIF_SIZE_PRESETS,
				aspectRatioValue,
			);

			return {
				format,
				quality: format === "mp4" ? exportQuality : undefined,
				gifConfig:
					format === "gif"
						? {
								frameRate: gifFrameRate,
								loop: gifLoop,
								sizePreset: gifSizePreset,
								width: gifDimensions.width,
								height: gifDimensions.height,
							}
						: undefined,
			};
		},
		[exportQuality, gifFrameRate, gifLoop, gifSizePreset, aspectRatio, cropRegion],
	);

	const handleOpenExportDialog = useCallback(() => {
		if (!videoPath) {
			toast.error("No video loaded");
			return;
		}

		const settings = buildExportSettings(exportFormat);
		if (!settings) {
			toast.error("Video not ready");
			return;
		}

		setShowExportDialog(true);
		setExportError(null);
		setExportedFilePath(null);

		// Start export immediately
		handleExport(settings);
	}, [videoPath, exportFormat, buildExportSettings, handleExport]);

	// An agent's edits arrive marked as proposals; these are the two bulk answers.
	// Both go through history, so either is one undo away.
	const proposalCount = useMemo(() => countProposals(editorState), [editorState]);

	const handleAcceptProposals = useCallback(() => {
		pushState((prev) => acceptProposals(prev));
	}, [pushState]);

	const handleDiscardProposals = useCallback(() => {
		pushState((prev) => discardProposals(prev));
	}, [pushState]);

	// Renders to a file for an agent. The destination is resolved in the main
	// process against the user's export folder — the agent supplies only a name.
	const runExportForAgent = useCallback<ExportRunner>(
		async (targetPath, format) => {
			const settings = buildExportSettings(format);
			if (!settings) throw new Error("The video is not ready to export yet.");

			setShowExportDialog(true);
			setExportError(null);
			setExportedFilePath(null);
			await handleExport(settings, targetPath);

			const outcome = exportOutcomeRef.current;
			if (!outcome) throw new Error("The export stopped before writing a file.");
			if (!outcome.ok || !outcome.path) {
				throw new Error(outcome.message ?? "The export failed.");
			}
			return outcome.path;
		},
		[buildExportSettings, handleExport],
	);

	// Answers the MCP endpoint's commands with this editor's live state.
	// No-ops unless the user has turned the endpoint on.
	useMcpCommands({
		editor: editorState,
		media: currentProjectMedia,
		projectPath: currentProjectPath,
		durationMs: duration * 1000,
		getSourceDimensions: () => {
			const video = videoPlaybackRef.current?.video;
			return {
				width: video?.videoWidth || DEFAULT_SOURCE_DIMENSIONS.width,
				height: video?.videoHeight || DEFAULT_SOURCE_DIMENSIONS.height,
			};
		},
		cursorTelemetry,
		videoUrl: videoPath,
		getClipTelemetry: loadClipTelemetry,
		// An agent moves between recordings the same way the user does, undo history
		// and all; there is no back door that edits a recording nobody can see.
		parkProject: parkProjectForRetake,
		openClip: (clipId: string) => {
			const clip = clips.find((entry) => entry.id === clipId && entry.kind === "recording");
			if (!clip?.media) return false;
			handleActivateRecording(clipId);
			return true;
		},
		// pushState, not updateState: an agent's batch should be one undo step.
		applyPatch: pushState,
		runExport: runExportForAgent,
		exportFolder: getExportFolder() ?? null,
	});

	const handleCancelExport = useCallback(() => {
		if (exporterRef.current) {
			exporterRef.current.cancel();
			toast.info("Export canceled");
			setShowExportDialog(false);
			setIsExporting(false);
			setExportProgress(null);
			setExportError(null);
			setExportedFilePath(null);
		}
	}, []);

	const generateAutoCaptions = useCallback(
		async (minWords: number, maxWords: number) => {
			if (!videoPath) {
				toast.error(t("errors.noVideoLoaded"));
				return;
			}
			if (isAutoCaptioningRef.current) {
				toast.error(t("autoCaptions.busy"));
				return;
			}
			const minW = Math.max(1, Math.min(minWords, maxWords));
			const maxW = Math.max(minW, maxWords);

			isAutoCaptioningRef.current = true;
			setIsAutoCaptioning(true);
			toast.loading(t("autoCaptions.generating"), { id: AUTO_CAPTION_PROGRESS_TOAST_ID });
			try {
				const { samples, truncated, durationSec } = await extractMono16kFromVideoUrl(videoPath);
				if (!Number.isFinite(durationSec) || durationSec <= 0 || samples.length < 800) {
					toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
					toast.error(t("autoCaptions.noAudio"));
					return;
				}

				const { samples: speechSamples, trimSec } = trimLeadingSilenceMono16k(samples);
				if (speechSamples.length < 800) {
					toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
					toast.error(t("autoCaptions.noAudio"));
					return;
				}

				const trimMs = Math.round(trimSec * 1000);
				const trimRegionsForTranscribe = shiftTrimRegionsMsForCaptionBuffer(trimRegions, trimMs);

				const transcribeOptions = {
					onStatus: (phase: "model" | "transcribe") => {
						if (phase === "model") {
							toast.loading(t("autoCaptions.loadingModel"), {
								id: AUTO_CAPTION_PROGRESS_TOAST_ID,
							});
						} else {
							toast.loading(t("autoCaptions.transcribing"), {
								id: AUTO_CAPTION_PROGRESS_TOAST_ID,
							});
						}
					},
				};

				let { segments: segmentsRaw, granularity } = await transcribeMono16kToSegments(
					speechSamples,
					{
						trimRegions: trimRegionsForTranscribe,
						...transcribeOptions,
					},
				);
				let transcribedFromTrimmedBuffer = true;

				// Leading-silence trimming can return empty even when the full source has
				// speech. Retry once against the untrimmed buffer before giving up.
				if (segmentsRaw.length === 0 && trimSec > 0) {
					({ segments: segmentsRaw, granularity } = await transcribeMono16kToSegments(samples, {
						trimRegions,
						...transcribeOptions,
					}));
					transcribedFromTrimmedBuffer = false;
				}

				const segments =
					transcribedFromTrimmedBuffer && trimSec > 0
						? segmentsRaw.map((s) => ({
								...s,
								startSec: s.startSec + trimSec,
								endSec: s.endSec + trimSec,
							}))
						: segmentsRaw;

				let { regions, nextNumericId, nextZIndex } = captionSegmentsToAnnotationRegions(
					segments,
					nextAnnotationIdRef.current,
					nextAnnotationZIndexRef.current,
					{
						minWordsPerCaption: minW,
						maxWordsPerCaption: maxW,
						timestampGranularity: granularity,
					},
				);

				if (regions.length === 0 && segments.length > 0) {
					({ regions, nextNumericId, nextZIndex } = captionSegmentsToAnnotationRegions(
						segments,
						nextAnnotationIdRef.current,
						nextAnnotationZIndexRef.current,
						{
							minWordsPerCaption: 1,
							maxWordsPerCaption: Number.MAX_SAFE_INTEGER,
							timestampGranularity: granularity,
						},
					));
				}

				if (regions.length === 0) {
					toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
					toast.info(t("autoCaptions.noneHeard"));
					return;
				}

				pushState((prev) => ({ annotationRegions: [...prev.annotationRegions, ...regions] }));
				nextAnnotationIdRef.current = nextNumericId;
				nextAnnotationZIndexRef.current = nextZIndex;

				toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
				const minutesTrunc = String(Math.round(MAX_CAPTION_AUDIO_SEC / 60));
				if (truncated) {
					toast.success(t("autoCaptions.done", { count: String(regions.length) }), {
						description: t("autoCaptions.truncated", { minutes: minutesTrunc }),
					});
				} else {
					toast.success(t("autoCaptions.done", { count: String(regions.length) }));
				}
			} catch (e) {
				console.error(e);
				toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
				const detail = e instanceof Error ? e.message : String(e);
				toast.error(t("autoCaptions.failed"), { description: detail });
			} finally {
				isAutoCaptioningRef.current = false;
				setIsAutoCaptioning(false);
			}
		},
		[videoPath, trimRegions, pushState, t],
	);

	const handleSaveDiagnostic = useCallback(async () => {
		const result = await window.electronAPI.saveDiagnostic({
			error: exportError ?? "Manual diagnostic export",
			projectState: editorState,
			logs: [],
		});
		if (result.success) {
			toast.success("Diagnostic file saved");
		} else if (!result.canceled) {
			toast.error("Failed to save diagnostic file");
		}
	}, [exportError, editorState]);

	if (loading) {
		return (
			<div className="flex items-center justify-center h-screen bg-background">
				<div className="text-foreground">{t("loadingVideo")}</div>
			</div>
		);
	}
	if (error) {
		return (
			<div className="flex items-center justify-center h-screen bg-background">
				<div className="flex flex-col items-center gap-3">
					<div className="text-destructive">{error}</div>
					<button
						type="button"
						onClick={handleLoadProject}
						className="px-3 py-1.5 rounded-md bg-[#34B27B] text-white text-sm hover:bg-[#34B27B]/90"
					>
						{ts("project.load")}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-screen bg-[#09090b] text-slate-200 overflow-hidden selection:bg-[#34B27B]/30">
			<Dialog open={showNewRecordingDialog} onOpenChange={setShowNewRecordingDialog}>
				<DialogContent
					className="sm:max-w-[425px]"
					style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
				>
					<DialogHeader>
						<DialogTitle>{t("newRecording.title")}</DialogTitle>
						<DialogDescription>{t("newRecording.description")}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<button
							type="button"
							onClick={() => setShowNewRecordingDialog(false)}
							className="px-4 py-2 rounded-md bg-white/10 text-white hover:bg-white/20 text-sm font-medium transition-colors"
						>
							{t("newRecording.cancel")}
						</button>
						<button
							type="button"
							onClick={doNewRecording}
							className="px-4 py-2 rounded-md bg-[#34B27B] text-white hover:bg-[#34B27B]/90 text-sm font-medium transition-colors"
						>
							{t("newRecording.confirm")}
						</button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={showAutoCaptionsDialog} onOpenChange={setShowAutoCaptionsDialog}>
				<DialogContent
					className="sm:max-w-md"
					style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
				>
					<DialogHeader>
						<DialogTitle>{t("autoCaptions.dialogTitle")}</DialogTitle>
						<DialogDescription>{t("autoCaptions.dialogDescription")}</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 py-2">
						<div className="grid gap-2">
							<Label htmlFor="caption-min-words">{t("autoCaptions.minWords")}</Label>
							<Select
								value={String(captionWordsMin)}
								onValueChange={(v) => {
									const n = Number.parseInt(v, 10);
									setCaptionWordsMin(n);
									if (n > captionWordsMax) setCaptionWordsMax(n);
								}}
							>
								<SelectTrigger id="caption-min-words" className="h-9">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CAPTION_WORD_CHOICES.map((n) => (
										<SelectItem key={`min-${n}`} value={String(n)}>
											{t("autoCaptions.wordsCount", { count: String(n) })}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="caption-max-words">{t("autoCaptions.maxWords")}</Label>
							<Select
								value={String(captionWordsMax)}
								onValueChange={(v) => {
									const n = Number.parseInt(v, 10);
									setCaptionWordsMax(n);
									if (n < captionWordsMin) setCaptionWordsMin(n);
								}}
							>
								<SelectTrigger id="caption-max-words" className="h-9">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CAPTION_WORD_CHOICES.map((n) => (
										<SelectItem key={`max-${n}`} value={String(n)}>
											{t("autoCaptions.wordsCount", { count: String(n) })}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
					<DialogFooter className="gap-2 sm:gap-0">
						<Button
							type="button"
							variant="outline"
							onClick={() => setShowAutoCaptionsDialog(false)}
							className="border-white/20 bg-transparent text-white hover:bg-white/10"
						>
							{t("autoCaptions.dialogCancel")}
						</Button>
						<Button
							type="button"
							disabled={isAutoCaptioning}
							onClick={() => {
								setShowAutoCaptionsDialog(false);
								void generateAutoCaptions(captionWordsMin, captionWordsMax);
							}}
							className="bg-[#34B27B] text-white hover:bg-[#34B27B]/90"
						>
							{t("autoCaptions.generate")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<div
				className="h-11 flex-shrink-0 bg-[#070809]/85 backdrop-blur-xl border-b border-white/[0.07] flex items-center justify-between px-5 z-50 shadow-[0_1px_0_rgba(255,255,255,0.03)]"
				style={{ WebkitAppRegion: "drag" } as CSSProperties}
			>
				<div
					className="flex-1 flex items-center gap-1"
					style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
				>
					<div
						className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-white/50 hover:text-white/90 hover:bg-white/[0.08] transition-all duration-150 ${isMac ? "ml-14" : "ml-2"}`}
					>
						<Languages size={14} />
						<select
							value={locale}
							onChange={(e) => setLocale(e.target.value as Locale)}
							className="bg-transparent text-[11px] font-medium outline-none cursor-pointer appearance-none pr-1"
							style={{ color: "inherit" }}
						>
							{availableLocales.map((loc) => (
								<option key={loc} value={loc} className="bg-[#09090b] text-white">
									{getLocaleName(loc)}
								</option>
							))}
						</select>
					</div>
					<button
						type="button"
						onClick={handleNewRecording}
						className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-white/50 hover:text-white/90 hover:bg-white/[0.08] transition-all duration-150 text-[11px] font-medium"
					>
						<Video size={14} />
						{t("newRecording.title")}
					</button>
					<button
						type="button"
						onClick={handleLoadProject}
						className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-white/50 hover:text-white/90 hover:bg-white/[0.08] transition-all duration-150 text-[11px] font-medium"
					>
						<FolderOpen size={14} />
						{ts("project.load")}
					</button>
					<button
						type="button"
						onClick={handleSaveProject}
						className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-white/50 hover:text-white/90 hover:bg-white/[0.08] transition-all duration-150 text-[11px] font-medium"
					>
						<Save size={14} />
						{ts("project.save")}
					</button>
				</div>
			</div>

			{/* Empty state shown when no video is loaded */}
			{!videoPath && (
				<div className="flex-1 min-h-0 relative">
					<EditorEmptyState
						onVideoImported={(path) => {
							setVideoPath(toFileUrl(path));
							setVideoSourcePath(path);
							setWebcamVideoPath(null);
							setWebcamVideoSourcePath(null);
						}}
						onProjectOpened={async (project, path) => {
							const restored = await applyLoadedProject(project, path);
							if (!restored) {
								toast.error(t("project.invalidFormat"));
							}
						}}
					/>
				</div>
			)}

			{videoPath && (
				<div className="editor-workspace flex-1 min-h-0 relative">
					<PanelGroup direction="vertical" className="gap-3 min-h-0">
						{/* Top section: preview and contextual settings */}
						<Panel defaultSize={67} maxSize={76} minSize={46} className="min-h-[300px]">
							<div className="editor-main-deck h-full min-h-0">
								<div className="editor-preview-zone min-w-0 h-full">
									<div
										ref={playerContainerRef}
										className={
											isFullscreen
												? "fixed inset-0 z-[99999] w-full h-full flex flex-col items-center justify-center bg-[#09090b]"
												: "editor-preview-panel w-full h-full flex flex-col items-center justify-center overflow-hidden relative"
										}
									>
										{/* Video preview */}
										<div className="w-full min-h-0 flex justify-center items-center flex-auto px-4 pt-4">
											<div
												className="relative flex justify-center items-center w-auto h-full max-w-full box-border"
												style={{
													aspectRatio:
														aspectRatio === "native"
															? getNativeAspectRatioValue(
																	videoPlaybackRef.current?.video?.videoWidth ||
																		DEFAULT_SOURCE_DIMENSIONS.width,
																	videoPlaybackRef.current?.video?.videoHeight ||
																		DEFAULT_SOURCE_DIMENSIONS.height,
																	cropRegion,
																)
															: getAspectRatioValue(aspectRatio),
												}}
											>
												<VideoPlayback
													key={`${videoPath || "no-video"}:${webcamVideoPath || "no-webcam"}`}
													aspectRatio={aspectRatio}
													ref={videoPlaybackRef}
													videoPath={videoPath || ""}
													webcamVideoPath={webcamVideoPath || undefined}
													webcamLayoutPreset={webcamLayoutPreset}
													webcamMaskShape={webcamMaskShape}
													webcamMirrored={webcamMirrored}
													webcamReactiveZoom={webcamReactiveZoom}
													webcamSizePreset={webcamSizePreset}
													webcamPosition={webcamPosition}
													onWebcamPositionChange={(pos) => updateState({ webcamPosition: pos })}
													onWebcamPositionDragEnd={commitState}
													onDurationChange={setDuration}
													onTimeUpdate={setCurrentTime}
													currentTime={currentTime}
													onPlayStateChange={setIsPlaying}
													onError={setError}
													wallpaper={wallpaper}
													zoomRegions={zoomRegions}
													selectedZoomId={selectedZoomId}
													onSelectZoom={handleSelectZoom}
													onZoomFocusChange={handleZoomFocusChange}
													onZoomFocusDragEnd={commitState}
													isPlaying={isPlaying}
													showShadow={shadowIntensity > 0}
													shadowIntensity={shadowIntensity}
													showBlur={showBlur}
													motionBlurAmount={motionBlurAmount}
													transitionStyle={transitionStyle}
													transitionMs={transitionMs}
													borderRadius={borderRadius}
													padding={padding}
													cropRegion={cropRegion}
													cursorRecordingData={cursorRecordingData}
													trimRegions={trimRegions}
													speedRegions={speedRegions}
													annotationRegions={annotationOnlyRegions}
													selectedAnnotationId={selectedAnnotationId}
													onSelectAnnotation={handleSelectAnnotation}
													onAnnotationPositionChange={handleAnnotationPositionChange}
													onAnnotationSizeChange={handleAnnotationSizeChange}
													blurRegions={blurRegions}
													selectedBlurId={selectedBlurId}
													onSelectBlur={handleSelectBlur}
													onBlurPositionChange={handleAnnotationPositionChange}
													onBlurSizeChange={handleAnnotationSizeChange}
													onBlurDataChange={handleBlurDataPreviewChange}
													onBlurDataCommit={commitState}
													cursorTelemetry={cursorTelemetry}
													cursorClickTimestamps={cursorClickTimestamps}
													showCursor={effectiveShowCursor}
													cursorSize={cursorSize}
													cursorSmoothing={cursorSmoothing}
													cursorMotionBlur={cursorMotionBlur}
													cursorClickBounce={cursorClickBounce}
													cursorClickRipple={cursorClickRipple}
													cursorClipToBounds={cursorClipToBounds}
													cursorTheme={cursorTheme}
													isPreviewingZoom={isPreviewingZoom}
												/>
											</div>
										</div>
										{sequencePreviewOpen && (
											<SequencePreview
												entries={sequenceEntries}
												activeClipId={activeClipId}
												activeDurationMs={duration * 1000}
												frameAspectRatio={
													aspectRatio === "native"
														? getNativeAspectRatioValue(
																videoPlaybackRef.current?.video?.videoWidth ||
																	DEFAULT_SOURCE_DIMENSIONS.width,
																videoPlaybackRef.current?.video?.videoHeight ||
																	DEFAULT_SOURCE_DIMENSIONS.height,
																cropRegion,
															)
														: getAspectRatioValue(aspectRatio)
												}
												look={{
													wallpaper,
													aspectRatio,
													webcamLayoutPreset,
													webcamMaskShape,
													webcamMirrored,
													webcamReactiveZoom,
													webcamSizePreset,
													webcamPosition,
													showShadow: shadowIntensity > 0,
													shadowIntensity,
													showBlur,
													motionBlurAmount,
													transitionStyle,
													transitionMs,
													borderRadius,
													padding,
													showCursor,
													cursorSize,
													cursorSmoothing,
													cursorMotionBlur,
													cursorClickBounce,
													cursorClickRipple,
													cursorClipToBounds,
													cursorTheme,
												}}
												onClose={closeSequencePreview}
												onEditRecording={(id) => {
													setSequencePreviewOpen(false);
													handleActivateRecording(id);
												}}
											/>
										)}
										{/* Playback controls */}
										<div className="w-full flex justify-center items-center h-14 flex-shrink-0 px-4 py-2">
											<div className="w-full max-w-[760px]">
												<PlaybackControls
													isPlaying={isPlaying}
													currentTime={currentTime}
													duration={duration}
													isFullscreen={isFullscreen}
													onToggleFullscreen={toggleFullscreen}
													onTogglePlayPause={togglePlayPause}
													onSeek={handleSeek}
												/>
											</div>
										</div>
									</div>
								</div>

								<div className="editor-settings-rail min-w-0 h-full">
									<SettingsPanel
										selected={wallpaper}
										onWallpaperChange={(w) => pushState({ wallpaper: w })}
										selectedZoomDepth={
											selectedZoomId
												? zoomRegions.find((z) => z.id === selectedZoomId)?.depth
												: null
										}
										onZoomDepthChange={(depth) => selectedZoomId && handleZoomDepthChange(depth)}
										selectedZoomCustomScale={
											selectedZoomId
												? (zoomRegions.find((z) => z.id === selectedZoomId)?.customScale ?? null)
												: null
										}
										onZoomCustomScaleChange={handleZoomCustomScaleChange}
										onZoomCustomScaleCommit={handleZoomCustomScaleCommit}
										onZoomPreviewStart={() => setIsPreviewingZoom(true)}
										onZoomPreviewEnd={() => setIsPreviewingZoom(false)}
										selectedZoomFocusMode={
											selectedZoomId
												? (zoomRegions.find((z) => z.id === selectedZoomId)?.focusMode ?? "manual")
												: null
										}
										onZoomFocusModeChange={(mode) =>
											selectedZoomId && handleZoomFocusModeChange(mode)
										}
										focusModeLocked={autoFocusAll}
										selectedZoomFocus={
											selectedZoomId
												? (zoomRegions.find((z) => z.id === selectedZoomId)?.focus ?? null)
												: null
										}
										onZoomFocusCoordinateChange={(focus) =>
											selectedZoomId && handleZoomFocusChange(selectedZoomId, focus)
										}
										onZoomFocusCoordinateCommit={commitState}
										hasCursorTelemetry={cursorTelemetry.length > 0}
										selectedZoomId={selectedZoomId}
										onZoomDelete={handleZoomDelete}
										selectedZoomRotationPreset={
											selectedZoomId
												? (zoomRegions.find((z) => z.id === selectedZoomId)?.rotationPreset ?? null)
												: null
										}
										onZoomRotationPresetChange={handleZoomRotationPresetChange}
										selectedTrimId={selectedTrimId}
										onTrimDelete={handleTrimDelete}
										shadowIntensity={shadowIntensity}
										onShadowChange={(v) => updateState({ shadowIntensity: v })}
										onShadowCommit={commitState}
										showBlur={showBlur}
										onBlurChange={(v) => pushState({ showBlur: v })}
										showTrimWaveform={showTrimWaveform}
										onTrimWaveformChange={(v) => pushState({ showTrimWaveform: v })}
										motionBlurAmount={motionBlurAmount}
										onMotionBlurChange={(v) => updateState({ motionBlurAmount: v })}
										onMotionBlurCommit={commitState}
										transitionStyle={transitionStyle}
										onTransitionStyleChange={(style) => pushState({ transitionStyle: style })}
										transitionMs={transitionMs}
										onTransitionMsChange={(value) => updateState({ transitionMs: value })}
										onTransitionMsCommit={commitState}
										borderRadius={borderRadius}
										onBorderRadiusChange={(v) => updateState({ borderRadius: v })}
										onBorderRadiusCommit={commitState}
										padding={padding}
										onPaddingChange={(v) => updateState({ padding: v })}
										onPaddingCommit={commitState}
										cropRegion={cropRegion}
										onCropChange={(r) => pushState({ cropRegion: r })}
										aspectRatio={aspectRatio}
										hasWebcam={Boolean(webcamVideoPath)}
										webcamLayoutPreset={webcamLayoutPreset}
										onWebcamLayoutPresetChange={(preset) =>
											pushState({
												webcamLayoutPreset: preset,
												webcamPosition: preset === "picture-in-picture" ? webcamPosition : null,
											})
										}
										webcamMaskShape={webcamMaskShape}
										onWebcamMaskShapeChange={(shape) => pushState({ webcamMaskShape: shape })}
										webcamMirrored={webcamMirrored}
										webcamReactiveZoom={webcamReactiveZoom}
										onWebcamMirroredChange={(mirrored) => pushState({ webcamMirrored: mirrored })}
										onWebcamReactiveZoomChange={(reactive) =>
											pushState({ webcamReactiveZoom: reactive })
										}
										webcamSizePreset={webcamSizePreset}
										onWebcamSizePresetChange={(v) => updateState({ webcamSizePreset: v })}
										onWebcamSizePresetCommit={commitState}
										videoElement={videoPlaybackRef.current?.video || null}
										exportQuality={exportQuality}
										onExportQualityChange={setExportQuality}
										exportFormat={exportFormat}
										onExportFormatChange={setExportFormat}
										gifFrameRate={gifFrameRate}
										onGifFrameRateChange={setGifFrameRate}
										gifLoop={gifLoop}
										onGifLoopChange={setGifLoop}
										gifSizePreset={gifSizePreset}
										onGifSizePresetChange={setGifSizePreset}
										gifOutputDimensions={calculateOutputDimensions(
											calculateEffectiveSourceDimensions(
												videoPlaybackRef.current?.video?.videoWidth ||
													DEFAULT_SOURCE_DIMENSIONS.width,
												videoPlaybackRef.current?.video?.videoHeight ||
													DEFAULT_SOURCE_DIMENSIONS.height,
												cropRegion,
											).width,
											calculateEffectiveSourceDimensions(
												videoPlaybackRef.current?.video?.videoWidth ||
													DEFAULT_SOURCE_DIMENSIONS.width,
												videoPlaybackRef.current?.video?.videoHeight ||
													DEFAULT_SOURCE_DIMENSIONS.height,
												cropRegion,
											).height,
											gifSizePreset,
											GIF_SIZE_PRESETS,
											aspectRatio === "native"
												? getNativeAspectRatioValue(
														videoPlaybackRef.current?.video?.videoWidth ||
															DEFAULT_SOURCE_DIMENSIONS.width,
														videoPlaybackRef.current?.video?.videoHeight ||
															DEFAULT_SOURCE_DIMENSIONS.height,
														cropRegion,
													)
												: getAspectRatioValue(aspectRatio),
										)}
										onExport={handleOpenExportDialog}
										onExportPanelOpen={() => {
											setSelectedZoomId(null);
											setSelectedTrimId(null);
											setSelectedSpeedId(null);
										}}
										selectedAnnotationId={selectedAnnotationId}
										annotationRegions={annotationOnlyRegions}
										onAnnotationContentChange={handleAnnotationContentChange}
										onAnnotationTypeChange={handleAnnotationTypeChange}
										onAnnotationStyleChange={handleAnnotationStyleChange}
										onAnnotationFigureDataChange={handleAnnotationFigureDataChange}
										onAnnotationDuplicate={handleAnnotationDuplicate}
										onAnnotationDelete={handleAnnotationDelete}
										selectedBlurId={selectedBlurId}
										blurRegions={blurRegions}
										onBlurDataChange={handleBlurDataPanelChange}
										onBlurDataCommit={commitState}
										onBlurDelete={handleAnnotationDelete}
										selectedSpeedId={selectedSpeedId}
										selectedSpeedValue={
											selectedSpeedId
												? (speedRegions.find((r) => r.id === selectedSpeedId)?.speed ?? null)
												: null
										}
										onSpeedChange={handleSpeedChange}
										onSpeedDelete={handleSpeedDelete}
										unsavedExport={unsavedExport}
										onSaveUnsavedExport={handleSaveUnsavedExport}
										onSaveDiagnostic={handleSaveDiagnostic}
										showCursor={showCursor}
										onShowCursorChange={(v) => pushState({ showCursor: v })}
										cursorSize={cursorSize}
										onCursorSizeChange={(v) => updateState({ cursorSize: v })}
										onCursorSizeCommit={commitState}
										cursorSmoothing={cursorSmoothing}
										onCursorSmoothingChange={(v) => updateState({ cursorSmoothing: v })}
										onCursorSmoothingCommit={commitState}
										cursorMotionBlur={cursorMotionBlur}
										onCursorMotionBlurChange={(v) => updateState({ cursorMotionBlur: v })}
										onCursorMotionBlurCommit={commitState}
										cursorClickBounce={cursorClickBounce}
										onCursorClickBounceChange={(v) => updateState({ cursorClickBounce: v })}
										onCursorClickBounceCommit={commitState}
										cursorClickRipple={cursorClickRipple}
										onCursorClickRippleChange={(v) => updateState({ cursorClickRipple: v })}
										onCursorClickRippleCommit={commitState}
										cursorClipToBounds={cursorClipToBounds}
										onCursorClipToBoundsChange={(v) => pushState({ cursorClipToBounds: v })}
										cursorTheme={cursorTheme}
										onCursorThemeChange={(v) => pushState({ cursorTheme: v })}
										hasCursorData={
											cursorTelemetry.length > 0 ||
											hasNativeCursorRecordingData(cursorRecordingData)
										}
										showCursorSettings={showCursorSettings}
									/>
								</div>
							</div>
						</Panel>

						<PanelResizeHandle className="editor-resize-handle group">
							<div className="w-10 h-1 bg-white/20 rounded-full transition-colors group-hover:bg-[#34B27B]/70"></div>
						</PanelResizeHandle>

						{/* Full-width timeline */}
						<Panel defaultSize={33} maxSize={54} minSize={24} className="min-h-[210px]">
							<div className="editor-timeline-panel h-full overflow-hidden flex flex-col">
								<ProposalReviewBar
									count={proposalCount}
									onAccept={handleAcceptProposals}
									onDiscard={handleDiscardProposals}
								/>
								<ClipStrip
									clips={clips}
									selectedCardId={selectedCardId}
									onSelectCard={setSelectedCardId}
									onAddIntro={handleAddIntroCard}
									onAddOutro={handleAddOutroCard}
									onRemoveCard={handleRemoveCard}
									onMoveClip={handleMoveClip}
									onUpdateCard={handleUpdateCard}
									onCommitCard={commitState}
									activeClipId={activeClipId}
									activeRecordingPath={currentProjectMedia?.screenVideoPath ?? null}
									onAddVideo={handleAddVideoClip}
									onActivateRecording={handleActivateRecording}
									onRemoveRecording={handleRemoveRecording}
									onWatchSequence={openSequencePreview}
								/>
								<TimelineEditor
									videoDuration={duration}
									currentTime={currentTime}
									onSeek={handleSeek}
									zoomRegions={zoomRegions}
									onZoomAdded={handleZoomAdded}
									autoZoomEnabled={autoZoomEnabled}
									onToggleAutoZoom={handleToggleAutoZoom}
									hasCursorTelemetry={cursorTelemetry.length > 0}
									autoFocusAll={autoFocusAll}
									onToggleAutoFocusAll={handleToggleAutoFocusAll}
									hasSilenceCuts={hasSilenceCuts}
									isScanningSilence={isScanningSilence}
									silenceSettings={silenceSettings}
									onRemoveSilence={() => void handleRemoveSilence()}
									onSilenceSettingsChange={handleSilenceSettingsChange}
									hasTimelapse={hasTimelapse}
									isScanningBoring={isScanningBoring}
									timelapseSettings={timelapseSettings}
									onTimelapse={() => void handleTimelapse()}
									onTimelapseSettingsChange={handleTimelapseSettingsChange}
									onZoomSpanChange={handleZoomSpanChange}
									onZoomDelete={handleZoomDelete}
									selectedZoomId={selectedZoomId}
									onSelectZoom={handleSelectZoom}
									trimRegions={trimRegions}
									onTrimAdded={handleTrimAdded}
									onTrimSpanChange={handleTrimSpanChange}
									onTrimDelete={handleTrimDelete}
									selectedTrimId={selectedTrimId}
									onSelectTrim={handleSelectTrim}
									speedRegions={speedRegions}
									onSpeedAdded={handleSpeedAdded}
									onSpeedSpanChange={handleSpeedSpanChange}
									onSpeedDelete={handleSpeedDelete}
									selectedSpeedId={selectedSpeedId}
									onSelectSpeed={handleSelectSpeed}
									annotationRegions={annotationOnlyRegions}
									onAnnotationAdded={handleAnnotationAdded}
									onAnnotationSpanChange={handleAnnotationSpanChange}
									onAnnotationDelete={handleAnnotationDelete}
									selectedAnnotationId={selectedAnnotationId}
									onSelectAnnotation={handleSelectAnnotation}
									blurRegions={blurRegions}
									onBlurAdded={handleBlurAdded}
									onBlurSpanChange={handleAnnotationSpanChange}
									onBlurDelete={handleAnnotationDelete}
									selectedBlurId={selectedBlurId}
									onSelectBlur={handleSelectBlur}
									aspectRatio={aspectRatio}
									onAspectRatioChange={(ar) =>
										pushState({
											aspectRatio: ar,
											webcamLayoutPreset:
												(isPortraitAspectRatio(ar) && webcamLayoutPreset === "dual-frame") ||
												(!isPortraitAspectRatio(ar) && webcamLayoutPreset === "vertical-stack")
													? "picture-in-picture"
													: webcamLayoutPreset,
										})
									}
									videoUrl={videoPath ?? undefined}
									showTrimWaveform={showTrimWaveform}
									captionsLabel={t("autoCaptions.button")}
									isGeneratingCaptions={isAutoCaptioning}
									onGenerateCaptions={() => {
										if (!videoPath) {
											toast.error(t("errors.noVideoLoaded"));
											return;
										}
										if (isAutoCaptioningRef.current) {
											toast.error(t("autoCaptions.busy"));
											return;
										}
										setShowAutoCaptionsDialog(true);
									}}
								/>
							</div>
						</Panel>
					</PanelGroup>
				</div>
			)}

			<ExportDialog
				isOpen={showExportDialog}
				onClose={() => setShowExportDialog(false)}
				progress={exportProgress}
				isExporting={isExporting}
				error={exportError}
				onCancel={handleCancelExport}
				exportFormat={exportFormat}
				exportedFilePath={exportedFilePath || undefined}
				onShowInFolder={
					exportedFilePath ? () => void handleShowExportedFile(exportedFilePath) : undefined
				}
			/>

			<UnsavedChangesDialog
				isOpen={showCloseConfirmDialog}
				onSaveAndClose={handleCloseConfirmSave}
				onDiscardAndClose={handleCloseConfirmDiscard}
				onCancel={handleCloseConfirmCancel}
			/>

			<UnsavedChangesDialog
				isOpen={confirmDialogVariant !== null}
				variant={confirmDialogVariant ?? "newProject"}
				onSaveAndClose={confirmHandlers.save}
				onDiscardAndClose={confirmHandlers.discard}
				onCancel={() => setConfirmDialogVariant(null)}
			/>

			<RecordingsLibrary
				open={libraryOpen}
				onOpenChange={setLibraryOpen}
				onInsert={handleInsertFromLibrary}
			/>
		</div>
	);
}
