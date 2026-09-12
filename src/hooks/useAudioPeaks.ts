import { useEffect, useState } from "react";
import { loadFileAsArrayBuffer } from "@/lib/exporter/streamingDecoder";

let _audioCtx: AudioContext | null = null;
/** Returns the shared AudioContext, creating it lazily on first call. */
function getAudioCtx(): AudioContext {
	if (!_audioCtx) _audioCtx = new AudioContext();
	return _audioCtx;
}

/**
 * Offloads peak computation to a Web Worker (zero-copy via Transferable).
 * On abort, the worker is terminated and the promise rejects with AbortError.
 */
function computePeaksInWorker(
	audioBuffer: AudioBuffer,
	signal?: AbortSignal,
): Promise<Float32Array> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}

		const worker = new Worker(new URL("./audioPeaksWorker.ts", import.meta.url), {
			type: "module",
		});

		const onAbort = () => {
			worker.terminate();
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		// slice() creates an owned copy so the transfer is safe and the
		// AudioBuffer remains valid if anything else holds a reference.
		const channels: Float32Array[] = [];
		for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
			channels.push(audioBuffer.getChannelData(c).slice());
		}

		worker.onmessage = (e: MessageEvent<Float32Array>) => {
			signal?.removeEventListener("abort", onAbort);
			worker.terminate();
			resolve(e.data);
		};

		worker.onerror = (e) => {
			signal?.removeEventListener("abort", onAbort);
			worker.terminate();
			reject(e);
		};

		worker.postMessage(
			{ channels, duration: audioBuffer.duration },
			channels.map((ch) => ch.buffer),
		);
	});
}

// Module-scoped so the waveform and the MCP audio profile share one decode, and
// so it survives the timeline unmounting when the waveform is toggled off.
const peaksCache = new Map<string, Float32Array>();

/** Peaks already decoded for this source, without starting a decode. */
export function getCachedAudioPeaks(videoUrl?: string): Float32Array | null {
	return videoUrl ? (peaksCache.get(videoUrl) ?? null) : null;
}

/**
 * Decodes audio from `videoUrl` into paired [min, max] peaks (length = 2 * N
 * blocks), or `null` when there is no audio track or the format is unsupported.
 * Cached by URL; concurrent callers each decode at most once thanks to the cache
 * check, and a repeat call after the first is free.
 */
export async function decodeAudioPeaks(
	videoUrl: string,
	signal?: AbortSignal,
): Promise<Float32Array | null> {
	const cached = peaksCache.get(videoUrl);
	if (cached) return cached;

	try {
		const { data: arrayBuffer } = await loadFileAsArrayBuffer(videoUrl);
		const audioBuffer = await getAudioCtx().decodeAudioData(arrayBuffer);
		const peaks = await computePeaksInWorker(audioBuffer, signal);
		peaksCache.set(videoUrl, peaks);
		return peaks;
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") throw err;
		// No audio track or unsupported format: degrade quietly, but log so an
		// unexpectedly-missing waveform is diagnosable.
		console.warn("decodeAudioPeaks: could not decode audio:", err);
		return null;
	}
}

/**
 * Peaks for the waveform. `null` while decoding, and on no audio track or decode
 * failure. Shares the module-level cache with {@link decodeAudioPeaks}.
 */
export function useAudioPeaks(videoUrl?: string): Float32Array | null {
	const [peaks, setPeaks] = useState<Float32Array | null>(() => getCachedAudioPeaks(videoUrl));

	useEffect(() => {
		if (!videoUrl) {
			setPeaks(null);
			return;
		}

		const cached = peaksCache.get(videoUrl);
		if (cached) {
			setPeaks(cached);
			return;
		}

		setPeaks(null);
		let cancelled = false;
		const controller = new AbortController();

		decodeAudioPeaks(videoUrl, controller.signal)
			.then((result) => {
				if (!cancelled) setPeaks(result);
			})
			.catch(() => {
				// AbortError only: the effect cleaned up, so no state update needed.
			});

		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [videoUrl]);

	return peaks;
}
