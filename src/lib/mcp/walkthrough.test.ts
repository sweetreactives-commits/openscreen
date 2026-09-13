import { describe, expect, it } from "vitest";
import {
	buildWalkthrough,
	imageFolderName,
	lastPathSegment,
	validateSteps,
	type WalkthroughStep,
} from "./walkthrough";

const step = (timeMs: number, title: string, body?: string): WalkthroughStep => ({
	timeMs,
	title,
	body,
});

describe("validateSteps", () => {
	it("accepts ordinary steps", () => {
		expect(validateSteps([step(0, "Open the panel")], 10_000)).toBeNull();
	});

	it("refuses an empty walkthrough", () => {
		expect(validateSteps([], 10_000)).toMatch(/at least one step/);
		expect(validateSteps(undefined, 10_000)).toMatch(/at least one step/);
	});

	it("refuses a step outside the recording", () => {
		expect(validateSteps([step(99_000, "Too late")], 10_000)).toMatch(/outside the recording/);
		expect(validateSteps([step(-1, "Too early")], 10_000)).toMatch(/outside the recording/);
	});

	it("refuses a step with no title", () => {
		expect(validateSteps([step(0, "   ")], 10_000)).toMatch(/needs a title/);
	});

	it("refuses a non-numeric time", () => {
		expect(validateSteps([{ timeMs: "start", title: "x" }], 10_000)).toMatch(/numeric timeMs/);
	});

	it("names the step at fault by position", () => {
		expect(validateSteps([step(0, "Fine"), step(0, "")], 10_000)).toMatch(/^Step 2/);
	});

	it("refuses an absurdly long walkthrough", () => {
		const many = Array.from({ length: 120 }, (_, i) => step(i, `Step ${i}`));
		expect(validateSteps(many, 10_000)).toMatch(/too long/);
	});
});

describe("lastPathSegment", () => {
	it("handles Windows paths, where a forward-slash split silently returns the lot", () => {
		expect(lastPathSegment("C:\\Users\\me\\recordings\\guide.md")).toBe("guide.md");
	});

	it("handles posix paths", () => {
		expect(lastPathSegment("/home/me/recordings/guide.md")).toBe("guide.md");
	});

	it("handles a bare name", () => {
		expect(lastPathSegment("guide.md")).toBe("guide.md");
	});
});

describe("imageFolderName", () => {
	it("sits next to the document and is named after it", () => {
		expect(imageFolderName("setup-guide.md")).toBe("setup-guide-images");
		expect(imageFolderName("Setup Guide.MD")).toBe("Setup Guide-images");
	});
});

describe("buildWalkthrough", () => {
	it("writes a heading, a timecode and an image per step", () => {
		const { markdown, images } = buildWalkthrough(
			"Exporting a GIF",
			[step(0, "Open the export panel"), step(65_000, "Pick GIF")],
			["AAA", "BBB"],
			"guide.md",
		);

		expect(markdown).toContain("# Exporting a GIF");
		expect(markdown).toContain("## 1. Open the export panel");
		expect(markdown).toContain("## 2. Pick GIF");
		expect(markdown).toContain("*0:00*");
		// 65 seconds reads as 1:05, not 65 seconds or 1:5.
		expect(markdown).toContain("*1:05*");
		expect(markdown).toContain("![Open the export panel](guide-images/step-01.jpg)");
		expect(images).toEqual([
			{ fileName: "step-01.jpg", base64: "AAA" },
			{ fileName: "step-02.jpg", base64: "BBB" },
		]);
	});

	it("zero-pads image names so the folder sorts in step order", () => {
		const many = Array.from({ length: 11 }, (_, i) => step(i * 1_000, `Step ${i + 1}`));
		const { images } = buildWalkthrough(
			"Long",
			many,
			many.map(() => "x"),
			"guide.md",
		);

		expect(images[0].fileName).toBe("step-01.jpg");
		expect(images[10].fileName).toBe("step-11.jpg");
	});

	it("includes the body when there is one", () => {
		const { markdown } = buildWalkthrough(
			"Guide",
			[step(0, "Click it", "  The button is in the top right.  ")],
			[null],
			"guide.md",
		);
		expect(markdown).toContain("The button is in the top right.");
	});

	it("keeps the step when its frame could not be grabbed", () => {
		const { markdown, images } = buildWalkthrough(
			"Guide",
			[step(0, "First"), step(1_000, "Second")],
			[null, "BBB"],
			"guide.md",
		);

		expect(markdown).toContain("## 1. First");
		expect(markdown).not.toContain("step-01.jpg");
		// The second step still gets its own name rather than sliding into the gap.
		expect(images).toEqual([{ fileName: "step-02.jpg", base64: "BBB" }]);
	});

	it("ends with exactly one newline", () => {
		const { markdown } = buildWalkthrough("Guide", [step(0, "Only")], ["AAA"], "guide.md");
		expect(markdown.endsWith("\n")).toBe(true);
		expect(markdown.endsWith("\n\n")).toBe(false);
	});
});
