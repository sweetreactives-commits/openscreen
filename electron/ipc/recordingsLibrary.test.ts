import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectLibraryEntries, type LibraryFile } from "./recordingsLibrary";

/**
 * Reading a flat folder as a list of takes.
 *
 * The grouping carries a delete button, so the interesting cases are the ones
 * where a file could be attributed to the wrong take or to none: a webcam track
 * that looks like a video, a sidecar named after the video including its
 * extension, and a project file that is not a recording at all.
 */

const DIR = path.resolve("/data/openscreen/recordings");

function file(name: string, sizeBytes = 100, modifiedAtMs = 1_000): LibraryFile {
	return { name, sizeBytes, modifiedAtMs };
}

function at(dir: string, name: string) {
	return path.join(dir, name);
}

describe("collectLibraryEntries", () => {
	it("gathers a take's companions under its screen video", () => {
		const entries = collectLibraryEntries(
			[
				file("recording-1.webm"),
				file("recording-1-webcam.webm"),
				file("recording-1.webm.cursor.json"),
				file("recording-1.session.json"),
			],
			DIR,
		);

		expect(entries).toHaveLength(1);
		expect(entries[0].path).toBe(at(DIR, "recording-1.webm"));
		expect(entries[0].hasWebcam).toBe(true);
		expect(entries[0].hasCursorData).toBe(true);
		expect(entries[0].files.sort()).toEqual(
			[
				at(DIR, "recording-1.webm"),
				at(DIR, "recording-1-webcam.webm"),
				at(DIR, "recording-1.webm.cursor.json"),
				at(DIR, "recording-1.session.json"),
			].sort(),
		);
	});

	it("does not list a webcam track as a take of its own", () => {
		const entries = collectLibraryEntries(
			[file("recording-1.webm"), file("recording-1-webcam.webm")],
			DIR,
		);

		expect(entries.map((entry) => entry.name)).toEqual(["recording-1.webm"]);
	});

	it("leaves project files out", () => {
		const entries = collectLibraryEntries(
			[file("recording-1.webm"), file("recording-00000.openscreen")],
			DIR,
		);

		expect(entries.map((entry) => entry.name)).toEqual(["recording-1.webm"]);
	});

	it("keeps one take's files out of another's", () => {
		const entries = collectLibraryEntries(
			[
				file("recording-1.webm"),
				file("recording-1.webm.cursor.json"),
				file("recording-2.webm"),
				file("recording-2-webcam.webm"),
			],
			DIR,
		);

		const first = entries.find((entry) => entry.name === "recording-1.webm");
		const second = entries.find((entry) => entry.name === "recording-2.webm");
		expect(first?.files).not.toContain(at(DIR, "recording-2-webcam.webm"));
		expect(second?.files).not.toContain(at(DIR, "recording-1.webm.cursor.json"));
		expect(second?.hasCursorData).toBe(false);
	});

	it("reports what deleting the take would actually free", () => {
		const entries = collectLibraryEntries(
			[
				file("recording-1.webm", 1_000),
				file("recording-1-webcam.webm", 500),
				file("recording-1.webm.cursor.json", 25),
			],
			DIR,
		);

		expect(entries[0].sizeBytes).toBe(1_525);
	});

	it("lists imported clips alongside recordings", () => {
		const entries = collectLibraryEntries(
			[file("recording-1.webm"), file("imported-99-clip.mp4")],
			DIR,
		);

		expect(entries.map((entry) => entry.name).sort()).toEqual([
			"imported-99-clip.mp4",
			"recording-1.webm",
		]);
	});

	it("puts the newest take first", () => {
		const entries = collectLibraryEntries(
			[
				file("recording-old.webm", 100, 1_000),
				file("recording-new.webm", 100, 9_000),
				file("recording-mid.webm", 100, 5_000),
			],
			DIR,
		);

		expect(entries.map((entry) => entry.name)).toEqual([
			"recording-new.webm",
			"recording-mid.webm",
			"recording-old.webm",
		]);
	});

	it("ignores a sidecar whose video is gone", () => {
		const entries = collectLibraryEntries(
			[file("recording-1.webm.cursor.json"), file("recording-1.session.json")],
			DIR,
		);

		expect(entries).toEqual([]);
	});
});
