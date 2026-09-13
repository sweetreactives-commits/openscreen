import { describe, expect, it } from "vitest";
import { DOCUMENT_EXTENSIONS, sanitizeExportFileName } from "./exportFileName";

describe("sanitizeExportFileName", () => {
	it("accepts ordinary export names", () => {
		expect(sanitizeExportFileName("demo.gif")).toBe("demo.gif");
		expect(sanitizeExportFileName("release-notes-1.5.mp4")).toBe("release-notes-1.5.mp4");
		expect(sanitizeExportFileName("Getting Started.gif")).toBe("Getting Started.gif");
		expect(sanitizeExportFileName("отчёт.mp4")).toBe("отчёт.mp4");
	});

	it("trims surrounding whitespace", () => {
		expect(sanitizeExportFileName("  demo.gif  ")).toBe("demo.gif");
	});

	it("is case-insensitive about the extension", () => {
		expect(sanitizeExportFileName("Demo.GIF")).toBe("Demo.GIF");
		expect(sanitizeExportFileName("Demo.MP4")).toBe("Demo.MP4");
	});

	it("rejects anything that is a path rather than a name", () => {
		expect(sanitizeExportFileName("sub/demo.gif")).toBeNull();
		expect(sanitizeExportFileName("sub\\demo.gif")).toBeNull();
		expect(sanitizeExportFileName("C:/Windows/System32/evil.mp4")).toBeNull();
		expect(sanitizeExportFileName("/etc/demo.mp4")).toBeNull();
	});

	it("rejects traversal, however it is dressed up", () => {
		expect(sanitizeExportFileName("../demo.gif")).toBeNull();
		expect(sanitizeExportFileName("..demo.gif")).toBeNull();
		expect(sanitizeExportFileName("demo..gif")).toBeNull();
	});

	it("rejects characters a filesystem will not take", () => {
		expect(sanitizeExportFileName('de"mo.gif')).toBeNull();
		expect(sanitizeExportFileName("de*mo.gif")).toBeNull();
		expect(sanitizeExportFileName("de|mo.gif")).toBeNull();
		expect(sanitizeExportFileName("de<mo>.gif")).toBeNull();
		expect(sanitizeExportFileName("demo\u0000.gif")).toBeNull();
		expect(sanitizeExportFileName("demo\n.gif")).toBeNull();
	});

	it("rejects formats the exporter does not produce", () => {
		expect(sanitizeExportFileName("demo.exe")).toBeNull();
		expect(sanitizeExportFileName("demo.webm")).toBeNull();
		expect(sanitizeExportFileName("demo")).toBeNull();
		expect(sanitizeExportFileName("demo.gif.exe")).toBeNull();
	});

	it("rejects empty and absurd names", () => {
		expect(sanitizeExportFileName("")).toBeNull();
		expect(sanitizeExportFileName("   ")).toBeNull();
		expect(sanitizeExportFileName(`${"a".repeat(200)}.gif`)).toBeNull();
	});

	it("takes markdown only when the caller asks for a document", () => {
		expect(sanitizeExportFileName("guide.md")).toBeNull();
		expect(sanitizeExportFileName("guide.md", DOCUMENT_EXTENSIONS)).toBe("guide.md");
		expect(sanitizeExportFileName("guide.gif", DOCUMENT_EXTENSIONS)).toBeNull();
	});

	it("rejects anything that is not a string", () => {
		expect(sanitizeExportFileName(undefined)).toBeNull();
		expect(sanitizeExportFileName(42)).toBeNull();
		expect(sanitizeExportFileName({ toString: () => "demo.gif" })).toBeNull();
	});
});
