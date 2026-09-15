import { WebDemuxer } from "web-demuxer";
import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import {
	type AudioPlacement,
	applyTrimsToSamples,
	assembleAudioTimeline,
	type PlanarAudio,
	planAudioChunks,
} from "./audioTimeline";
import type { ExportAudioMuxerCodec, VideoMuxer } from "./muxer";

const AUDIO_BITRATE = 128_000;
const DECODE_BACKPRESSURE_LIMIT = 20;
const MIN_SPEED_REGION_DELTA_MS = 0.0001;
const SEEK_TIMEOUT_MS = 5_000;

export interface ExportAudioCodec {
	encoderCodec: string;
	muxerCodec: ExportAudioMuxerCodec;
	label: string;
	sampleRate: number;
	numberOfChannels: number;
}

type ExportAudioCodecCandidate = Omit<ExportAudioCodec, "sampleRate" | "numberOfChannels">;

const EXPORT_AUDIO_CODECS: ExportAudioCodecCandidate[] = [
	{ encoderCodec: "mp4a.40.2", muxerCodec: "aac", label: "AAC" },
	{ encoderCodec: "opus", muxerCodec: "opus", label: "Opus" },
];

function averageChannels(sourcePlanes: Float32Array[], frame: number) {
	let mixed = 0;
	for (const plane of sourcePlanes) {
		mixed += plane[frame] ?? 0;
	}
	return mixed / Math.max(1, sourcePlanes.length);
}

function weightedSample(
	sourcePlanes: Float32Array[],
	frame: number,
	weights: Array<[channel: number, weight: number]>,
) {
	let mixed = 0;
	let weightSum = 0;
	for (const [channel, weight] of weights) {
		const sample = sourcePlanes[channel]?.[frame];
		if (typeof sample !== "number") {
			continue;
		}
		mixed += sample * weight;
		weightSum += weight;
	}
	return weightSum > 0 ? mixed / weightSum : averageChannels(sourcePlanes, frame);
}

function getStereoDownmixWeights(sourceChannels: number) {
	const centerWeight = Math.SQRT1_2;
	const surroundWeight = Math.SQRT1_2;
	const lfeWeight = 0.5;

	if (sourceChannels >= 8) {
		// Windows 7.1 order: FL, FR, FC, LFE, BL, BR, SL, SR.
		return {
			left: [
				[0, 1],
				[2, centerWeight],
				[3, lfeWeight],
				[4, surroundWeight],
				[6, surroundWeight],
			] satisfies Array<[number, number]>,
			right: [
				[1, 1],
				[2, centerWeight],
				[3, lfeWeight],
				[5, surroundWeight],
				[7, surroundWeight],
			] satisfies Array<[number, number]>,
		};
	}

	if (sourceChannels >= 6) {
		// Windows 5.1 order: FL, FR, FC, LFE, BL, BR.
		return {
			left: [
				[0, 1],
				[2, centerWeight],
				[3, lfeWeight],
				[4, surroundWeight],
			] satisfies Array<[number, number]>,
			right: [
				[1, 1],
				[2, centerWeight],
				[3, lfeWeight],
				[5, surroundWeight],
			] satisfies Array<[number, number]>,
		};
	}

	if (sourceChannels >= 4) {
		return {
			left: [
				[0, 1],
				[2, surroundWeight],
			] satisfies Array<[number, number]>,
			right: [
				[1, 1],
				[3, surroundWeight],
			] satisfies Array<[number, number]>,
		};
	}

	return {
		left: [
			[0, 1],
			[2, centerWeight],
		] satisfies Array<[number, number]>,
		right: [
			[1, 1],
			[2, centerWeight],
		] satisfies Array<[number, number]>,
	};
}

