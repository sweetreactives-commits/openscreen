/**
 * A written walkthrough built from a recording.
 *
 * The agent supplies the words — it watched the transcript and the clicks and
 * knows what each step is doing. This supplies what it cannot: frames pulled
 * from the video at the moments it names, and a document on disk.
 *
 * The split matters. Asking an agent to "generate chapters" from a transcript it
 * already has would be a tool that does nothing; pulling a frame out of an H.264
 * stream is something it genuinely cannot do.
 */

export interface WalkthroughStep {
	/** When on the source recording's clock this step happens. */
	timeMs: number;
	title: string;
	/** Optional prose under the heading. */
	body?: string;
}

export interface WalkthroughImage {
	/** Path relative to the document, used in the markdown link. */
	fileName: string;
	base64: string;
}

export interface BuiltWalkthrough {
	markdown: string;
	images: WalkthroughImage[];
}

/** Where step images live, relative to the document. */
export function imageFolderName(docFileName: string): string {
	return `${docFileName.replace(/\.md$/i, "")}-images`;
}

/**
 * The file name at the end of a path, on either separator.
 *
 * Its own function because getting this wrong is silent: a Windows path split on
 * forward slashes alone comes back whole, and the "file name" then carries the
 * entire path into whatever is built from it.
 */
export function lastPathSegment(filePath: string): string {
	const segments = filePath.split(/[/\\]/);
	return segments[segments.length - 1] ?? "";
}

function timecode(totalMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(totalMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Rejects steps that are unusable before any frame is decoded for them. */
export function validateSteps(steps: unknown, durationMs: number): string | null {
	if (!Array.isArray(steps) || steps.length === 0) {
		return "A walkthrough needs at least one step.";
	}
	if (steps.length > 100) {
		return `A walkthrough of ${steps.length} steps is too long; keep it under 100.`;
	}

	for (const [index, step] of steps.entries()) {
		const position = `Step ${index + 1}`;
		if (!step || typeof step !== "object") return `${position} is not a step.`;

		const { timeMs, title } = step as Partial<WalkthroughStep>;
		if (typeof timeMs !== "number" || !Number.isFinite(timeMs)) {
			return `${position} needs a numeric timeMs.`;
		}
		if (timeMs < 0 || timeMs > durationMs) {
			return `${position} is at ${timeMs}ms, outside the recording (0–${Math.round(durationMs)}ms).`;
		}
		if (typeof title !== "string" || title.trim() === "") {
			return `${position} needs a title.`;
		}
	}

	return null;
}

/**
 * Assembles the document. Images are named by step so the folder reads in order
 * even when sorted by name.
 */
export function buildWalkthrough(
	documentTitle: string,
	steps: readonly WalkthroughStep[],
	frames: readonly (string | null)[],
	docFileName: string,
): BuiltWalkthrough {
	const folder = imageFolderName(docFileName);
	const images: WalkthroughImage[] = [];
	const lines: string[] = [`# ${documentTitle}`, ""];

	steps.forEach((step, index) => {
		const number = index + 1;
		lines.push(`## ${number}. ${step.title}`, "");
		lines.push(`*${timecode(step.timeMs)}*`, "");

		const frame = frames[index];
		if (frame) {
			const fileName = `step-${String(number).padStart(2, "0")}.jpg`;
			images.push({ fileName, base64: frame });
			// Alt text repeats the title: a reader with images off still gets the step.
			lines.push(`![${step.title}](${folder}/${fileName})`, "");
		}

		if (step.body?.trim()) {
			lines.push(step.body.trim(), "");
		}
	});

	return { markdown: `${lines.join("\n").trimEnd()}\n`, images };
}
