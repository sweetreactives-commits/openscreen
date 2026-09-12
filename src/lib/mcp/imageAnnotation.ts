/**
 * Turns an image path into something the project can hold.
 *
 * Annotations store their image inline as a data URL, so an agent that sent one
 * over the wire would be pushing hundreds of kilobytes of base64 through the
 * command channel and into its own context. It gives a path instead and the
 * renderer reads the file, which also means the agent can only reference images
 * that already exist on the user's disk.
 */

/** Anything bigger belongs on the timeline as a video, not baked into the project. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
};

export interface ImageReadResult {
	success: boolean;
	data?: ArrayBuffer;
	message?: string;
	error?: string;
}

/** Seam for tests: the real reader crosses IPC into the main process. */
export type ImageReader = (filePath: string) => Promise<ImageReadResult>;

function mimeTypeFor(filePath: string): string | null {
	const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
	return MIME_BY_EXTENSION[extension] ?? null;
}

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	// Chunked: spreading a megabyte of bytes into one call overflows the stack.
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export async function readImageAsDataUrl(filePath: string, read: ImageReader): Promise<string> {
	if (typeof filePath !== "string" || filePath.trim() === "") {
		throw new Error("An image annotation needs a file path.");
	}

	const mimeType = mimeTypeFor(filePath);
	if (!mimeType) {
		throw new Error(
			`Unsupported image type for "${filePath}". Use ${Object.keys(MIME_BY_EXTENSION).join(", ")}.`,
		);
	}

	const result = await read(filePath);
	if (!result.success || !result.data) {
		throw new Error(result.message || result.error || `Could not read "${filePath}".`);
	}
	if (result.data.byteLength > MAX_IMAGE_BYTES) {
		throw new Error(
			`"${filePath}" is ${Math.round(result.data.byteLength / 1024)} KB; the limit is ${
				MAX_IMAGE_BYTES / 1024
			} KB because the image is stored inside the project file.`,
		);
	}

	return `data:${mimeType};base64,${toBase64(result.data)}`;
}

/**
 * Replaces the `path` on any add_image command with the encoded image, leaving
 * every other command untouched.
 */
export async function resolveImageCommands(
	commands: readonly Record<string, unknown>[],
	read: ImageReader,
): Promise<Record<string, unknown>[]> {
	return Promise.all(
		commands.map(async (command) => {
			if (command?.op !== "add_image" || !("path" in command)) return command;
			const { path, ...rest } = command;
			return { ...rest, dataUrl: await readImageAsDataUrl(path as string, read) };
		}),
	);
}