export function downmixPlanarChannelsForExport(
	sourcePlanes: Float32Array[],
	targetChannels: number,
): Float32Array {
	const frameCount = sourcePlanes[0]?.length ?? 0;
	const output = new Float32Array(frameCount * targetChannels);

	if (targetChannels === 1) {
		for (let frame = 0; frame < frameCount; frame++) {
			output[frame] = averageChannels(sourcePlanes, frame);
		}
		return output;
	}

	if (targetChannels !== 2) {
		throw new Error(`Unsupported target channel count: ${targetChannels}`);
	}

	if (sourcePlanes.length === 1) {
		output.set(sourcePlanes[0], 0);
		output.set(sourcePlanes[0], frameCount);
		return output;
	}

	if (sourcePlanes.length === 2) {
		output.set(sourcePlanes[0], 0);
		output.set(sourcePlanes[1], frameCount);
		return output;
	}

	const weights = getStereoDownmixWeights(sourcePlanes.length);
	for (let frame = 0; frame < frameCount; frame++) {
		output[frame] = weightedSample(sourcePlanes, frame, weights.left);
		output[frameCount + frame] = weightedSample(sourcePlanes, frame, weights.right);
	}
	return output;
}

/** One recording's part in a sequence's audio. Cards have no entry: they are silent. */
export interface SequenceAudioClip {
	demuxer: WebDemuxer;
	videoUrl: string;
	trimRegions?: readonly TrimRegion[];
	speedRegions?: readonly SpeedRegion[];
	validatedDurationSec: number;
	/**
	 * Where this clip's picture starts in the output. Sound follows the picture,
	 * and the picture moves in whole frames, so callers derive this from frame
	 * counts rather than from exact milliseconds.
	 */
	outStartMs: number;
}

/**
 * Brings a clip to the output's channel count.
 *
 * More channels than the output are mixed down properly — dropping the extras
 * would lose the centre channel, which is where speech lives. Fewer are left
 * alone: the assembler already spreads a mono clip across every output channel.
 */
export function fitChannels(samples: PlanarAudio, channels: number): PlanarAudio {
	if (samples.length <= channels) return samples;

	const frames = samples[0].length;
	const flat = downmixPlanarChannelsForExport(samples, channels);
	return Array.from({ length: channels }, (_, channel) =>
		flat.subarray(channel * frames, (channel + 1) * frames),
	);
}

/** A decoded piece of a stream, before it is laid on the clip's own track. */
export interface DecodedPiece {
	timestampUs: number;
	planes: PlanarAudio;
}

/** Within this many samples a piece counts as following on, not as a gap or overlap. */
const SNAP_FRAMES = 2;

/**
 * Lays decoded pieces out by their own timestamps.
 *
 * Simply concatenating them would be wrong the moment a stream has a gap — a
 * microphone that stalled, a capture that fell behind: everything after the gap
 * would slide earlier and the sound would drift ahead of the picture for the rest
 * of the clip. So each piece goes where its timestamp says, and a real gap stays
 * silent.
 *
 * Timestamps are microseconds rounded from sample counts, so contiguous pieces
 * routinely land a sample early or late. A piece within `SNAP_FRAMES` of where
 * the previous one ended is treated as following on; otherwise rounding would
 * leave single-sample holes and overlaps, which are audible as clicks.
 *
 * Anything before zero — codec priming shows up as a negative timestamp — is
 * dropped, since it was never meant to be heard.
 */
export function placeDecodedPieces(
	pieces: readonly DecodedPiece[],
	sampleRate: number,
	channels: number,
	snapFrames: number = SNAP_FRAMES,
): PlanarAudio {
	if (channels < 1 || sampleRate <= 0) return [];

	const placed: { start: number; planes: PlanarAudio }[] = [];
	let cursor = Number.NEGATIVE_INFINITY;
	for (const piece of pieces) {
		const length = piece.planes[0]?.length ?? 0;
		if (length === 0) continue;

		let start = Math.round((piece.timestampUs / 1_000_000) * sampleRate);
		if (Math.abs(start - cursor) <= snapFrames) start = cursor;
		placed.push({ start, planes: piece.planes });
		cursor = start + length;
	}

	const end = placed.reduce((max, piece) => Math.max(max, piece.start + piece.planes[0].length), 0);
	const output: PlanarAudio = Array.from({ length: channels }, () => new Float32Array(end));

	for (const piece of placed) {
		const skip = Math.max(0, -piece.start);
		const at = Math.max(0, piece.start);
		for (let channel = 0; channel < channels; channel++) {
			const source = piece.planes[channel] ?? piece.planes[0];
			if (skip < source.length) output[channel].set(source.subarray(skip), at);
		}
	}

	return output;
}

