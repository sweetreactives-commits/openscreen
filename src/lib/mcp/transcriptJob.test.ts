import { afterEach, describe, expect, it, vi } from "vitest";
import {
	requestTranscript,
	resetTranscripts,
	type TranscriptDeps,
	type TranscriptState,
} from "./transcriptJob";

afterEach(() => resetTranscripts());

/** Lets a test decide exactly when each stage of the job finishes. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const audio = (sampleCount = 16_000, durationSec = 2) => ({
	samples: new Float32Array(sampleCount),
	truncated: false,
	durationSec,
});

const segments = (granularity: "word" | "phrase" = "word") => ({
	granularity,
	segments: [
		{ startSec: 0.5, endSec: 1.25, text: "hello" },
		{ startSec: 1.25, endSec: 2, text: "there" },
	],
});

/** Drains queued promise callbacks; a job awaits several times before settling. */
async function settle(turns = 4) {
	for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("requestTranscript", () => {
	it("starts the job and returns immediately rather than waiting", async () => {
		const extraction = deferred<ReturnType<typeof audio>>();
		const deps: TranscriptDeps = {
			extract: vi.fn(() => extraction.promise) as TranscriptDeps["extract"],
			transcribe: vi.fn() as TranscriptDeps["transcribe"],
		};

		expect(requestTranscript("file:///a.webm", {}, deps)).toEqual({
			status: "running",
			phase: "extracting",
		});
		expect(deps.extract).toHaveBeenCalledWith("file:///a.webm");
		// Extraction has not resolved, so the caller was never blocked on it.
		expect(deps.transcribe).not.toHaveBeenCalled();
	});

	it("reports each stage while the job runs", async () => {
		const extraction = deferred<ReturnType<typeof audio>>();
		const transcription = deferred<ReturnType<typeof segments>>();
		let reportStatus: ((phase: "model" | "transcribe") => void) | undefined;

		const deps: TranscriptDeps = {
			extract: (() => extraction.promise) as TranscriptDeps["extract"],
			transcribe: ((_samples: Float32Array, options?: { onStatus?: typeof reportStatus }) => {
				reportStatus = options?.onStatus;
				return transcription.promise;
			}) as unknown as TranscriptDeps["transcribe"],
		};

		requestTranscript("file:///a.webm", {}, deps);
		await settle();
		expect(requestTranscript("file:///a.webm", {}, deps)).toEqual({
			status: "running",
			phase: "extracting",
		});

		extraction.resolve(audio());
		await settle();
		expect(requestTranscript("file:///a.webm", {}, deps)).toEqual({
			status: "running",
			phase: "model",
		});

		reportStatus?.("transcribe");
		expect(requestTranscript("file:///a.webm", {}, deps)).toEqual({
			status: "running",
			phase: "transcribing",
		});
	});

	it("returns segments in source-time milliseconds once done", async () => {
		const deps: TranscriptDeps = {
			extract: (async () => audio()) as TranscriptDeps["extract"],
			transcribe: (async () => segments()) as unknown as TranscriptDeps["transcribe"],
		};

		requestTranscript("file:///a.webm", {}, deps);
		await settle();
		await settle();

		const state = requestTranscript("file:///a.webm", {}, deps) as Extract<
			TranscriptState,
			{ status: "ready" }
		>;
		expect(state.status).toBe("ready");
		expect(state.granularity).toBe("word");
		expect(state.segments).toEqual([
			{ startMs: 500, endMs: 1_250, text: "hello" },
			{ startMs: 1_250, endMs: 2_000, text: "there" },
		]);
	});

	it("does not transcribe twice for the same recording", async () => {
		const transcribe = vi.fn(async () => segments());
		const deps: TranscriptDeps = {
			extract: (async () => audio()) as TranscriptDeps["extract"],
			transcribe: transcribe as unknown as TranscriptDeps["transcribe"],
		};

		requestTranscript("file:///a.webm", {}, deps);
		await settle();
		await settle();
		requestTranscript("file:///a.webm", {}, deps);
		requestTranscript("file:///a.webm", {}, deps);
		await settle();

		expect(transcribe).toHaveBeenCalledTimes(1);
	});

	it("reports a recording with no usable audio instead of transcribing silence", async () => {
		const transcribe = vi.fn();
		const deps: TranscriptDeps = {
			extract: (async () => ({
				samples: new Float32Array(10),
				truncated: false,
				durationSec: 0,
			})) as TranscriptDeps["extract"],
			transcribe: transcribe as unknown as TranscriptDeps["transcribe"],
		};

		requestTranscript("file:///silent.webm", {}, deps);
		await settle();

		const state = requestTranscript("file:///silent.webm", {}, deps);
		expect(state.status).toBe("error");
		expect(transcribe).not.toHaveBeenCalled();
	});

	it("surfaces a failure and retries only when asked to", async () => {
		const extract = vi
			.fn()
			.mockRejectedValueOnce(new Error("decoder exploded"))
			.mockResolvedValue(audio());
		const deps: TranscriptDeps = {
			extract: extract as TranscriptDeps["extract"],
			transcribe: (async () => segments()) as unknown as TranscriptDeps["transcribe"],
		};

		requestTranscript("file:///a.webm", {}, deps);
		await settle();

		// Asking again reports the failure rather than quietly retrying.
		expect(requestTranscript("file:///a.webm", {}, deps)).toEqual({
			status: "error",
			message: "decoder exploded",
		});
		expect(extract).toHaveBeenCalledTimes(1);

		// Only an explicit restart tries again.
		expect(requestTranscript("file:///a.webm", { restart: true }, deps).status).toBe("running");
		expect(extract).toHaveBeenCalledTimes(2);
	});

	it("keeps a separate job per recording", async () => {
		const deps: TranscriptDeps = {
			extract: (async () => audio()) as TranscriptDeps["extract"],
			transcribe: (async () => segments("phrase")) as unknown as TranscriptDeps["transcribe"],
		};

		requestTranscript("file:///a.webm", {}, deps);
		await settle();
		await settle();

		expect(requestTranscript("file:///a.webm", {}, deps).status).toBe("ready");
		expect(requestTranscript("file:///b.webm", {}, deps).status).toBe("running");
	});

	it("passes the truncation flag through, so a long recording says so", async () => {
		const deps: TranscriptDeps = {
			extract: (async () => ({ ...audio(), truncated: true })) as TranscriptDeps["extract"],
			transcribe: (async () => segments()) as unknown as TranscriptDeps["transcribe"],
		};

		requestTranscript("file:///long.webm", {}, deps);
		await settle();
		await settle();

		const state = requestTranscript("file:///long.webm", {}, deps) as Extract<
			TranscriptState,
			{ status: "ready" }
		>;
		expect(state.truncated).toBe(true);
	});
});
