import type { TrimRegion } from "@/components/video-editor/types";
import { buildAudioProfile } from "@/lib/mcp/audioProfile";

/**
 * Turning the dead air in a recording into cuts.
 *
 * The detection itself is already written — `buildAudioProfile` finds the quiet
 * stretches for the agent's `get_audio_profile`, from the same peaks the waveform
 * under the timeline is drawn from. What it does not do is decide what to cut,
 * and that is the part with the judgement in it: a threshold that suits this
 * recording rather than a fixed number, air left around the speech, and a refusal
 * where the honest answer is "nothing worth cutting".
 *
 * Every function here is pure and works in source-time milliseconds. See
 * docs/architecture/silence-removal.md.
 */

export interface SilenceTrimSettings {
	/** 0–100. Higher counts more of the quiet as a pause. */
	sensitivity: number;
	/** Quiet shorter than this is breathing between words, not dead air. */
	minPauseMs: number;
	/** Quiet left on each side of the speech, so a breath is not clipped off. */
	paddingMs: number;
}

export const DEFAULT_SILENCE_SENSITIVITY = 50;
export const DEFAULT_SILENCE_MIN_PAUSE_MS = 600;
export const DEFAULT_SILENCE_PADDING_MS = 150;

export const MIN_PAUSE_RANGE_MS = [200, 3000] as const;
export const PADDING_RANGE_MS = [0, 500] as const;

/**
 * Quiet is measured against this recording, not against a number.
 *
 * A fixed threshold breaks at both ends: a take recorded at low gain has speech
 * peaking around 0.05, where any absolute threshold sits on top of the speech,
 * and a noisy room has a floor above it, where nothing is ever quiet enough.
 */
const QUIET_FACTOR_RANGE = [0.02, 0.2] as const;
/** Below this the signal is silence however the sums come out. */
const MIN_THRESHOLD = 0.002;
/** Above this we would be cutting speech, whatever the reference says. */
const MAX_THRESHOLD = 0.3;

/** Raw stretches shorter than this are not pauses at any setting. */
const RAW_MIN_PAUSE_MS = 60;
/**
 * A burst shorter than this in the middle of a pause does not end it.
 *
 * A keystroke or a chair creak inside dead air would otherwise split one pause
 * into two shorter ones, each falling under the minimum. Kept well under the
 * length of the shortest spoken word, so real speech always ends a pause.
 */
const BRIDGE_MS = 60;
/** A cut shorter than this saves nothing and costs a join. */
const MIN_CUT_MS = 150;
/** A silence starting or ending within this of the edge is an edge. */
const EDGE_TOLERANCE_MS = 120;
/** Never leave less video than this, whatever the analysis says. */
const MIN_REMAINING_MS = 500;

/** One stretch to remove, in the recording's own time. */
export interface SilenceCut {
	startMs: number;
	endMs: number;
}

export type SilenceScan =
	| { ok: true; cuts: SilenceCut[]; removedMs: number }
	/** `no-audio`: nothing to measure. `nothing-found`: measured, nothing worth cutting. */
	| { ok: false; reason: "no-audio" | "nothing-found" | "all-quiet" };

function clamp(value: number, low: number, high: number): number {
	return Math.min(Math.max(value, low), high);
}

/** Peak amplitude per block, from the waveform's paired [min, max]. */
function blockAmplitudes(peaks: Float32Array): Float32Array {
	const blocks = Math.floor(peaks.length / 2);
	const amplitudes = new Float32Array(blocks);
	for (let i = 0; i < blocks; i++) {
		amplitudes[i] = Math.max(Math.abs(peaks[i * 2]), Math.abs(peaks[i * 2 + 1]));
	}
	return amplitudes;
}

/**
 * How loud this recording's speech runs.
 *
 * The 95th percentile, not the loudest block: one door slam or clipped plosive
 * would otherwise set the level for the whole take and push the threshold up
 * over the speech. A take that is almost entirely silent reports a low level,
 * which is right — the scan then finds nothing rather than offering to delete
 * the recording.
 */
export function speechLevel(peaks: Float32Array): number {
	const amplitudes = blockAmplitudes(peaks);
	if (amplitudes.length === 0) return 0;
	const sorted = Float32Array.from(amplitudes).sort();
	const index = clamp(Math.floor(sorted.length * 0.95), 0, sorted.length - 1);
	return sorted[index];
}

