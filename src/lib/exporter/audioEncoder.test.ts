import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AudioProcessor,
	downmixPlanarChannelsForExport,
	fitChannels,
	placeDecodedPieces,
} from "./audioEncoder";

describe("AudioProcessor.selectSupportedExportCodec", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("falls back to stereo when the source channel count cannot be encoded", async () => {
		const isConfigSupported = vi.fn(async (config: AudioEncoderConfig) => ({
			config,
			supported:
				config.codec === "mp4a.40.2" &&
				config.sampleRate === 44100 &&
				config.numberOfChannels === 2,
		}));
		vi.stubGlobal("AudioEncoder", { isConfigSupported });

		const codec = await AudioProcessor.selectSupportedExportCodec(44100, 8);

		expect(codec).toMatchObject({
			encoderCodec: "mp4a.40.2",
			muxerCodec: "aac",
			sampleRate: 44100,
			numberOfChannels: 2,
		});
		expect(isConfigSupported).toHaveBeenCalledWith({
			codec: "mp4a.40.2",
			sampleRate: 44100,
			numberOfChannels: 8,
			bitrate: 128000,
		});
		expect(isConfigSupported).toHaveBeenCalledWith({
			codec: "mp4a.40.2",
			sampleRate: 44100,
			numberOfChannels: 2,
			bitrate: 128000,
		});
	});
});

describe("downmixPlanarChannelsForExport", () => {
	it("preserves non-front Windows system audio channels when exporting stereo", () => {
		const sourcePlanes = Array.from({ length: 8 }, (_, channel) => {
			const plane = new Float32Array(2);
			if (channel === 2) {
				plane[0] = 0.8;
				plane[1] = 0.4;
			}
			if (channel === 6) {
				plane[0] = 0.2;
				plane[1] = 0.1;
			}
			return plane;
		});

		const stereo = downmixPlanarChannelsForExport(sourcePlanes, 2);

		expect(stereo[0]).toBeGreaterThan(0);
		expect(stereo[1]).toBeGreaterThan(0);
		expect(stereo[2]).toBeGreaterThan(0);
		expect(stereo[3]).toBeGreaterThan(0);
	});

	it("duplicates mono microphone audio when exporting stereo", () => {
		const mono = new Float32Array([0.25, -0.5]);

		const stereo = downmixPlanarChannelsForExport([mono], 2);

		expect(Array.from(stereo)).toEqual([0.25, -0.5, 0.25, -0.5]);
	});
});

describe("fitChannels", () => {
	it("leaves a clip alone when it already fits the output", () => {
		const stereo = [new Float32Array([1, 1]), new Float32Array([2, 2])];
		expect(fitChannels(stereo, 2)).toBe(stereo);
	});

	it("leaves a mono clip for the assembler to spread, rather than inventing a channel", () => {
		const mono = [new Float32Array([0.5, 0.5])];
		expect(fitChannels(mono, 2)).toHaveLength(1);
	});

	it("mixes a stereo clip down into a mono output instead of keeping only the left", () => {
		const fitted = fitChannels([new Float32Array([1, 1]), new Float32Array([0, 0])], 1);
		expect(fitted).toHaveLength(1);
		expect(fitted[0][0]).toBeCloseTo(0.5, 5);
	});

	it("keeps the centre channel of a surround clip, where the speech is", () => {
		// 5.1 with sound only in the centre: dropping the extra channels would silence it.
		const frames = 4;
		const surround = Array.from({ length: 6 }, (_, channel) =>
			new Float32Array(frames).fill(channel === 2 ? 1 : 0),
		);
		const fitted = fitChannels(surround, 2);

		expect(fitted).toHaveLength(2);
		expect(fitted[0][0]).toBeGreaterThan(0);
		expect(fitted[1][0]).toBeGreaterThan(0);
	});
});

describe("placeDecodedPieces", () => {
	const RATE = 1_000; // one sample per millisecond keeps the arithmetic readable
	const piece = (timestampMs: number, values: number[]) => ({
		timestampUs: timestampMs * 1_000,
		planes: [new Float32Array(values)],
	});

	it("lays contiguous pieces end to end", () => {
		const [plane] = placeDecodedPieces([piece(0, [1, 1]), piece(2, [2, 2])], RATE, 1);
		expect(Array.from(plane)).toEqual([1, 1, 2, 2]);
	});

	it("keeps a real gap silent, so what follows does not drift earlier", () => {
		// A stall of 10ms between the pieces.
		const [plane] = placeDecodedPieces([piece(0, [1, 1]), piece(12, [2, 2])], RATE, 1);
		expect(plane.length).toBe(14);
		expect(Array.from(plane.subarray(2, 12))).toEqual(new Array(10).fill(0));
		expect(Array.from(plane.subarray(12))).toEqual([2, 2]);
	});

	it("snaps a piece that is a sample off from rounding, rather than leaving a click", () => {
		const [early] = placeDecodedPieces([piece(0, [1, 1]), piece(1, [2, 2])], RATE, 1);
		expect(Array.from(early)).toEqual([1, 1, 2, 2]);

		const [late] = placeDecodedPieces([piece(0, [1, 1]), piece(3, [2, 2])], RATE, 1);
		expect(Array.from(late)).toEqual([1, 1, 2, 2]);
	});

	it("keeps a late-starting stream's lead-in as silence", () => {
		const [plane] = placeDecodedPieces([piece(3, [1, 1])], RATE, 1);
		expect(Array.from(plane)).toEqual([0, 0, 0, 1, 1]);
	});

	it("drops priming samples that sit before zero", () => {
		const [plane] = placeDecodedPieces([piece(-2, [9, 9, 1, 2])], RATE, 1);
		expect(Array.from(plane)).toEqual([1, 2]);
	});

	it("survives priming longer than the piece itself", () => {
		const [plane] = placeDecodedPieces([piece(-10, [1, 2]), piece(0, [5])], RATE, 1);
		expect(Array.from(plane)).toEqual([5]);
	});

	it("has nothing to place from nothing", () => {
		expect(placeDecodedPieces([], RATE, 1)[0].length).toBe(0);
		expect(placeDecodedPieces([], RATE, 0)).toEqual([]);
	});
});
