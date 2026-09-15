import GIF from "gif.js";
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
import {
	type ExportCard,
	type ExportRecording,
	type ExportSequenceClip,
	resolveExportSequence,
} from "./exportSequence";
import { type FrameClipContext, FrameRenderer } from "./frameRenderer";
import { StreamingVideoDecoder } from "./streamingDecoder";
import { TimestampedVideoFrameQueue } from "./timestampedVideoFrameQueue";
import type {
	ExportProgress,
	ExportResult,
	GIF_SIZE_PRESETS,
	GifFrameRate,
	GifSizePreset,
} from "./types";

const GIF_WORKER_URL = new URL("gif.js/dist/gif.worker.js", import.meta.url).toString();

interface GifExporterConfig {
	videoUrl: string;
	/** Card clips flanking the recording, already split by the caller. */
	cards?: { before: ExportCard[]; after: ExportCard[] };
	/** Everything to render, in order; replaces the single-recording fields when present. */
	sequence?: ExportSequenceClip[];
	webcamVideoUrl?: string;
	width: number;
	height: number;
	frameRate: GifFrameRate;
	loop: boolean;
	sizePreset: GifSizePreset;
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

/**
 * Calculate output dimensions based on size preset and source dimensions while preserving aspect ratio.
 * @param sourceWidth - Original video width
 * @param sourceHeight - Original video height
 * @param sizePreset - The size preset to use
 * @param sizePresets - The size presets configuration
 * @returns The calculated output dimensions
 */
export function calculateOutputDimensions(
	sourceWidth: number,
	sourceHeight: number,
	sizePreset: GifSizePreset,
	sizePresets: typeof GIF_SIZE_PRESETS,
	targetAspectRatio = sourceWidth / sourceHeight,
): { width: number; height: number } {
	const preset = sizePresets[sizePreset];
	const maxHeight = preset.maxHeight;
	const aspectRatio =
		Number.isFinite(targetAspectRatio) && targetAspectRatio > 0
			? targetAspectRatio
			: sourceWidth / sourceHeight;

	const toEven = (value: number) => {
		const evenValue = Math.max(2, Math.floor(value / 2) * 2);
		return evenValue;
	};

	if (sizePreset === "original") {
		const sourceAspect = sourceWidth / sourceHeight;
		if (aspectRatio >= sourceAspect) {
			const width = toEven(sourceWidth);
			const height = toEven(width / aspectRatio);
			return { width, height };
		}

		const height = toEven(sourceHeight);
		const width = toEven(height * aspectRatio);
		return { width, height };
	}

	const targetHeight = maxHeight;
	const targetWidth = Math.round(targetHeight * aspectRatio);

	return {
		width: toEven(targetWidth),
		height: toEven(targetHeight),
	};
}

export class GifExporter {
	private config: GifExporterConfig;
	/** Every decoder this export opened, so cancelling stops all of them. */
	private decoders: StreamingVideoDecoder[] = [];
	private renderer: FrameRenderer | null = null;
	private gif: GIF | null = null;
	private cancelled = false;

	constructor(config: GifExporterConfig) {
		this.config = config;
	}

