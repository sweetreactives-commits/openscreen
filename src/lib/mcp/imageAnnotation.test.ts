import { describe, expect, it, vi } from "vitest";
import {
	type ImageReader,
	MAX_IMAGE_BYTES,
	readImageAsDataUrl,
	resolveImageCommands,
} from "./imageAnnotation";

const bytes = (length: number, fill = 1) => new Uint8Array(length).fill(fill).buffer as ArrayBuffer;

const reader =
	(result: Awaited<ReturnType<ImageReader>>): ImageReader =>
	async () =>
		result;

describe("readImageAsDataUrl", () => {
	it("encodes a readable image as a data URL with the right type", async () => {
		const url = await readImageAsDataUrl(
			"C:/shots/arrow.png",
			reader({ success: true, data: bytes(4, 65) }),
		);
		expect(url).toBe("data:image/png;base64,QUFBQQ==");
	});

	it("maps jpg and jpeg to the same type", async () => {
		const read = reader({ success: true, data: bytes(1) });
		expect(await readImageAsDataUrl("a.jpg", read)).toContain("data:image/jpeg;");
		expect(await readImageAsDataUrl("a.jpeg", read)).toContain("data:image/jpeg;");
	});

	it("refuses a file type that is not an image", async () => {
		await expect(
			readImageAsDataUrl("notes.txt", reader({ success: true, data: bytes(1) })),
		).rejects.toThrow(/Unsupported image type/);
	});

	it("refuses an empty path", async () => {
		await expect(readImageAsDataUrl("   ", reader({ success: true }))).rejects.toThrow(
			/needs a file path/,
		);
	});

	it("passes through the reason a file could not be read", async () => {
		await expect(
			readImageAsDataUrl("gone.png", reader({ success: false, message: "File not found" })),
		).rejects.toThrow("File not found");
	});

	it("refuses an image too large to live inside the project file", async () => {
		await expect(
			readImageAsDataUrl("huge.png", reader({ success: true, data: bytes(MAX_IMAGE_BYTES + 1) })),
		).rejects.toThrow(/the limit is/);
	});

	it("accepts an image exactly at the limit", async () => {
		const url = await readImageAsDataUrl(
			"big.png",
			reader({ success: true, data: bytes(MAX_IMAGE_BYTES) }),
		);
		expect(url.startsWith("data:image/png;base64,")).toBe(true);
	});

	it("encodes a large image without blowing the stack", async () => {
		// One argument per byte would overflow; the encoder chunks instead.
		const url = await readImageAsDataUrl(
			"big.png",
			reader({ success: true, data: bytes(500_000) }),
		);
		expect(url.length).toBeGreaterThan(600_000);
	});
});

describe("resolveImageCommands", () => {
	it("swaps a path for the encoded image and drops the path", async () => {
		const read = vi.fn(async () => ({ success: true, data: bytes(3, 66) }));
		const [command] = await resolveImageCommands(
			[{ op: "add_image", startMs: 0, endMs: 1_000, path: "C:/a.png" }],
			read,
		);

		expect(read).toHaveBeenCalledWith("C:/a.png");
		expect(command.dataUrl).toBe("data:image/png;base64,QkJC");
		expect(command).not.toHaveProperty("path");
		expect(command.startMs).toBe(0);
	});

	it("leaves other commands alone", async () => {
		const read = vi.fn(async () => ({ success: true, data: bytes(1) }));
		const commands = await resolveImageCommands(
			[
				{ op: "add_zoom", startMs: 0, endMs: 500 },
				{ op: "set_cursor", size: 3 },
			],
			read,
		);

		expect(read).not.toHaveBeenCalled();
		expect(commands).toEqual([
			{ op: "add_zoom", startMs: 0, endMs: 500 },
			{ op: "set_cursor", size: 3 },
		]);
	});

	it("fails the whole batch when one image cannot be read", async () => {
		await expect(
			resolveImageCommands(
				[
					{ op: "add_image", startMs: 0, endMs: 1, path: "ok.png" },
					{ op: "add_image", startMs: 0, endMs: 1, path: "missing.png" },
				],
				(async (filePath: string) =>
					filePath === "ok.png"
						? { success: true, data: bytes(1) }
						: { success: false, message: "File not found" }) as ImageReader,
			),
		).rejects.toThrow("File not found");
	});
});