/** Amplitude at or below which a block counts as quiet, for this recording. */
export function silenceThreshold(peaks: Float32Array, sensitivity: number): number {
	const share = clamp(sensitivity, 0, 100) / 100;
	const factor = QUIET_FACTOR_RANGE[0] + share * (QUIET_FACTOR_RANGE[1] - QUIET_FACTOR_RANGE[0]);
	return clamp(speechLevel(peaks) * factor, MIN_THRESHOLD, MAX_THRESHOLD);
}

/** Joins pauses separated by a burst too short to be a spoken word. */
function bridgeBursts(spans: readonly SilenceCut[], bridgeMs: number): SilenceCut[] {
	const joined: SilenceCut[] = [];
	for (const span of spans) {
		const last = joined[joined.length - 1];
		if (last && span.startMs - last.endMs <= bridgeMs) {
			last.endMs = span.endMs;
			continue;
		}
		// Copied down to the two fields on purpose: the profile's spans carry a
		// duration as well, and joining two of them would leave it lying.
		joined.push({ startMs: span.startMs, endMs: span.endMs });
	}
	return joined;
}

/**
 * The cut a pause becomes.
 *
 * Air is left on both sides so the cut lands between words rather than on one.
 * Not at the edges of the recording, though: there is no speech outside them to
 * protect, and leaving a padded slice of silence at the very start is the dead
 * air the user asked to be rid of.
 */
function cutForPause(pause: SilenceCut, durationMs: number, paddingMs: number): SilenceCut {
	const atStart = pause.startMs <= EDGE_TOLERANCE_MS;
	const atEnd = pause.endMs >= durationMs - EDGE_TOLERANCE_MS;
	return {
		startMs: atStart ? 0 : Math.round(pause.startMs + paddingMs),
		endMs: atEnd ? Math.round(durationMs) : Math.round(pause.endMs - paddingMs),
	};
}

function overlaps(cut: SilenceCut, region: { startMs: number; endMs: number }): boolean {
	return cut.startMs < region.endMs && region.startMs < cut.endMs;
}

/**
 * Every stretch of this recording that nobody is speaking over.
 *
 * Unfiltered by length — what counts as long enough is the caller's question.
 * Shared with the timelapse pass, which asks the same thing of the audio and
 * differs only in what it does with the answer (see timelapse.ts).
 */
export function silentStretches(
	peaks: Float32Array,
	durationMs: number,
	sensitivity: number,
): SilenceCut[] {
	const profile = buildAudioProfile(peaks, durationMs, {
		silenceThreshold: silenceThreshold(peaks, sensitivity),
		minSilenceMs: RAW_MIN_PAUSE_MS,
	});
	return bridgeBursts(profile.silences, BRIDGE_MS);
}

/**
 * Every stretch of dead air worth removing from a recording.
 *
 * `existingTrims` are left strictly alone: a cut touching one is dropped rather
 * than trimmed around it. The user already dealt with that stretch, and a sliver
 * proposed beside their own cut is noise, not help.
 */
export function findSilenceCuts(
	peaks: Float32Array | null,
	durationMs: number,
	settings: SilenceTrimSettings,
	existingTrims: readonly TrimRegion[] = [],
): SilenceScan {
	if (!peaks || peaks.length < 2 || !(durationMs > 0)) return { ok: false, reason: "no-audio" };

	const paddingMs = clamp(settings.paddingMs, PADDING_RANGE_MS[0], PADDING_RANGE_MS[1]);
	const minPauseMs = clamp(settings.minPauseMs, MIN_PAUSE_RANGE_MS[0], MIN_PAUSE_RANGE_MS[1]);

	const cuts = silentStretches(peaks, durationMs, settings.sensitivity)
		.filter((pause) => pause.endMs - pause.startMs >= minPauseMs)
		.map((pause) => cutForPause(pause, durationMs, paddingMs))
		.filter((cut) => cut.endMs - cut.startMs >= MIN_CUT_MS)
		.filter((cut) => !existingTrims.some((region) => overlaps(cut, region)));

	if (cuts.length === 0) return { ok: false, reason: "nothing-found" };

	const removedMs = cuts.reduce((sum, cut) => sum + (cut.endMs - cut.startMs), 0);
	// A take with no speech in it at all reads as one long pause. Cutting it would
	// leave an empty project, which is never what the button was pressed for.
	const alreadyTrimmedMs = existingTrims.reduce(
		(sum, region) => sum + Math.max(0, region.endMs - region.startMs),
		0,
	);
	if (durationMs - alreadyTrimmedMs - removedMs < MIN_REMAINING_MS) {
		return { ok: false, reason: "all-quiet" };
	}

	return { ok: true, cuts, removedMs };
}
