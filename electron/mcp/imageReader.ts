import fs from "node:fs/promises";
import path from "node:path";
import { ipcMain } from "electron";

/**
 * Reads an image an agent named, for an image annotation.
 *
 * Not `read-binary-file`: that one runs paths through `approveReadableVideoPath`,
 * which only clears a path that is already inside the recordings folder or ends
 * in a video extension. A png in the user's Pictures folder — the case the tool
 * invites — is refused, so `add_image` could not read anything a person actually
 * keeps.
 *
 * Reading is a milder act than writing, and the caller already holds full
 * access, so the rule here is narrower than a directory allow-list: it must be a
 * real file, of an image type the annotation can hold, under the size the
 * project can carry.
 */

export const MCP_READ_IMAGE = "mcp:read-image";

/** Matches what `src/lib/mcp/imageAnnotation.ts` will encode. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

/** The bytes end up inside the project file, so this is the project's limit too. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export interface ImageReadResult {
	success: boolean;
	data?: ArrayBuffer;
	message?: string;
}

export async function readImageForAgent(filePath: unknown): Promise<ImageReadResult> {
	if (typeof filePath !== "string" || filePath.trim() === "" || !path.isAbsolute(filePath)) {
		return { success: false, message: "Give an absolute path to an image file." };
	}

	const resolved = path.resolve(filePath);
	if (!IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
		return {
			success: false,
			message: `"${path.basename(resolved)}" is not an image. Use ${[...IMAGE_EXTENSIONS].join(", ")}.`,
		};
	}

	try {
		const stats = await fs.stat(resolved);
		if (!stats.isFile()) {
			return { success: false, message: "That path is not a file." };
		}
		if (stats.size > MAX_IMAGE_BYTES) {
			return {
				success: false,
				message: `That image is ${Math.round(stats.size / 1024)} KB; the limit is ${
					MAX_IMAGE_BYTES / 1024
				} KB because it is stored inside the project file.`,
			};
		}

		const buffer = await fs.readFile(resolved);
		return {
			success: true,
			data: buffer.buffer.slice(
				buffer.byteOffset,
				buffer.byteOffset + buffer.byteLength,
			) as ArrayBuffer,
		};
	} catch (error) {
		return { success: false, message: `Could not read that image: ${String(error)}` };
	}
}

export function registerImageReader(): void {
	ipcMain.handle(MCP_READ_IMAGE, (_event, filePath: unknown) => readImageForAgent(filePath));
}
