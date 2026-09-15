import path from "node:path";

/**
 * Where a video picked as an extra clip should live.
 *
 * A project reopened later only trusts media inside its own folder or the
 * recordings folder — a crafted project file must not be able to approve reads
 * from anywhere. So a clip picked from elsewhere is copied into the recordings
 * folder, and the project points at the copy; a clip already in there is used
 * where it is. Copying costs disk and time on a large file, but the alternative is
 * a project that saves fine and then refuses to open.
 */
export interface ClipImportPlan {
	/** The path the project will reference. */
	target: string;
	/** Whether the picked file has to be copied to `target` first. */
	copy: boolean;
}

function isWithin(filePath: string, dirPath: string): boolean {
	const resolved = path.resolve(filePath);
	const resolvedDir = path.resolve(dirPath);
	return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
}

/** A file name that cannot collide with a recording or escape the folder. */
function importedName(pickedPath: string, now: number): string {
	const base = path.basename(pickedPath);
	// Keep the name recognisable, but only the characters every filesystem accepts.
	const safe = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "clip";
	return `imported-${now}-${safe}`;
}

export function planClipImport(
	pickedPath: string,
	recordingsDir: string,
	now: number = Date.now(),
): ClipImportPlan {
	if (isWithin(pickedPath, recordingsDir)) {
		return { target: path.resolve(pickedPath), copy: false };
	}
	return { target: path.join(recordingsDir, importedName(pickedPath, now)), copy: true };
}