	async export(): Promise<ExportResult> {
		const warnings: string[] = [];
		const onWarning = (message: string) => warnings.push(message);

		try {
			const platform = await getPlatform();

			this.cleanup();
			this.cancelled = false;

			const sequence = resolveExportSequence(this.config);
			const frameRate = this.config.frameRate;

			// Phase 1: open every recording, so the frame budget is known up front.
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

			// gif.js repeat: 0 = infinite loop, 1 = play once
			const repeat = this.config.loop ? 0 : 1;
			const cores = navigator.hardwareConcurrency || 4;
			const WORKER_COUNT = Math.max(1, Math.min(8, cores - 1));
			const gif = new GIF({
				workers: WORKER_COUNT,
				quality: 10,
				width: this.config.width,
				height: this.config.height,
				workerScript: GIF_WORKER_URL,
				repeat,
				background: "#000000",
				transparent: null,
				dither: "FloydSteinberg",
			});
			this.gif = gif;

			// Progress counts every clip, cards included, or it would climb past 100%.
			const totalFrames = sequence.reduce(
				(sum, clip) =>
					sum +
					(clip.kind === "card"
						? cardFrameCount(clip.card.durationMs, frameRate)
						: (loaded.get(clip)?.frames ?? 0)),
				0,
			);

			let frameIndex = 0;
			// gif.js wants frame delay in ms
			const frameDelay = Math.round(1000 / frameRate);

			const addFrame = (canvas: HTMLCanvasElement) => {
				gif.addFrame(canvas, { delay: frameDelay, copy: true });
				frameIndex++;
				this.config.onProgress?.({
					currentFrame: frameIndex,
					totalFrames,
					percentage: (frameIndex / totalFrames) * 100,
					estimatedTimeRemaining: 0,
				});
			};

			/** Draws a card once and adds those pixels for as long as it lasts. */
			const emitCard = (card: ExportCard) => {
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
					addFrame(cardCanvas);
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
									throw error;
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
					// Stream decode and process frames, no seeking
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

								webcamFrame = webcamQueue ? await webcamQueue.frameAt(sourceTimestampMs) : null;
								if (this.cancelled) {
									return;
								}

								await renderer.renderFrame(videoFrame, sourceTimestampMs * 1000, webcamFrame);
								addFrame(renderer.getCanvas());
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

			console.log("[GifExporter] Clips:", sequence.length, "recordings:", recordings.length);
			console.log("[GifExporter] Total frames to export:", totalFrames);
			console.log("[GifExporter] Frame rate:", frameRate, "FPS, delay", frameDelay, "ms");
			console.log("[GifExporter] Loop:", this.config.loop ? "infinite" : "once");

			// Phase 2: render the sequence in order.
			for (const clip of sequence) {
				if (this.cancelled) break;
				if (clip.kind === "card") {
					emitCard(clip.card);
				} else {
					const entry = loaded.get(clip);
					if (entry) await renderRecording(entry);
				}
			}

			if (this.cancelled) {
				return { success: false, error: "Export cancelled" };
			}

			// Now in the finalizing phase
			this.config.onProgress?.({
				currentFrame: totalFrames,
				totalFrames,
				percentage: 100,
				estimatedTimeRemaining: 0,
				phase: "finalizing",
			});

			const blob = await new Promise<Blob>((resolve, _reject) => {
				gif.on("finished", (blob: Blob) => {
					resolve(blob);
				});

				gif.on("progress", (progress: number) => {
					this.config.onProgress?.({
						currentFrame: totalFrames,
						totalFrames,
						percentage: 100,
						estimatedTimeRemaining: 0,
						phase: "finalizing",
						renderProgress: Math.round(progress * 100),
					});
				});

				// gif.js has no typed 'error' event; the outer try/catch handles failures
				gif.render();
			});

			return { success: true, blob, warnings: warnings.length > 0 ? warnings : undefined };
		} catch (error) {
			if (error instanceof BackgroundLoadError) {
				throw error;
			}
			console.error("GIF Export error:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			this.cleanup();
		}
	}

	cancel(): void {
		this.cancelled = true;
		for (const decoder of this.decoders) decoder.cancel();
		if (this.gif) {
			this.gif.abort();
		}
		this.cleanup();
	}

	private cleanup(): void {
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

		if (this.gif) {
			terminateGifWorkers(this.gif);
		}
		this.gif = null;
	}
}

/**
 * Ends every worker gif.js started.
 *
 * gif.js returns workers to a free pool when a frame is done and never terminates
 * that pool — abort() only ends the busy ones, and there is no API for the rest.
 * Each GIF export therefore left up to eight idle worker threads alive for the life
 * of the page: an editor session that exported a handful of GIFs carried dozens.
 */
function terminateGifWorkers(gif: GIF): void {
	const pool = gif as unknown as { freeWorkers?: Worker[]; activeWorkers?: Worker[] };
	for (const worker of [...(pool.freeWorkers ?? []), ...(pool.activeWorkers ?? [])]) {
		worker.terminate();
	}
	if (pool.freeWorkers) pool.freeWorkers.length = 0;
	if (pool.activeWorkers) pool.activeWorkers.length = 0;
}
