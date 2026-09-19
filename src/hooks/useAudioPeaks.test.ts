import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Telling "still decoding" apart from "there is no sound".
 *
 * The hook used to answer `null` to both, which is why a waveform toggle could
 * be switched on a take recorded in silence and simply do nothing: nothing
 * downstream could tell a slow answer from a final one, so nothing could say
 * why the waveform never arrived.
 */

const loadFileAsArrayBuffer = vi.fn();
vi.mock("@/lib/exporter/streamingDecoder", () => ({
	loadFileAsArrayBuffer: (url: string) => loadFileAsArrayBuffer(url),
}));

const { useAudioPeaks } = await import("./useAudioPeaks");

describe("useAudioPeaks", () => {
	it("is idle with nothing to decode", () => {
		const { result } = renderHook(() => useAudioPeaks(undefined));

		expect(result.current.status).toBe("idle");
		expect(result.current.peaks).toBeNull();
	});

	it("starts out loading rather than claiming there is no audio", () => {
		// Never settles: the decode is still in flight for as long as the test looks.
		loadFileAsArrayBuffer.mockReturnValue(
			new Promise(() => {
				/* deliberately pending */
			}),
		);

		const { result } = renderHook(() => useAudioPeaks("file:///take.webm"));

		expect(result.current.status).toBe("loading");
		expect(result.current.peaks).toBeNull();
	});

	it("settles on no-audio when the file carries none", async () => {
		// Nothing to decode: the loader rejecting is the same outcome as a file
		// with no audio track, and both end the attempt for good.
		loadFileAsArrayBuffer.mockRejectedValue(new Error("no audio track"));

		const { result } = renderHook(() => useAudioPeaks("file:///silent.webm"));

		await waitFor(() => {
			expect(result.current.status).toBe("no-audio");
		});
		expect(result.current.peaks).toBeNull();
	});
});
