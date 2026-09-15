import { describe, expect, it } from "vitest";
import smallVideoUrl from "../../tests/fixtures/sample-small.webm?url";
import { probeMediaDurationMs } from "./mediaDuration";

describe("probeMediaDurationMs (real browser)", () => {
	it("reads the length from the file's header", async () => {
		const ms = await probeMediaDurationMs(smallVideoUrl);
		expect(ms).not.toBeNull();
		expect(ms).toBeGreaterThan(1_500);
		expect(ms).toBeLessThan(2_500);
	});

	it("gives up with null on something that is not a video", async () => {
		const url = URL.createObjectURL(new Blob(["not a video"], { type: "video/webm" }));
		expect(await probeMediaDurationMs(url, 3_000)).toBeNull();
	});
});
