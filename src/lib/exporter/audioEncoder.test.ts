import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioProcessor, downmixPlanarChannelsForExport, planLeadInSilence } from "./audioEncoder";

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

describe("planLeadInSilence", () => {
	it("covers exactly the silence an intro card needs", () => {
		const pieces = planLeadInSilence(3_000_000, 48_000);
		const frames = pieces.reduce((sum, piece) => sum + piece.frames, 0);

		// Three seconds at 48kHz.
		expect(frames).toBe(144_000);
	});

	it("lays the pieces end to end, starting at the very beginning", () => {
		const pieces = planLeadInSilence(100_000, 48_000, 512);

		expect(pieces[0].timestampUs).toBe(0);
		let frame = 0;
		for (const piece of pieces) {
			expect(piece.timestampUs).toBe(Math.round((frame / 48_000) * 1_000_000));
			frame += piece.frames;
		}
	});

	it("never hands the encoder a piece bigger than it asked for", () => {
		for (const piece of planLeadInSilence(3_000_000, 48_000)) {
			expect(piece.frames).toBeLessThanOrEqual(1024);
			expect(piece.frames).toBeGreaterThan(0);
		}
	});

	it("has nothing to fill when there is no card in front", () => {
		expect(planLeadInSilence(0, 48_000)).toEqual([]);
		expect(planLeadInSilence(-1, 48_000)).toEqual([]);
		expect(planLeadInSilence(3_000_000, 0)).toEqual([]);
	});

	it("scales with the sample rate rather than assuming one", () => {
		expect(planLeadInSilence(1_000_000, 44_100).reduce((sum, piece) => sum + piece.frames, 0)).toBe(
			44_100,
		);
	});
});
