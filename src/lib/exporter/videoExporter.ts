import type {
	AnnotationRegion,
	CropRegion,
	SpeedRegion,
	TrimRegion,
	WebcamLayoutPreset,
	WebcamSizePreset,
	ZoomRegion,
} from "@/components/video-editor/types";
import { cardFrameCount, drawCardFrame } from "@/lib/cardFrame";
import { BackgroundLoadError } from "@/lib/wallpaper";
import type { CursorRecordingData } from "@/native/contracts";
import { getPlatform } from "@/utils/platformUtils";
import { AudioProcessor, type SequenceAudioClip } from "./audioEncoder";
import {
	type ExportCard,
	type ExportRecording,
	type ExportSequenceClip,
	resolveExportSequence,
} from "./exportSequence";
import { type FrameClipContext, FrameRenderer } from "./frameRenderer";
import { VideoMuxer } from "./muxer";
import { StreamingVideoDecoder } from "./streamingDecoder";
import { TimestampedVideoFrameQueue } from "./timestampedVideoFrameQueue";
import type { ExportConfig, ExportProgress, ExportResult } from "./types";

const ENCODER_STALL_TIMEOUT_MS = 15_000;
const ENCODER_FLUSH_TIMEOUT_MS = 20_000;

export type { ExportCard, ExportRecording, ExportSequenceClip } from "./exportSequence";
export { resolveExportSequence } from "./exportSequence";

export interface VideoExporterConfig extends ExportConfig {
	videoUrl: string;
	/**
	 * Everything to render, in order — several recordings and cards between them.
	 * When present it replaces the single recording described by the top-level
	 * fields and `cards`, which are then ignored.
	 */
	sequence?: ExportSequenceClip[];
	/**
	 * Card clips flanking the recording, already split by the caller. The exporter
	 * deliberately knows nothing about the project's clip model — only that some
	 * still frames come before the recording and some after.
	 */
	cards?: { before: ExportCard[]; after: ExportCard[] };
	webcamVideoUrl?: string;
	wallpaper: string;
	zoomRegions: ZoomRegion[];
	trimRegions?: TrimRegion[];
	speedRegions?: SpeedRegion[];
	showShadow: boolean;
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount?: number;
	borderRadius?: number;
	padding?: number;
	videoPadding?: number;
	cropRegion: CropRegion;
	webcamLayoutPreset?: WebcamLayoutPreset;
	webcamMaskShape?: import("@/components/video-editor/types").WebcamMaskShape;
	webcamMirrored?: boolean;
	webcamReactiveZoom?: boolean;
	webcamSizePreset?: WebcamSizePreset;
	webcamPosition?: { cx: number; cy: number } | null;
	cursorRecordingData?: CursorRecordingData | null;
	cursorScale?: number;
	cursorSmoothing?: number;
	cursorMotionBlur?: number;
	cursorClickBounce?: number;
	cursorClickRipple?: number;
	cursorClipToBounds?: boolean;
	cursorTheme?: string;
	annotationRegions?: AnnotationRegion[];
	previewWidth?: number;
	previewHeight?: number;
	cursorTelemetry?: import("@/components/video-editor/types").CursorTelemetryPoint[];
	cursorClickTimestamps?: number[];
	onProgress?: (progress: ExportProgress) => void;
}

const SOURCE_COPY_EPSILON = 0.0001;

function hasActiveTimeRegions(regions?: Array<{ startMs: number; endMs: number }>) {
	return Boolean(regions?.some((region) => region.endMs - region.startMs > SOURCE_COPY_EPSILON));
}

function hasActiveSpeedRegions(regions?: SpeedRegion[]) {
	return Boolean(
		regions?.some(
			(region) =>
				region.endMs - region.startMs > SOURCE_COPY_EPSILON &&
				Math.abs(region.speed - 1) > SOURCE_COPY_EPSILON,
		),
	);
}

function hasNativeCursorOverlay(config: VideoExporterConfig) {
	return (config.cursorScale ?? 0) > 0;
}

function isDefaultCrop(cropRegion: CropRegion) {
	return (
		Math.abs(cropRegion.x) <= SOURCE_COPY_EPSILON &&
		Math.abs(cropRegion.y) <= SOURCE_COPY_EPSILON &&
		Math.abs(cropRegion.width - 1) <= SOURCE_COPY_EPSILON &&
		Math.abs(cropRegion.height - 1) <= SOURCE_COPY_EPSILON
	);
}