/** Planar samples out of decoded frames, each placed where its timestamp says. */
function audioDataToPlanar(frames: readonly AudioData[]): PlanarAudio {
	const channels = frames[0].numberOfChannels;
	const pieces: DecodedPiece[] = frames.map((frame) => ({
		timestampUs: frame.timestamp,
		planes: Array.from({ length: channels }, (_, channel) => {
			const plane = new Float32Array(frame.numberOfFrames);
			frame.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
			return plane;
		}),
	}));
	return placeDecodedPieces(pieces, frames[0].sampleRate, channels);
}

/** Converts samples between rates. A no-op when they already match. */
async function resamplePlanar(
	samples: PlanarAudio,
	fromRate: number,
	toRate: number,
): Promise<PlanarAudio> {
	if (fromRate === toRate || samples.length === 0 || samples[0].length === 0) return samples;

	const length = Math.max(1, Math.round((samples[0].length * toRate) / fromRate));
	const context = new OfflineAudioContext(samples.length, length, toRate);
	const buffer = context.createBuffer(samples.length, samples[0].length, fromRate);
	// A fresh copy: planes may be views into a shared buffer, which copyToChannel refuses.
	samples.forEach((plane, channel) => buffer.copyToChannel(new Float32Array(plane), channel));

	const source = context.createBufferSource();
	source.buffer = buffer;
	source.connect(context.destination);
	source.start();

	const rendered = await context.startRendering();
	return Array.from({ length: rendered.numberOfChannels }, (_, channel) =>
		rendered.getChannelData(channel),
	);
}

/** Decodes a rendered audio file to samples at `sampleRate`; the context resamples. */
async function decodeBlobToPlanar(blob: Blob, sampleRate: number): Promise<PlanarAudio> {
	const context = new OfflineAudioContext(1, 1, sampleRate);
	const buffer = await context.decodeAudioData(await blob.arrayBuffer());
	return Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
		buffer.getChannelData(channel),
	);
}

export class AudioProcessor {
	private cancelled = false;

	static async selectSupportedExportCodec(
		sampleRate: number,
		numberOfChannels: number,
	): Promise<ExportAudioCodec | null> {
		const channelOptions = [numberOfChannels];
		if (numberOfChannels > 2) {
			channelOptions.push(2);
		}

		if (!channelOptions.includes(1)) {
			channelOptions.push(1);
		}

		for (const codec of EXPORT_AUDIO_CODECS) {
			for (const channels of channelOptions) {
				const support = await AudioEncoder.isConfigSupported({
					codec: codec.encoderCodec,
					sampleRate,
					numberOfChannels: channels,
					bitrate: AUDIO_BITRATE,
				});
				if (support.supported) {
					return { ...codec, sampleRate, numberOfChannels: channels };
				}
			}
		}

		return null;
	}

	/**
	 * Picks an export codec matching a source's audio. `maxChannels` caps the
	 * channel count, for a sequence whose takes need one layout that fits them all.
	 */
	static async selectSupportedExportCodecForSource(
		demuxer: WebDemuxer,
		maxChannels = Number.POSITIVE_INFINITY,
	): Promise<ExportAudioCodec | null> {
		let audioConfig: AudioDecoderConfig;
		try {
			audioConfig = await demuxer.getDecoderConfig("audio");
		} catch {
			return null;
		}

		const codecCheck = await AudioDecoder.isConfigSupported(audioConfig);
		if (!codecCheck.supported) {
			console.warn("[AudioProcessor] Audio codec not supported:", audioConfig.codec);
			return null;
		}

		return AudioProcessor.selectSupportedExportCodec(
			audioConfig.sampleRate || 48000,
			Math.min(maxChannels, audioConfig.numberOfChannels || 2),
		);
	}

