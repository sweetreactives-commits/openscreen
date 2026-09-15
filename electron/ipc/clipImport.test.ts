import path from "node:path";
import { describe, expect, it } from "vitest";
import { planClipImport } from "./clipImport";

const recordings = path.resolve("/data/openscreen/recordings");

describe("planClipImport", () => {
	it("uses a video already in the recordings folder where it is", () => {
		const picked = path.join(recordings, "recording-1.webm");
		expect(planClipImport(picked, recordings)).toEqual({ target: picked, copy: false });
	});

	it("copies a video from anywhere else into the recordings folder", () => {
		const plan = planClipImport(path.resolve("/home/me/Downloads/demo.mp4"), recordings, 42);
		expect(plan.copy).toBe(true);
		expect(path.dirname(plan.target)).toBe(recordings);
		expect(path.basename(plan.target)).toBe("imported-42-demo.mp4");
	});

	it("keeps the extension, since the reader decides by it", () => {
		const plan = planClipImport(path.resolve("/tmp/take two.MOV"), recordings, 1);
		expect(path.extname(plan.target)).toBe(".MOV");
	});

	it("does not let a name reach outside the folder or hide itself", () => {
		const plan = planClipImport(path.resolve("/tmp/..weird name!!.webm"), recordings, 1);
		expect(path.dirname(plan.target)).toBe(recordings);
		expect(path.basename(plan.target)).toMatch(/^imported-1-[A-Za-z0-9._-]+$/);
		expect(path.basename(plan.target)).not.toMatch(/^imported-1-\./);
	});

	it("treats a folder that merely starts with the same letters as outside", () => {
		const lookalike = path.resolve(`${recordings}-old/clip.webm`);
		expect(planClipImport(lookalike, recordings).copy).toBe(true);
	});

	it("gives each import its own name, so two picks of the same file do not collide", () => {
		const picked = path.resolve("/tmp/demo.webm");
		expect(planClipImport(picked, recordings, 1).target).not.toBe(
			planClipImport(picked, recordings, 2).target,
		);
	});
});