export function isSourceCopyFastPathEligible(
	config: VideoExporterConfig,
	videoInfo: { width: number; height: number },
) {
	return getSourceCopyFastPathBlockers(config, videoInfo).length === 0;
}

export function getSourceCopyFastPathBlockers(
	config: VideoExporterConfig,
	videoInfo: { width: number; height: number },
) {
	const blockers: string[] = [];

	if (config.sequence && config.sequence.length > 0) {
		// The top-level fields do not describe a sequence, so judging edits by them
		// would call an edited project untouched and copy the first file through.
		blockers.push("the export is a sequence");
	}

	if (config.width !== videoInfo.width || config.height !== videoInfo.height) {
		blockers.push(
			`output-size ${config.width}x${config.height} differs from source ${videoInfo.width}x${videoInfo.height}`,
		);
	}
	if (config.cards?.before.length || config.cards?.after.length) {
		// Copying the source through would drop the cards entirely.
		blockers.push("the project has card clips");
	}
	if (config.webcamVideoUrl) blockers.push("webcam overlay is enabled");
	if (hasActiveTimeRegions(config.trimRegions)) blockers.push("trim regions are present");
	if (hasActiveSpeedRegions(config.speedRegions)) blockers.push("speed regions are present");
	if (hasActiveTimeRegions(config.zoomRegions)) blockers.push("zoom regions are present");
	if (hasActiveTimeRegions(config.annotationRegions))
		blockers.push("annotation regions are present");
	if (hasNativeCursorOverlay(config)) blockers.push("editable cursor overlay is enabled");
	if (!isDefaultCrop(config.cropRegion)) blockers.push("crop is not default");
	if ((config.padding ?? 0) > SOURCE_COPY_EPSILON) blockers.push("padding is not zero");
	if ((config.videoPadding ?? 0) > SOURCE_COPY_EPSILON) blockers.push("video padding is not zero");
	if ((config.borderRadius ?? 0) > SOURCE_COPY_EPSILON) blockers.push("roundness is not zero");
	if (config.showShadow || config.shadowIntensity > SOURCE_COPY_EPSILON) {
		blockers.push("shadow is enabled");
	}
	if (config.showBlur) blockers.push("background blur is enabled");
	if ((config.motionBlurAmount ?? 0) > SOURCE_COPY_EPSILON) blockers.push("motion blur is enabled");

	return blockers;
}