	/**
	 * Builds the whole audio track for a sequence of clips and muxes it.
	 *
	 * Every recording is brought down to plain samples at the export rate — decoded
	 * from its own stream, or rendered in real time first when it has speed changes,
	 * because only that pass keeps the pitch — and placed where its picture starts.
	 * Cards contribute nothing, and the silence under them is free: the assembled
	 * track starts out as zeroes.
	 */
	async processSequence(
		clips: readonly SequenceAudioClip[],
		muxer: VideoMuxer,
		exportCodec: ExportAudioCodec,
	): Promise<void> {
		const sampleRate = exportCodec.sampleRate;
		const channels = exportCodec.numberOfChannels;

		const placements: AudioPlacement[] = [];
		for (const clip of clips) {
			if (this.cancelled) return;
			const samples = await this.extractClipSamples(clip, sampleRate);
			if (samples.length === 0 || samples[0].length === 0) continue;
			placements.push({ outStartMs: clip.outStartMs, samples: fitChannels(samples, channels) });
		}
		if (this.cancelled || placements.length === 0) return;

		const track = assembleAudioTimeline(placements, sampleRate, channels);
		await this.encodeTrack(track, sampleRate, channels, exportCodec, muxer);
	}

	/** One recording's sound as samples at `sampleRate`, with its trims and speeds applied. */
	private async extractClipSamples(
		clip: SequenceAudioClip,
		sampleRate: number,
	): Promise<PlanarAudio> {
		const trims = clip.trimRegions
			? [...clip.trimRegions].sort((a, b) => a.startMs - b.startMs)
			: [];
		const speeds = clip.speedRegions
			? clip.speedRegions
					.filter((region) => region.endMs - region.startMs > MIN_SPEED_REGION_DELTA_MS)
					.sort((a, b) => a.startMs - b.startMs)
			: [];

		if (speeds.length > 0) {
			// The real-time pass already applies trims and speeds; what comes back is
			// finished sound with nothing left to cut.
			const rendered = await this.renderPitchPreservedTimelineAudio(
				clip.videoUrl,
				trims,
				speeds,
				clip.validatedDurationSec,
			);
			if (this.cancelled || rendered.size === 0) return [];
			return decodeBlobToPlanar(rendered, sampleRate);
		}

		// The +0.5s mirrors streamingDecoder.decodeAll's read window, so sound and
		// picture read the same distance past the validated duration.
		const decoded = await this.decodeStreamToPlanar(clip.demuxer, clip.validatedDurationSec + 0.5);
		if (!decoded || this.cancelled) return [];

		const resampled = await resamplePlanar(decoded.samples, decoded.sampleRate, sampleRate);
		return applyTrimsToSamples(resampled, sampleRate, clip.validatedDurationSec * 1000, trims);
	}

	/** Decodes a recording's audio stream to planar samples at its own rate. */
	private async decodeStreamToPlanar(
		demuxer: WebDemuxer,
		readEndSec: number,
	): Promise<{ samples: PlanarAudio; sampleRate: number } | null> {
		let config: AudioDecoderConfig;
		try {
			config = await demuxer.getDecoderConfig("audio");
		} catch {
			return null;
		}
		if (!(await AudioDecoder.isConfigSupported(config)).supported) {
			console.warn("[AudioProcessor] Audio codec not supported:", config.codec);
			return null;
		}

		const frames: AudioData[] = [];
		const decoder = new AudioDecoder({
			output: (data: AudioData) => frames.push(data),
			error: (e: DOMException) => console.error("[AudioProcessor] Decode error:", e),
		});
		decoder.configure(config);

		const reader = demuxer.read("audio", 0, Math.max(0, readEndSec)).getReader();
		try {
			while (!this.cancelled) {
				const { done, value: chunk } = await reader.read();
				if (done || !chunk) break;
				decoder.decode(chunk);
				while (decoder.decodeQueueSize > DECODE_BACKPRESSURE_LIMIT && !this.cancelled) {
					await new Promise((resolve) => setTimeout(resolve, 1));
				}
			}
		} finally {
			try {
				await reader.cancel();
			} catch {
				/* reader already closed */
			}
		}

		if (decoder.state === "configured") {
			await decoder.flush();
			decoder.close();
		}

		try {
			if (this.cancelled || frames.length === 0) return null;
			return { samples: audioDataToPlanar(frames), sampleRate: frames[0].sampleRate };
		} finally {
			for (const frame of frames) frame.close();
		}
	}

