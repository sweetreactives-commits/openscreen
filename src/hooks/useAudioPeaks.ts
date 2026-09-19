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
 * Deliberately not abortable: the decode is shared between callers, so one
 * caller walking away must not tear the worker out from under the others.
 */
function computePeaksInWorker(audioBuffer: AudioBuffer): Promise<Float32Array> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./audioPeaksWorker.ts", import.meta.url), {
			type: "module",
		});

		// slice() creates an owned copy so the transfer is safe and the
		// AudioBuffer remains valid if anything else holds a reference.
		const channels: Float32Array[] = [];
		for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
			channels.push(audioBuffer.getChannelData(c).slice());
		}

		worker.onmessage = (e: MessageEvent<Float32Array>) => {
			worker.terminate();
			resolve(e.data);
		};

		worker.onerror = (e) => {
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

// Decodes still under way, so a second caller joins the first rather than
// loading and decoding the same file beside it.
const peaksInFlight = new Map<string, Promise<Float32Array | null>>();

/** Peaks already decoded for this source, without starting a decode. */
export function getCachedAudioPeaks(videoUrl?: string): Float32Array | null {
	return videoUrl ? (peaksCache.get(videoUrl) ?? null) : null;
}

/** Rejects with AbortError on abort, leaving `work` itself to run on. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/** The shared decode itself. Never rejects: failure to decode means no peaks. */
async function decodeAndCache(videoUrl: string): Promise<Float32Array | null> {
	try {
		const { data: arrayBuffer } = await loadFileAsArrayBuffer(videoUrl);
		const audioBuffer = await getAudioCtx().decodeAudioData(arrayBuffer);
		const peaks = await computePeaksInWorker(audioBuffer);
		peaksCache.set(videoUrl, peaks);
		return peaks;
	} catch (err) {
		// No audio track or unsupported format: degrade quietly, but log so an
		// unexpectedly-missing waveform is diagnosable.
		console.warn("decodeAudioPeaks: could not decode audio:", err);
		return null;
	}
}

/**
 * Decodes audio from `videoUrl` into paired [min, max] peaks (length = 2 * N
 * blocks), or `null` when there is no audio track or the format is unsupported.
 * Cached by URL, and concurrent callers share one in-flight decode. An abort
 * detaches only the caller that aborted — the decode runs to completion for
 * whoever else is waiting, and lands in the cache either way.
 */
export async function decodeAudioPeaks(
	videoUrl: string,
	signal?: AbortSignal,
): Promise<Float32Array | null> {
	const cached = peaksCache.get(videoUrl);
	if (cached) return cached;

	let inFlight = peaksInFlight.get(videoUrl);
	if (!inFlight) {
		inFlight = decodeAndCache(videoUrl).finally(() => peaksInFlight.delete(videoUrl));
		peaksInFlight.set(videoUrl, inFlight);
	}

	return signal ? raceAbort(inFlight, signal) : inFlight;
}

/**
 * What the waveform knows about this recording's sound.
 *
 * `null` peaks meant two different things — still decoding, and there is no
 * audio to decode — which left anything downstream unable to tell a slow answer
 * from a final one, and so unable to say why a waveform never appeared.
 */
export type AudioPeaksStatus = "idle" | "loading" | "ready" | "no-audio";

export interface AudioPeaksResult {
	peaks: Float32Array | null;
	status: AudioPeaksStatus;
}

/**
 * Peaks for the waveform, with the state of the attempt beside them. Shares the
 * module-level cache with {@link decodeAudioPeaks}.
 */
export function useAudioPeaks(videoUrl?: string): AudioPeaksResult {
	const [result, setResult] = useState<AudioPeaksResult>(() => {
		const cached = getCachedAudioPeaks(videoUrl);
		if (!videoUrl) return { peaks: null, status: "idle" };
		return cached ? { peaks: cached, status: "ready" } : { peaks: null, status: "loading" };
	});

	useEffect(() => {
		if (!videoUrl) {
			setResult({ peaks: null, status: "idle" });
			return;
		}

		const cached = peaksCache.get(videoUrl);
		if (cached) {
			setResult({ peaks: cached, status: "ready" });
			return;
		}

		setResult({ peaks: null, status: "loading" });
		let cancelled = false;
		const controller = new AbortController();

		decodeAudioPeaks(videoUrl, controller.signal)
			.then((peaks) => {
				if (cancelled) return;
				setResult(peaks ? { peaks, status: "ready" } : { peaks: null, status: "no-audio" });
			})
			.catch(() => {
				// AbortError only: the effect cleaned up, so no state update needed.
			});

		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [videoUrl]);

	return result;
}
