import {
	extractMono16kFromVideoUrl,
	type TranscribeMono16kResult,
	transcribeMono16kToSegments,
} from "@/lib/captioning";
import { UNTRUSTED_NOTICE } from "./untrusted";

/**
 * Transcription as a job an agent can poll, rather than a call it waits on.
 *
 * Whisper takes minutes on a long recording — far past any sensible request
 * timeout — so `requestTranscript` never blocks. It starts the work, returns the
 * current state, and the caller asks again. That keeps it working with any MCP
 * client, including ones that do not implement the Tasks extension.
 *
 * Timestamps come back on the source recording's clock, like everything else the
 * agent sees. Trim regions are deliberately not passed to the transcriber: they
 * would drop the words inside cuts, and an agent reasoning about what to remove
 * needs to see them.
 */

export interface TranscriptSegment {
	startMs: number;
	endMs: number;
	text: string;
}

export type TranscriptState =
	| { status: "running"; phase: "extracting" | "model" | "transcribing" }
	| {
			status: "ready";
			granularity: TranscribeMono16kResult["granularity"];
			/** True when the recording was longer than the transcriber's audio ceiling. */
			truncated: boolean;
			/** Marked untrusted: these are words captured from a microphone. */
			untrusted: true;
			notice: string;
			segments: TranscriptSegment[];
	  }
	| { status: "error"; message: string };

/** Seam for tests: the real pair touches an AudioContext and a Web Worker. */
export interface TranscriptDeps {
	extract: typeof extractMono16kFromVideoUrl;
	transcribe: typeof transcribeMono16kToSegments;
}

const defaultDeps: TranscriptDeps = {
	extract: extractMono16kFromVideoUrl,
	transcribe: transcribeMono16kToSegments,
};

type Job = { state: TranscriptState };

const jobs = new Map<string, Job>();

function toSegments(result: TranscribeMono16kResult): TranscriptSegment[] {
	return result.segments.map((segment) => ({
		startMs: Math.round(segment.startSec * 1000),
		endMs: Math.round(segment.endSec * 1000),
		text: segment.text,
	}));
}

async function run(videoUrl: string, job: Job, deps: TranscriptDeps): Promise<void> {
	try {
		job.state = { status: "running", phase: "extracting" };
		const { samples, truncated, durationSec } = await deps.extract(videoUrl);

		if (!Number.isFinite(durationSec) || durationSec <= 0 || samples.length < 800) {
			job.state = { status: "error", message: "This recording has no usable audio track." };
			return;
		}

		job.state = { status: "running", phase: "model" };
		const result = await deps.transcribe(samples, {
			onStatus: (phase) => {
				job.state = {
					status: "running",
					phase: phase === "model" ? "model" : "transcribing",
				};
			},
		});

		job.state = {
			status: "ready",
			granularity: result.granularity,
			truncated,
			untrusted: true,
			notice: UNTRUSTED_NOTICE,
			segments: toSegments(result),
		};
	} catch (error) {
		job.state = {
			status: "error",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Returns where transcription stands, starting it the first time it is asked.
 * Never waits for the result.
 *
 * A failed job stays failed until someone passes `restart`. Retrying on every
 * ask would mean the caller never sees the error — the question itself would
 * kick off a fresh attempt and answer "running" forever.
 *
 * `restart` on a *running* job is ignored: the old pipeline cannot be cancelled
 * mid-flight, so honouring it would stack a second full decode-and-Whisper run
 * beside the first — and each impatient poll could add another.
 */
export function requestTranscript(
	videoUrl: string,
	options: { restart?: boolean } = {},
	deps: TranscriptDeps = defaultDeps,
): TranscriptState {
	const existing = jobs.get(videoUrl);
	if (existing && (!options.restart || existing.state.status === "running")) {
		return existing.state;
	}

	const job: Job = { state: { status: "running", phase: "extracting" } };
	jobs.set(videoUrl, job);
	// `run` sets the phase itself; this is only the state seen before it starts.
	void run(videoUrl, job, deps);
	return job.state;
}

/** Drops cached jobs. Used by tests, and when a different recording is loaded. */
export function resetTranscripts(videoUrl?: string): void {
	if (videoUrl) jobs.delete(videoUrl);
	else jobs.clear();
}
