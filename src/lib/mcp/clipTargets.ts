import type { ClipEntry } from "@/components/video-editor/clips";
import { toFileUrl } from "@/components/video-editor/projectPersistence";

/**
 * Which recording an agent's read is about.
 *
 * Every reading tool works on one recording's own file and one recording's own
 * clock. With several recordings in a project, "which one" stops being obvious,
 * so it is asked for by id and answered here — including the refusals, which have
 * to say what the caller could have asked for instead.
 *
 * Editing deliberately has no such parameter: it goes through the editor's undo
 * history, which belongs to the recording the user has open. An agent moves to
 * another one with `open_clip`, exactly as a user clicks it in the strip. See
 * "Сверка перед этапом 8" in docs/architecture/multiclip.md.
 */

export interface ClipTarget {
	clipId: string;
	/** The file to read, as the renderer addresses it. */
	videoUrl: string;
	/** Its path on disk, for the tools that need one. */
	sourcePath: string | null;
	/** True when this is the recording the editor has open. */
	open: boolean;
}

export interface ClipTargetError {
	error: string;
}

function recordingIds(clips: readonly ClipEntry[]): string[] {
	return clips.filter((clip) => clip.kind === "recording").map((clip) => clip.id);
}

/**
 * Resolves a requested clip to something readable.
 *
 * With no id, the answer is the open recording — the single-recording contract,
 * unchanged. The open recording's media lives in the editor rather than in its
 * clip entry, so it is passed in separately.
 */
export function resolveClipTarget(
	clips: readonly ClipEntry[],
	activeClipId: string,
	activeVideoUrl: string | null,
	activeSourcePath: string | null,
	clipId?: unknown,
): ClipTarget | ClipTargetError {
	if (clipId !== undefined && typeof clipId !== "string") {
		return { error: "clipId must be a string, as returned by get_project." };
	}

	if (clipId === undefined || clipId === activeClipId) {
		if (!activeVideoUrl) return { error: "No recording is open." };
		return {
			clipId: activeClipId,
			videoUrl: activeVideoUrl,
			sourcePath: activeSourcePath,
			open: true,
		};
	}

	const clip = clips.find((candidate) => candidate.id === clipId);
	if (!clip) {
		return {
			error: `No clip "${clipId}" in this project. Its clips are: ${recordingIds(clips).join(", ") || "none"}.`,
		};
	}
	if (clip.kind === "card") {
		return {
			error: `Clip "${clipId}" is a title card: it has no recording to read, only a title and a duration, both in get_project.`,
		};
	}
	const sourcePath = clip.media?.screenVideoPath;
	if (!sourcePath) {
		return { error: `Clip "${clipId}" has no video file the editor can reach.` };
	}

	return { clipId: clip.id, videoUrl: toFileUrl(sourcePath), sourcePath, open: false };
}

export function isClipTargetError(value: ClipTarget | ClipTargetError): value is ClipTargetError {
	return "error" in value;
}