	/** Encodes an assembled track in encoder-sized pieces and hands the result to the muxer. */
	private async encodeTrack(
		track: PlanarAudio,
		sampleRate: number,
		channels: number,
		exportCodec: ExportAudioCodec,
		muxer: VideoMuxer,
	): Promise<void> {
		const config: AudioEncoderConfig = {
			codec: exportCodec.encoderCodec,
			sampleRate,
			numberOfChannels: channels,
			bitrate: AUDIO_BITRATE,
		};
		if (!(await AudioEncoder.isConfigSupported(config)).supported) {
			console.warn(`[AudioProcessor] ${exportCodec.label} encoding not supported, skipping audio`);
			return;
		}

		const encoded: { chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[] = [];
		const encoder = new AudioEncoder({
			output: (chunk, meta) => encoded.push({ chunk, meta }),
			error: (e: DOMException) => console.error("[AudioProcessor] Encode error:", e),
		});
		encoder.configure(config);

		const totalFrames = track[0]?.length ?? 0;
		let cursor = 0;
		for (const piece of planAudioChunks(totalFrames, sampleRate)) {
			if (this.cancelled) break;

			const data = new Float32Array(piece.frames * channels);
			for (let channel = 0; channel < channels; channel++) {
				data.set(track[channel].subarray(cursor, cursor + piece.frames), channel * piece.frames);
			}
			const audioData = new AudioData({
				format: "f32-planar",
				sampleRate,
				numberOfFrames: piece.frames,
				numberOfChannels: channels,
				timestamp: piece.timestampUs,
				data,
			});
			encoder.encode(audioData);
			audioData.close();
			cursor += piece.frames;

			while (encoder.encodeQueueSize > DECODE_BACKPRESSURE_LIMIT && !this.cancelled) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
		}

		if (encoder.state === "configured") {
			await encoder.flush();
			encoder.close();
		}

		for (const { chunk, meta } of encoded) {
			if (this.cancelled) break;
			await muxer.addAudioChunk(chunk, meta);
		}
	}

	private async renderPitchPreservedTimelineAudio(
		videoUrl: string,
		trimRegions: TrimRegion[],
		speedRegions: SpeedRegion[],
		validatedDurationSec: number,
	): Promise<Blob> {
		const media = document.createElement("audio");
		media.src = videoUrl;
		media.preload = "auto";

		const pitchMedia = media as HTMLMediaElement & {
			preservesPitch?: boolean;
			mozPreservesPitch?: boolean;
			webkitPreservesPitch?: boolean;
		};
		pitchMedia.preservesPitch = true;
		pitchMedia.mozPreservesPitch = true;
		pitchMedia.webkitPreservesPitch = true;

		await this.waitForLoadedMetadata(media);
		if (this.cancelled) {
			throw new Error("Export cancelled");
		}

		const audioContext = new AudioContext();
		const sourceNode = audioContext.createMediaElementSource(media);
		const destinationNode = audioContext.createMediaStreamDestination();
		sourceNode.connect(destinationNode);

		let rafId: number | null = null;
		let recorder: MediaRecorder | null = null;
		let recordedBlobPromise: Promise<Blob> | null = null;

		try {
			if (audioContext.state === "suspended") {
				await audioContext.resume();
			}

			// Skip initial trim region(s) before recording so the first rAF frames don't
			// capture trimmed audio. Loops to handle back-to-back/overlapping trims at t=0.
			const effectiveEnd = validatedDurationSec;
			let startPosition = 0;
			for (let i = 0; i <= trimRegions.length; i++) {
				const activeTrim = this.findActiveTrimRegion(startPosition * 1000, trimRegions);
				if (!activeTrim) break;
				startPosition = activeTrim.endMs / 1000;
				if (startPosition >= effectiveEnd) break;
			}

			if (startPosition >= effectiveEnd) {
				// Everything is trimmed; return a silent blob.
				return new Blob([], { type: "audio/webm" });
			}

			await this.seekTo(media, startPosition);

			// Set initial playback rate for the starting position.
			const initialSpeedRegion = this.findActiveSpeedRegion(startPosition * 1000, speedRegions);
			if (initialSpeedRegion) {
				media.playbackRate = initialSpeedRegion.speed;
			}

			// Start recording only after seeking past trims.
			const recording = this.startAudioRecording(destinationNode.stream);
			recorder = recording.recorder;
			recordedBlobPromise = recording.recordedBlobPromise;
			await media.play();

			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					if (rafId !== null) {
						cancelAnimationFrame(rafId);
						rafId = null;
					}
					media.removeEventListener("error", onError);
					media.removeEventListener("ended", onEnded);
				};

				const onError = () => {
					cleanup();
					reject(new Error("Failed while rendering speed-adjusted audio timeline"));
				};

				const onEnded = () => {
					cleanup();
					resolve();
				};

				const tick = () => {
					if (this.cancelled) {
						cleanup();
						resolve();
						return;
					}

					// Stop at validated duration; media.duration can be inflated by bad
					// container metadata.
					if (media.currentTime >= validatedDurationSec) {
						media.pause();
						cleanup();
						resolve();
						return;
					}

					const currentTimeMs = media.currentTime * 1000;
					const activeTrimRegion = this.findActiveTrimRegion(currentTimeMs, trimRegions);

					if (activeTrimRegion && !media.paused && !media.ended) {
						const skipToTime = activeTrimRegion.endMs / 1000;
						if (skipToTime >= media.duration || skipToTime >= validatedDurationSec) {
							media.pause();
							cleanup();
							resolve();
							return;
						}
						// Pause recording during the seek so we don't capture silence/noise.
						media.pause();
						if (recorder?.state === "recording") recorder.pause();
						const onSeeked = () => {
							clearTimeout(seekTimer);
							if (this.cancelled) {
								cleanup();
								resolve();
								return;
							}
							if (recorder?.state === "paused") recorder.resume();
							media
								.play()
								.then(() => {
									if (!this.cancelled) rafId = requestAnimationFrame(tick);
								})
								.catch((err) => {
									cleanup();
									reject(
										new Error(
											`Failed to resume playback after trim seek: ${err instanceof Error ? err.message : String(err)}`,
										),
									);
								});
						};
						const seekTimer = window.setTimeout(() => {
							media.removeEventListener("seeked", onSeeked);
							cleanup();
							reject(new Error("Audio seek timed out while skipping trim region"));
						}, SEEK_TIMEOUT_MS);
						media.addEventListener("seeked", onSeeked, { once: true });
						media.currentTime = skipToTime;
						return;
					}

					const activeSpeedRegion = this.findActiveSpeedRegion(currentTimeMs, speedRegions);
					const playbackRate = activeSpeedRegion ? activeSpeedRegion.speed : 1;
					if (Math.abs(media.playbackRate - playbackRate) > 0.0001) {
						media.playbackRate = playbackRate;
					}

					if (!media.paused && !media.ended) {
						rafId = requestAnimationFrame(tick);
					} else {
						cleanup();
						resolve();
					}
				};

				media.addEventListener("error", onError, { once: true });
				media.addEventListener("ended", onEnded, { once: true });
				rafId = requestAnimationFrame(tick);
			});
		} finally {
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
			}
			media.pause();
			if (recorder && recorder.state !== "inactive") {
				recorder.stop();
			}
			destinationNode.stream.getTracks().forEach((track) => track.stop());
			sourceNode.disconnect();
			destinationNode.disconnect();
			await audioContext.close();
			media.src = "";
			media.load();
		}

		if (!recordedBlobPromise) {
			// Either an early return fired or startAudioRecording set this before playback
			// resolved. Reaching here means that broke; fail loud rather than return silence.
			throw new Error("Audio recorder finished without assigning recordedBlobPromise");
		}
		const recordedBlob = await recordedBlobPromise;
		if (this.cancelled) {
			throw new Error("Export cancelled");
		}
		return recordedBlob;
	}

	// Demux the rendered speed-adjusted blob and feed its chunks into the MP4 muxer.
	private startAudioRecording(stream: MediaStream): {
		recorder: MediaRecorder;
		recordedBlobPromise: Promise<Blob>;
	} {
		const mimeType = this.getSupportedAudioMimeType();
		const options: MediaRecorderOptions = {
			audioBitsPerSecond: AUDIO_BITRATE,
			...(mimeType ? { mimeType } : {}),
		};

		const recorder = new MediaRecorder(stream, options);
		const chunks: Blob[] = [];

		const recordedBlobPromise = new Promise<Blob>((resolve, reject) => {
			recorder.ondataavailable = (event: BlobEvent) => {
				if (event.data && event.data.size > 0) {
					chunks.push(event.data);
				}
			};
			recorder.onerror = () => {
				reject(new Error("MediaRecorder failed while capturing speed-adjusted audio"));
			};
			recorder.onstop = () => {
				const type = mimeType || chunks[0]?.type || "audio/webm";
				resolve(new Blob(chunks, { type }));
			};
		});

		recorder.start();
		return { recorder, recordedBlobPromise };
	}

	private getSupportedAudioMimeType(): string | undefined {
		const candidates = ["audio/webm;codecs=opus", "audio/webm"];
		for (const candidate of candidates) {
			if (MediaRecorder.isTypeSupported(candidate)) {
				return candidate;
			}
		}
		return undefined;
	}

	private waitForLoadedMetadata(media: HTMLMediaElement): Promise<void> {
		if (Number.isFinite(media.duration) && media.readyState >= HTMLMediaElement.HAVE_METADATA) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			const onLoaded = () => {
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error("Failed to load media metadata for speed-adjusted audio"));
			};
			const cleanup = () => {
				media.removeEventListener("loadedmetadata", onLoaded);
				media.removeEventListener("error", onError);
			};

			media.addEventListener("loadedmetadata", onLoaded);
			media.addEventListener("error", onError, { once: true });
		});
	}

	private seekTo(media: HTMLMediaElement, targetSec: number): Promise<void> {
		if (Math.abs(media.currentTime - targetSec) < 0.0001) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			const onSeeked = () => {
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error("Failed to seek media for speed-adjusted audio"));
			};
			const cleanup = () => {
				media.removeEventListener("seeked", onSeeked);
				media.removeEventListener("error", onError);
			};

			media.addEventListener("seeked", onSeeked, { once: true });
			media.addEventListener("error", onError, { once: true });
			media.currentTime = targetSec;
		});
	}

	private findActiveTrimRegion(
		currentTimeMs: number,
		trimRegions: TrimRegion[],
	): TrimRegion | null {
		return (
			trimRegions.find(
				(region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
			) || null
		);
	}

	private findActiveSpeedRegion(
		currentTimeMs: number,
		speedRegions: SpeedRegion[],
	): SpeedRegion | null {
		return (
			speedRegions.find(
				(region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
			) || null
		);
	}

	cancel(): void {
		this.cancelled = true;
	}
}
