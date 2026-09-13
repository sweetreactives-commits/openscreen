/**
 * Validates the file name an agent may give an export.
 *
 * A name, never a path: the directory is the user's export folder, chosen in the
 * app, and an agent that could name a directory could write anywhere. Shared
 * with the main process, like the command contracts, so both sides agree on
 * exactly what is allowed.
 */

/** Long enough for anything descriptive, short enough for every filesystem. */
const MAX_NAME_LENGTH = 120;

/** Reserved on Windows, and meaningless in a file name anywhere. */
const RESERVED_CHARACTERS = '<>:"|?*';

/** Below this codepoint everything is a control byte, none of it a file name. */
const FIRST_PRINTABLE_CODEPOINT = 0x20;

function hasForbiddenCharacter(name: string): boolean {
	for (const character of name) {
		if (RESERVED_CHARACTERS.includes(character)) return true;
		if ((character.codePointAt(0) ?? 0) < FIRST_PRINTABLE_CODEPOINT) return true;
	}
	return false;
}

/** Formats the app actually produces. A walkthrough is written, not rendered. */
export type AllowedExtension = "mp4" | "gif" | "md";

export const RENDER_EXTENSIONS: readonly AllowedExtension[] = ["mp4", "gif"];
export const DOCUMENT_EXTENSIONS: readonly AllowedExtension[] = ["md"];

export function sanitizeExportFileName(
	fileName: unknown,
	allowed: readonly AllowedExtension[] = RENDER_EXTENSIONS,
): string | null {
	if (typeof fileName !== "string") return null;

	const trimmed = fileName.trim();
	if (trimmed === "" || trimmed.length > MAX_NAME_LENGTH) return null;
	// A separator or a traversal segment would turn a name into a path.
	if (trimmed.includes("/") || trimmed.includes("\\")) return null;
	if (trimmed.includes("..")) return null;
	if (hasForbiddenCharacter(trimmed)) return null;
	const extension = trimmed.split(".").pop()?.toLowerCase() ?? "";
	if (!allowed.includes(extension as AllowedExtension)) return null;

	return trimmed;
}