function isMp4Source(videoUrl: string, blob: Blob) {
	if (blob.type.toLowerCase().includes("mp4")) {
		return true;
	}

	try {
		const path = new URL(videoUrl, window.location.href).pathname;
		return path.toLowerCase().endsWith(".mp4");
	} catch {
		return videoUrl.toLowerCase().split(/[?#]/, 1)[0].endsWith(".mp4");
	}
}

export class VideoExporter {
	private config: VideoExporterConfig;
	/** Every decoder this export opened, so cancelling stops all of them. */
	private decoders: StreamingVideoDecoder[] = [];
	private renderer: FrameRenderer | null = null;
	private encoder: VideoEncoder | null = null;
	private muxer: VideoMuxer | null = null;
	private audioProcessor: AudioProcessor | null = null;
	private cancelled = false;
	private encodeQueue = 0;
	// Keep a smaller queue for software encoding so Windows does not balloon memory.
	private readonly MAX_ENCODE_QUEUE = 120;
	private videoDescription: Uint8Array | undefined;
	private videoColorSpace: VideoColorSpaceInit | undefined;
	private muxingPromises: Promise<void>[] = [];
	private chunkCount = 0;
	private lastEncoderOutputAt = 0;
	private fatalEncoderError: Error | null = null;

	constructor(config: VideoExporterConfig) {
		this.config = config;
	}

	async export(): Promise<ExportResult> {
		const encoderPreferences = this.getEncoderPreferences();
		let lastError: Error | null = null;

		for (const encoderPreference of encoderPreferences) {
			try {
				return await this.exportWithEncoderPreference(encoderPreference);
			} catch (error) {
				const normalizedError = error instanceof Error ? error : new Error(String(error));
				lastError = normalizedError;

				if (this.cancelled) {
					return { success: false, error: "Export cancelled" };
				}

				if (normalizedError instanceof BackgroundLoadError) {
					throw normalizedError;
				}

				if (encoderPreferences.length > 1) {
					console.warn(
						`[VideoExporter] ${encoderPreference} export attempt failed:`,
						normalizedError,
					);
				}
			} finally {
				this.cleanup();
			}
		}

		return {
			success: false,
			error: lastError?.message || "Export failed",
		};
	}

	private async exportWithEncoderPreference(
		encoderPreference: HardwareAcceleration,
	): Promise<ExportResult> {
		const warnings: string[] = [];
		const onWarning = (message: string) => warnings.push(message);

		this.cleanup();
		this.cancelled = false;
		this.fatalEncoderError = null;

		const platform = await getPlatform();
		const sequence = resolveExportSequence(this.config);
		const frameRate = this.config.frameRate;

		// Phase 1: open every recording up front. Frame counts decide the progress
		// budget and where each clip's sound starts, so they are needed before a
		// single frame is rendered.
		type LoadedRecording = {
			recording: ExportRecording;
			decoder: StreamingVideoDecoder;
			info: Awaited<ReturnType<StreamingVideoDecoder["loadMetadata"]>>;
			webcamDecoder: StreamingVideoDecoder | null;
			webcamInfo: Awaited<ReturnType<StreamingVideoDecoder["loadMetadata"]>> | null;
			frames: number;
		};
		const loaded = new Map<ExportSequenceClip, LoadedRecording>();
		for (const clip of sequence) {
			if (clip.kind !== "recording") continue;
			const { recording } = clip;

			const decoder = new StreamingVideoDecoder();
			this.decoders.push(decoder);
			const info = await decoder.loadMetadata(recording.videoUrl);

			let webcamDecoder: StreamingVideoDecoder | null = null;
			let webcamInfo: LoadedRecording["webcamInfo"] = null;
			if (recording.webcamVideoUrl) {
				webcamDecoder = new StreamingVideoDecoder();
				this.decoders.push(webcamDecoder);
				webcamInfo = await webcamDecoder.loadMetadata(recording.webcamVideoUrl);
			}

			const { totalFrames } = decoder.getExportMetrics(
				frameRate,
				recording.trimRegions,
				recording.speedRegions,
			);
			loaded.set(clip, {
				recording,
				decoder,
				info,
				webcamDecoder,
				webcamInfo,
				frames: totalFrames,
			});
		}

		const recordings = [...loaded.values()];
		if (recordings.length === 0) {
			throw new Error("Nothing to export: the sequence contains no recording");
		}

		// Copying the source through is only possible for the classic single file.
		if (!this.config.sequence && sequence.length === 1) {
			const sourceCopyResult = await this.trySourceCopyFastPath(recordings[0].info);
			if (sourceCopyResult) {
				return sourceCopyResult;
			}
		}

		const clipContext = (entry: LoadedRecording): FrameClipContext => ({
			zoomRegions: entry.recording.zoomRegions,
			cropRegion: entry.recording.cropRegion,
			cursorRecordingData: entry.recording.cursorRecordingData,
			cursorTelemetry: entry.recording.cursorTelemetry,
			cursorClickTimestamps: entry.recording.cursorClickTimestamps,
			videoWidth: entry.info.width,
			videoHeight: entry.info.height,
			webcamSize: entry.webcamInfo
				? { width: entry.webcamInfo.width, height: entry.webcamInfo.height }
				: null,
			annotationRegions: entry.recording.annotationRegions,
			speedRegions: entry.recording.speedRegions,
		});

		const renderer = new FrameRenderer({
			width: this.config.width,
			height: this.config.height,
			wallpaper: this.config.wallpaper,
			showShadow: this.config.showShadow,
			shadowIntensity: this.config.shadowIntensity,
			showBlur: this.config.showBlur,
			motionBlurAmount: this.config.motionBlurAmount,
			borderRadius: this.config.borderRadius,
			padding: this.config.padding,
			cursorScale: this.config.cursorScale,
			cursorSmoothing: this.config.cursorSmoothing,
			cursorMotionBlur: this.config.cursorMotionBlur,
			cursorClickBounce: this.config.cursorClickBounce,
			cursorClickRipple: this.config.cursorClickRipple,
			cursorClipToBounds: this.config.cursorClipToBounds,
			cursorTheme: this.config.cursorTheme,
			webcamLayoutPreset: this.config.webcamLayoutPreset,
			webcamMaskShape: this.config.webcamMaskShape,
			webcamMirrored: this.config.webcamMirrored,
			webcamReactiveZoom: this.config.webcamReactiveZoom,
			webcamSizePreset: this.config.webcamSizePreset,
			webcamPosition: this.config.webcamPosition,
			previewWidth: this.config.previewWidth,
			previewHeight: this.config.previewHeight,
			platform,
			...clipContext(recordings[0]),
		});
		this.renderer = renderer;
		await renderer.initialize();

		await this.initializeEncoder(encoderPreference);

		// The first recording with sound sets the track's format; the others are
		// resampled to it. Several takes are held to stereo, since a surround take
		// followed by a mono one has no sensible layout wider than that.
		const audioSource = recordings.find(
			(entry) => entry.info.hasAudio && entry.decoder.getDemuxer(),
		);
		const audioDemuxer = audioSource?.decoder.getDemuxer() ?? null;
		const audioExportCodec = audioDemuxer
			? await AudioProcessor.selectSupportedExportCodecForSource(
					audioDemuxer,
					recordings.length > 1 ? 2 : Number.POSITIVE_INFINITY,
				)
			: null;
		if (audioSource && !audioExportCodec) {
			console.warn("[VideoExporter] No supported audio export codec, exporting video-only.");
		}

		const hasAudio = Boolean(audioExportCodec);
		const muxer = new VideoMuxer(this.config, hasAudio, audioExportCodec?.muxerCodec);
		this.muxer = muxer;
		await muxer.initialize();

		// Progress counts every clip, cards included, or it would climb past 100%.
		const totalFrames = sequence.reduce(
			(sum, clip) =>
				sum +
				(clip.kind === "card"
					? cardFrameCount(clip.card.durationMs, frameRate)
					: (loaded.get(clip)?.frames ?? 0)),
			0,
		);

		const frameDuration = 1_000_000 / frameRate;
		let frameIndex = 0;
		const maxEncodeQueue =
			encoderPreference === "prefer-software"
				? Math.min(this.MAX_ENCODE_QUEUE, 32)
				: this.MAX_ENCODE_QUEUE;

		/**
		 * Encodes whatever is on a canvas as the next output frame.
		 *
		 * Shared by every recording and every card: the encoder only ever sees a
		 * canvas and a running frame number, so a still card and a decoded video
		 * frame travel the same path and the timestamps stay continuous across joins.
		 */
		const encodeCanvas = async (canvas: HTMLCanvasElement) => {
			if (this.fatalEncoderError) {
				throw this.fatalEncoderError;
			}
			const timestamp = frameIndex * frameDuration;

			let exportFrame: VideoFrame;

			// On some Linux systems the GPU shared-image path (EGL/Ozone) fails
			// silently, producing empty frames, so we force a CPU readback instead.
			if (platform === "linux") {
				const canvasCtx = canvas.getContext("2d")!;
				const imageData = canvasCtx.getImageData(0, 0, canvas.width, canvas.height);
				exportFrame = new VideoFrame(imageData.data.buffer, {
					format: "RGBA",
					codedWidth: canvas.width,
					codedHeight: canvas.height,
					timestamp,
					duration: frameDuration,
					colorSpace: {
						primaries: "bt709",
						transfer: "iec61966-2-1",
						matrix: "rgb",
						fullRange: true,
					},
				});
			} else {
				exportFrame = new VideoFrame(canvas, { timestamp, duration: frameDuration });
			}

			while (this.encoder && this.encoder.encodeQueueSize >= maxEncodeQueue && !this.cancelled) {
				if (Date.now() - this.lastEncoderOutputAt > ENCODER_STALL_TIMEOUT_MS) {
					exportFrame.close();
					throw new Error(
						encoderPreference === "prefer-hardware"
							? "The hardware video encoder stopped responding. Retrying with a safer encoder."
							: "The video encoder stopped responding during export.",
					);
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}

			if (this.encoder && this.encoder.state === "configured") {
				this.encodeQueue++;
				this.encoder.encode(exportFrame, { keyFrame: frameIndex % 150 === 0 });
			} else {
				console.warn(`[Frame ${frameIndex}] Encoder not ready! State: ${this.encoder?.state}`);
			}

			exportFrame.close();
			frameIndex++;

			this.reportProgress({
				currentFrame: frameIndex,
				totalFrames,
				percentage: (frameIndex / totalFrames) * 100,
				estimatedTimeRemaining: 0,
			});
		};

		/** Draws a card once and encodes those same pixels for as long as it lasts. */
		const emitCard = async (card: ExportCard) => {
			const cardCanvas = document.createElement("canvas");
			cardCanvas.width = this.config.width;
			cardCanvas.height = this.config.height;
			const cardCtx = cardCanvas.getContext("2d");
			if (!cardCtx) throw new Error("Could not get a 2D context to draw a card clip");

			drawCardFrame(cardCtx, {
				width: cardCanvas.width,
				height: cardCanvas.height,
				title: card.title,
			});
			const frames = cardFrameCount(card.durationMs, frameRate);
			for (let i = 0; i < frames && !this.cancelled; i++) {
				await encodeCanvas(cardCanvas);
			}
		};

		/** Decodes one recording and renders it, with its webcam alongside if it has one. */
		const renderRecording = async (entry: LoadedRecording) => {
			renderer.setClipContext(clipContext(entry));

			let stopWebcamDecode = false;
			let webcamDecodeError: Error | null = null;
			const webcamDecoder = entry.webcamDecoder;
			const webcamQueue = webcamDecoder ? new TimestampedVideoFrameQueue() : null;
			const webcamDecodePromise =
				webcamDecoder && webcamQueue
					? webcamDecoder
							.decodeAll(
								frameRate,
								entry.recording.trimRegions,
								entry.recording.speedRegions,
								async (webcamFrame, _exportTimestampUs, webcamSourceTimestampMs) => {
									while (webcamQueue.length >= 12 && !this.cancelled && !stopWebcamDecode) {
										await new Promise((resolve) => setTimeout(resolve, 2));
									}
									if (this.cancelled || stopWebcamDecode) {
										webcamFrame.close();
										return;
									}
									webcamQueue.enqueue(webcamFrame, webcamSourceTimestampMs);
								},
								onWarning,
							)
							.catch((error) => {
								webcamDecodeError = error instanceof Error ? error : new Error(String(error));
								throw webcamDecodeError;
							})
							.finally(() => {
								if (webcamDecodeError) {
									webcamQueue.fail(webcamDecodeError);
								} else {
									webcamQueue.close();
								}
							})
					: null;

			try {
				await entry.decoder.decodeAll(
					frameRate,
					entry.recording.trimRegions,
					entry.recording.speedRegions,
					async (videoFrame, _exportTimestampUs, sourceTimestampMs) => {
						let webcamFrame: VideoFrame | null = null;
						try {
							if (this.cancelled) {
								return;
							}

							if (this.fatalEncoderError) {
								throw this.fatalEncoderError;
							}

							webcamFrame = webcamQueue ? await webcamQueue.frameAt(sourceTimestampMs) : null;
							if (this.cancelled) {
								return;
							}

							await renderer.renderFrame(videoFrame, sourceTimestampMs * 1000, webcamFrame);
							await encodeCanvas(renderer.getCanvas());
						} finally {
							videoFrame.close();
							webcamFrame?.close();
						}
					},
					onWarning,
				);
			} finally {
				stopWebcamDecode = true;
				webcamQueue?.destroy();
				webcamDecoder?.cancel();
				if (webcamDecodePromise) {
					await webcamDecodePromise.catch(() => undefined);
				}
			}
		};

		// Phase 2: render the sequence in order, remembering where each recording
		// started so its sound can be placed under it.
		const startFrames = new Map<LoadedRecording, number>();
		for (const clip of sequence) {
			if (this.cancelled) break;
			if (clip.kind === "card") {
				await emitCard(clip.card);
			} else {
				const entry = loaded.get(clip);
				if (!entry) continue;
				startFrames.set(entry, frameIndex);
				await renderRecording(entry);
			}
			if (this.fatalEncoderError) {
				throw this.fatalEncoderError;
			}
		}

		if (this.cancelled) {
			return { success: false, error: "Export cancelled" };
		}

		if (this.encoder && this.encoder.state === "configured") {
			await this.withTimeout(
				this.encoder.flush(),
				ENCODER_FLUSH_TIMEOUT_MS,
				encoderPreference === "prefer-hardware"
					? "The hardware video encoder stopped responding while finalizing the export."
					: "The video encoder stopped responding while finalizing the export.",
			);
		}

		if (this.fatalEncoderError) {
			throw this.fatalEncoderError;
		}

		await Promise.all(this.muxingPromises);

		this.reportProgress({
			currentFrame: totalFrames,
			totalFrames,
			percentage: 100,
			estimatedTimeRemaining: 0,
			phase: "finalizing",
		});

		// Phase 3: one audio track under the whole sequence.
		if (hasAudio && audioExportCodec && !this.cancelled) {
			const audioClips: SequenceAudioClip[] = [];
			for (const entry of recordings) {
				const demuxer = entry.decoder.getDemuxer();
				const startFrame = startFrames.get(entry);
				if (!demuxer || startFrame === undefined) continue;
				audioClips.push({
					demuxer,
					videoUrl: entry.recording.videoUrl,
					trimRegions: entry.recording.trimRegions,
					speedRegions: entry.recording.speedRegions,
					validatedDurationSec: entry.info.duration,
					// Sound follows the picture, which moves in whole frames.
					outStartMs: (startFrame * 1000) / frameRate,
				});
			}

			this.audioProcessor = new AudioProcessor();
			await this.audioProcessor.processSequence(audioClips, muxer, audioExportCodec);
		}

		const blob = await muxer.finalize();
		return { success: true, blob, warnings: warnings.length > 0 ? warnings : undefined };
	}

	private async initializeEncoder(hardwareAcceleration: HardwareAcceleration): Promise<void> {
		this.encodeQueue = 0;
		this.muxingPromises = [];
		this.chunkCount = 0;
		this.lastEncoderOutputAt = Date.now();
		this.fatalEncoderError = null;
		let videoDescription: Uint8Array | undefined;

		this.encoder = new VideoEncoder({
			output: (chunk, meta) => {
				this.lastEncoderOutputAt = Date.now();

				if (meta?.decoderConfig?.description && !videoDescription) {
					const desc = meta.decoderConfig.description;
					if (desc instanceof ArrayBuffer || desc instanceof SharedArrayBuffer) {
						videoDescription = new Uint8Array(desc);
					} else if (ArrayBuffer.isView(desc)) {
						videoDescription = new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
					}
					this.videoDescription = videoDescription;
				}

				if (meta?.decoderConfig?.colorSpace && !this.videoColorSpace) {
					this.videoColorSpace = meta.decoderConfig.colorSpace;
				}

				const isFirstChunk = this.chunkCount === 0;
				this.chunkCount++;

				const muxingPromise = (async () => {
					try {
						if (isFirstChunk && this.videoDescription) {
							const colorSpace = this.videoColorSpace || {
								primaries: "bt709",
								transfer: "iec61966-2-1",
								matrix: "rgb",
								fullRange: true,
							};

							const metadata: EncodedVideoChunkMetadata = {
								decoderConfig: {
									codec: this.config.codec || "avc1.640033",
									codedWidth: this.config.width,
									codedHeight: this.config.height,
									description: this.videoDescription,
									colorSpace,
								},
							};

							await this.muxer!.addVideoChunk(chunk, metadata);
						} else {
							await this.muxer!.addVideoChunk(chunk, meta);
						}
					} catch (error) {
						console.error("Muxing error:", error);
					}
				})();

				this.muxingPromises.push(muxingPromise);
				this.encodeQueue = Math.max(0, this.encodeQueue - 1);
			},
			error: (error) => {
				console.error("[VideoExporter] Encoder error:", error);
				this.fatalEncoderError =
					error instanceof Error ? error : new Error(`Video encoder error: ${String(error)}`);
				for (const decoder of this.decoders) decoder.cancel();
			},
		});

		const encoderConfig: VideoEncoderConfig = {
			codec: this.config.codec || "avc1.640033",
			width: this.config.width,
			height: this.config.height,
			bitrate: this.config.bitrate,
			framerate: this.config.frameRate,
			latencyMode: "quality",
			bitrateMode: "variable",
			hardwareAcceleration,
		};

		const support = await VideoEncoder.isConfigSupported(encoderConfig);
		if (!support.supported) {
			throw new Error(
				hardwareAcceleration === "prefer-hardware"
					? "Hardware video encoding is not supported on this system."
					: "Software video encoding is not supported on this system.",
			);
		}

		console.log(
			`[VideoExporter] Using ${hardwareAcceleration === "prefer-hardware" ? "hardware" : "software"} acceleration`,
		);
		this.encoder.configure(encoderConfig);
	}

	cancel(): void {
		this.cancelled = true;
		for (const decoder of this.decoders) decoder.cancel();
		if (this.audioProcessor) {
			this.audioProcessor.cancel();
		}
		this.cleanup();
	}

	private cleanup(): void {
		if (this.encoder) {
			try {
				if (this.encoder.state === "configured") {
					this.encoder.close();
				}
			} catch (e) {
				console.warn("Error closing encoder:", e);
			}
			this.encoder = null;
		}

		for (const decoder of this.decoders) {
			try {
				decoder.destroy();
			} catch (e) {
				console.warn("Error destroying decoder:", e);
			}
		}
		this.decoders = [];

		if (this.renderer) {
			try {
				this.renderer.destroy();
			} catch (e) {
				console.warn("Error destroying renderer:", e);
			}
			this.renderer = null;
		}

		this.audioProcessor = null;
		this.muxer = null;
		this.encodeQueue = 0;
		this.muxingPromises = [];
		this.chunkCount = 0;
		this.videoDescription = undefined;
		this.videoColorSpace = undefined;
		this.lastEncoderOutputAt = 0;
		this.fatalEncoderError = null;
	}

	private getEncoderPreferences(): HardwareAcceleration[] {
		if (typeof navigator !== "undefined" && /\bWindows\b/i.test(navigator.userAgent)) {
			return ["prefer-software", "prefer-hardware"];
		}
		return ["prefer-hardware", "prefer-software"];
	}

	private async trySourceCopyFastPath(videoInfo: { width: number; height: number }) {
		const blockers = getSourceCopyFastPathBlockers(this.config, videoInfo);
		if (blockers.length > 0) {
			console.info("[VideoExporter] source-copy fast path disabled", {
				blockers,
				output: { width: this.config.width, height: this.config.height },
				source: videoInfo,
			});
			return null;
		}

		const sourceBlob = await this.loadSourceBlob();
		if (!sourceBlob || !isMp4Source(this.config.videoUrl, sourceBlob)) {
			console.info("[VideoExporter] source-copy fast path disabled", {
				blockers: ["source is not a readable MP4"],
				source: videoInfo,
			});
			return null;
		}

		if (this.cancelled) {
			return { success: false, error: "Export cancelled" };
		}

		this.reportProgress({
			currentFrame: 1,
			totalFrames: 1,
			percentage: 100,
			estimatedTimeRemaining: 0,
			phase: "finalizing",
		});
		console.info("[VideoExporter] using source-copy fast path", {
			source: videoInfo,
			bytes: sourceBlob.size,
		});

		return {
			success: true,
			blob: sourceBlob.type ? sourceBlob : new Blob([sourceBlob], { type: "video/mp4" }),
		} satisfies ExportResult;
	}

	private async loadSourceBlob() {
		const videoUrl = this.config.videoUrl;
		const isRemoteUrl = /^(https?:|blob:|data:)/i.test(videoUrl);

		if (!isRemoteUrl && window.electronAPI?.readBinaryFile) {
			const result = await window.electronAPI.readBinaryFile(videoUrl);
			if (!result.success || !result.data) {
				return null;
			}

			const type = videoUrl.toLowerCase().split(/[?#]/, 1)[0].endsWith(".mp4") ? "video/mp4" : "";
			return new Blob([result.data], type ? { type } : undefined);
		}

		const response = await fetch(videoUrl);
		if (!response.ok) {
			return null;
		}

		return response.blob();
	}

	private reportProgress(progress: ExportProgress): void {
		this.config.onProgress?.(progress);
	}

	private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
			promise.then(
				(value) => {
					window.clearTimeout(timer);
					resolve(value);
				},
				(error) => {
					window.clearTimeout(timer);
					reject(error);
				},
			);
		});
	}
}
