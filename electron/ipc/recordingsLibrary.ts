import path from "node:path";

/**
 * Reading the recordings folder as a list of takes rather than a list of files.
 *
 * One recording is several files: the screen video, sometimes a webcam track
 * beside it, the cursor telemetry sidecar and the session manifest. The folder
 * shows them flat, which is why picking a clip has meant an OS file dialog and
 * a filename. Grouping them is what lets a take be shown, inserted and thrown
 * away as one thing — deleting the video and orphaning its telemetry is a way
 * to leave the folder in a state nothing else expects.
 *
 * Kept pure and separate from the handlers so the grouping can be tested
 * without a filesystem, the same way clip imports are.
 */

export const LIBRARY_VIDEO_EXTENSIONS = new Set([
	".webm",
	".mp4",
	".mov",
	".avi",
	".mkv",
	".m4v",
	".wmv",
	".flv",
	".ts",
]);

/** The webcam track is written beside the screen video under this suffix. */
const WEBCAM_SUFFIX = "-webcam";
const SESSION_SUFFIX = ".session.json";
const CURSOR_SUFFIX = ".cursor.json";

export interface LibraryFile {
	name: string;
	sizeBytes: number;
	modifiedAtMs: number;
}

export interface LibraryEntry {
	/** The screen video, and the path a project would reference. */
	path: string;
	/** The file name, for showing and for telling two takes apart. */
	name: string;
	/**
	 * Every file belonging to this take, screen video included.
	 *
	 * This is what gets thrown away together, so it must never reach outside the
	 * recordings folder — each one is resolved from a folder entry, never from
	 * anything a project file or a caller supplied.
	 */
	files: string[];
	/** The whole take, companions included: what deleting it actually frees. */
	sizeBytes: number;
	modifiedAtMs: number;
	hasWebcam: boolean;
	hasCursorData: boolean;
}

function isVideo(name: string): boolean {
	return LIBRARY_VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function isWebcamTrack(name: string): boolean {
	return isVideo(name) && path.parse(name).name.endsWith(WEBCAM_SUFFIX);
}

/**
 * Groups a folder listing into takes, newest first.
 *
 * Anything that is not a video — project files, stray manifests, a sidecar whose
 * video is gone — is left out rather than guessed at. A webcam track is a
 * companion, never a take of its own, or every recording made with the camera on
 * would appear twice.
 */
export function collectLibraryEntries(files: LibraryFile[], recordingsDir: string): LibraryEntry[] {
	const byName = new Map(files.map((file) => [file.name, file]));
	const entries: LibraryEntry[] = [];

	for (const file of files) {
		if (!isVideo(file.name) || isWebcamTrack(file.name)) {
			continue;
		}

		const stem = path.parse(file.name).name;
		const companions = [
			`${file.name}${CURSOR_SUFFIX}`,
			`${stem}${SESSION_SUFFIX}`,
			...[...LIBRARY_VIDEO_EXTENSIONS].map((ext) => `${stem}${WEBCAM_SUFFIX}${ext}`),
		].filter((name) => byName.has(name));

		const webcam = companions.find((name) => isWebcamTrack(name));
		entries.push({
			path: path.join(recordingsDir, file.name),
			name: file.name,
			files: [file.name, ...companions].map((name) => path.join(recordingsDir, name)),
			sizeBytes: [file.name, ...companions].reduce(
				(total, name) => total + (byName.get(name)?.sizeBytes ?? 0),
				0,
			),
			modifiedAtMs: file.modifiedAtMs,
			hasWebcam: Boolean(webcam),
			hasCursorData: companions.includes(`${file.name}${CURSOR_SUFFIX}`),
		});
	}

	return entries.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
}
