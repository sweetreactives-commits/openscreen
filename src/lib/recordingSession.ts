export interface ProjectMedia {
	screenVideoPath: string;
	webcamVideoPath?: string;
	cursorCaptureMode?: CursorCaptureMode;
}

export type CursorCaptureMode = "editable-overlay" | "system";

export interface RecordingSession extends ProjectMedia {
	createdAt: number;
}

export interface RecordedVideoAssetInput {
	fileName: string;
	videoData: ArrayBuffer;
}

export interface StoreRecordedSessionInput {
	screen: RecordedVideoAssetInput;
	webcam?: RecordedVideoAssetInput;
	createdAt?: number;
	cursorCaptureMode?: CursorCaptureMode;
	/**
	 * Recording wall-clock duration (ms). The main process patches the WebM Duration
	 * header on streamed recordings (the renderer no longer holds the bytes). Browser
	 * MediaRecorder writes no/zero duration, which breaks the editor seek bar and
	 * timeline for anything that took the streaming path.
	 */
	durationMs?: number;
}

export function normalizeCursorCaptureMode(value: unknown): CursorCaptureMode | undefined {
	return value === "editable-overlay" || value === "system" ? value : undefined;
}

function normalizePath(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

export function normalizeProjectMedia(candidate: unknown): ProjectMedia | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	const raw = candidate as Partial<ProjectMedia>;
	const screenVideoPath = normalizePath(raw.screenVideoPath);

	if (!screenVideoPath) {
		return null;
	}

	const webcamVideoPath = normalizePath(raw.webcamVideoPath);
	const cursorCaptureMode = normalizeCursorCaptureMode(raw.cursorCaptureMode);

	return {
		screenVideoPath,
		...(webcamVideoPath ? { webcamVideoPath } : {}),
		...(cursorCaptureMode ? { cursorCaptureMode } : {}),
	};
}

export function normalizeRecordingSession(candidate: unknown): RecordingSession | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	const raw = candidate as Partial<RecordingSession>;
	const media = normalizeProjectMedia(raw);
	if (!media) {
		return null;
	}

	return {
		...media,
		createdAt:
			typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
				? raw.createdAt
				: Date.now(),
	};
}

/**
 * Every recording a project file points at, oldest format to newest.
 *
 * Project files have carried their media three different ways: a bare
 * `videoPath` string (v1), an explicit `media` object (v2-v3), and a `clips`
 * array once a project could hold more than one recording (v4). Both processes
 * have to agree on how to read all three — the renderer to load the project,
 * the main process to decide which files it is allowed to open — so the reading
 * lives here rather than twice.
 *
 * Returns them in playback order, dropping any entry that carries no usable
 * path. An empty result means the file references no media at all.
 */
export function projectMediaList(candidate: unknown): ProjectMedia[] {
	if (!candidate || typeof candidate !== "object") {
		return [];
	}

	const raw = candidate as { clips?: unknown; media?: unknown; videoPath?: unknown };

	if (Array.isArray(raw.clips)) {
		return raw.clips
			.map((clip) =>
				normalizeProjectMedia(
					clip && typeof clip === "object" ? (clip as { media?: unknown }).media : null,
				),
			)
			.filter((media): media is ProjectMedia => media !== null);
	}

	const media = normalizeProjectMedia(raw.media);
	if (media) return [media];

	const legacyPath = normalizePath(raw.videoPath);
	return legacyPath ? [{ screenVideoPath: legacyPath }] : [];
}
