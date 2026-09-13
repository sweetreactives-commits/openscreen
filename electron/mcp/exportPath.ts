import fs from "node:fs/promises";
import path from "node:path";
import { ipcMain } from "electron";
import {
	type AllowedExtension,
	RENDER_EXTENSIONS,
	sanitizeExportFileName,
} from "../../src/lib/mcp/exportFileName";

/**
 * Where an agent's export is allowed to land.
 *
 * The agent supplies a file name and nothing else. The directory is the user's
 * own export folder, or the recordings folder if they have never chosen one —
 * an agent never names a directory, so it cannot write outside the two places
 * exports already go.
 *
 * This exists instead of reusing `write-export-to-path`, whose own comment says
 * it assumes a trusted renderer: it accepts any absolute path ending .mp4 or
 * .gif, creates the directory, and overwrites without asking. That is a
 * reasonable guard against a stale-state bug and no guard at all against a
 * caller from outside the app.
 */

export const MCP_RESOLVE_EXPORT_PATH = "mcp:resolve-export-path";

export interface ResolvedExportPath {
	success: boolean;
	path?: string;
	message?: string;
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * @param exportFolder The folder the user last exported to, from their
 *   preferences. It lives in renderer storage, so the renderer passes it in.
 */
export async function resolveExportPath(
	fileName: unknown,
	exportFolder: unknown,
	fallbackDirectory: string,
	allowed: readonly AllowedExtension[] = RENDER_EXTENSIONS,
): Promise<ResolvedExportPath> {
	const safeName = sanitizeExportFileName(fileName, allowed);
	if (!safeName) {
		return {
			success: false,
			message:
				`Give a plain file name ending in ${allowed.map((e) => `.${e}`).join(" or ")} — ` +
				"not a path. The folder is the user's export folder and is not yours to choose.",
		};
	}

	const directory =
		typeof exportFolder === "string" && exportFolder.trim() !== ""
			? exportFolder
			: fallbackDirectory;

	const target = path.join(directory, safeName);
	if (await exists(target)) {
		return {
			success: false,
			message: `"${safeName}" already exists in the export folder. Choose another name; an agent does not overwrite files.`,
		};
	}

	try {
		await fs.mkdir(directory, { recursive: true });
	} catch (error) {
		return { success: false, message: `Could not prepare the export folder: ${String(error)}` };
	}

	return { success: true, path: target };
}

export function registerExportPathHandler(fallbackDirectory: string): void {
	ipcMain.handle(
		MCP_RESOLVE_EXPORT_PATH,
		(_event, fileName: unknown, exportFolder: unknown, allowed?: AllowedExtension[]) =>
			resolveExportPath(fileName, exportFolder, fallbackDirectory, allowed ?? RENDER_EXTENSIONS),
	);
}
