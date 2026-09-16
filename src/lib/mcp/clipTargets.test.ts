import { describe, expect, it } from "vitest";
import type { ClipEntry } from "@/components/video-editor/clips";
import { isClipTargetError, resolveClipTarget } from "./clipTargets";

const clips: ClipEntry[] = [
	{ id: "card-1", kind: "card", durationMs: 2_000, title: "Intro" },
	{ id: "clip-1", kind: "recording" },
	{ id: "clip-2", kind: "recording", media: { screenVideoPath: "C:/takes/two.webm" } },
	{ id: "clip-3", kind: "recording" },
];

const resolve = (clipId?: unknown) =>
	resolveClipTarget(clips, "clip-1", "file:///C:/takes/one.webm", "C:/takes/one.webm", clipId);

describe("resolveClipTarget", () => {
	it("answers with the open recording when no clip is named", () => {
		expect(resolve()).toEqual({
			clipId: "clip-1",
			videoUrl: "file:///C:/takes/one.webm",
			sourcePath: "C:/takes/one.webm",
			open: true,
		});
	});

	it("answers with the open recording when it is the one named", () => {
		expect(resolve("clip-1")).toMatchObject({ clipId: "clip-1", open: true });
	});

	it("reads another recording from its own file", () => {
		const target = resolve("clip-2");
		expect(isClipTargetError(target)).toBe(false);
		expect(target).toMatchObject({
			clipId: "clip-2",
			sourcePath: "C:/takes/two.webm",
			open: false,
		});
		if (!isClipTargetError(target)) expect(target.videoUrl).toContain("two.webm");
	});

	it("names the clips that exist when asked for one that does not", () => {
		const target = resolve("clip-9");
		expect(isClipTargetError(target)).toBe(true);
		if (isClipTargetError(target)) {
			expect(target.error).toContain("clip-1");
			expect(target.error).toContain("clip-2");
		}
	});

	it("explains that a card has nothing to read", () => {
		const target = resolve("card-1");
		expect(isClipTargetError(target) && target.error).toMatch(/title card/);
	});

	it("refuses a recording whose file the editor cannot reach", () => {
		// clip-3 is not the open one, yet carries no media: a project that lost a file.
		expect(isClipTargetError(resolve("clip-3"))).toBe(true);
	});

	it("refuses a clipId that is not a string", () => {
		expect(isClipTargetError(resolve(7))).toBe(true);
	});

	it("says so when nothing is open at all", () => {
		const target = resolveClipTarget(clips, "clip-1", null, null);
		expect(isClipTargetError(target) && target.error).toMatch(/No recording is open/);
	});
});
