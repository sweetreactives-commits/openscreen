import fs from "node:fs/promises";
import path from "node:path";
import { ipcMain } from "electron";

/**
 * Writes a walkthrough document and its screenshots.
 *
 * Every name here was decided on this side: the document name came through the
 * same sanitiser exports use, the folder is derived from it, and the image names
 * are generated per step. An agent never supplies a path segment.
 */

export const MCP_WRITE_WALKTHROUGH = "mcp:write-walkthrough";

export interface WalkthroughWriteResult {
	success: boolean;
	path?: string;
	imageCount?: number;
	message?: string;
}

export interface WalkthroughImagePayload {
	fileName: string;
	base64: string;
}

/** Belt and braces: these names are ours, but a path segment must never slip in. */
function isSafeImageName(fileName: unknown): fileName is string {
	return typeof fileName === "string" && /^step-\d{2,3}\.jpg$/.test(fileName);
}

export async function writeWalkthrough(
	docPath: string,
	markdown: string,
	imageFolder: string,
	images: readonly WalkthroughImagePayload[],
): Promise<WalkthroughWriteResult> {
	if (typeof docPath !== "string" || !path.isAbsolute(docPath)) {
		return { success: false, message: "Invalid document path." };
	}
	if (typeof markdown !== "string" || markdown.trim() === "") {
		return { success: false, message: "The walkthrough has no content." };
	}
	if (imageFolder.includes("/") || imageFolder.includes("\\") || imageFolder.includes("..")) {
		return { success: false, message: "Invalid image folder." };
	}

	const directory = path.join(path.dirname(docPath), imageFolder);

	try {
		if (images.length > 0) {
			await fs.mkdir(directory, { recursive: true });
			for (const image of images) {
				if (!isSafeImageName(image?.fileName)) {
					return { success: false, message: `Refusing to write image "${image?.fileName}".` };
				}
				await fs.writeFile(
					path.join(directory, image.fileName),
					Buffer.from(image.base64, "base64"),
				);
			}
		}

		await fs.writeFile(docPath, markdown, "utf-8");
		return { success: true, path: docPath, imageCount: images.length };
	} catch (error) {
		// The screenshots are useless without the document that references them, and
		// the caller cannot clean up a folder it was never told about.
		if (images.length > 0) {
			await fs.rm(directory, { recursive: true, force: true }).catch(() => {
				// Best effort; the write failure is the one worth reporting.
			});
		}
		return { success: false, message: `Could not write the walkthrough: ${String(error)}` };
	}
}

export function registerWalkthroughWriter(): void {
	ipcMain.handle(
		MCP_WRITE_WALKTHROUGH,
		(
			_event,
			docPath: string,
			markdown: string,
			imageFolder: string,
			images: WalkthroughImagePayload[],
		) => writeWalkthrough(docPath, markdown, imageFolder, images ?? []),
	);
}
