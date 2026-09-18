import type { Rectangle } from "electron";
import { MacNativeCursorRecordingSession } from "./macNativeCursorRecordingSession";
import type { CursorRecordingSession } from "./session";
import { TelemetryRecordingSession } from "./telemetryRecordingSession";
import { WindowsNativeRecordingSession } from "./windowsNativeRecordingSession";

interface CreateCursorRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	platform: NodeJS.Platform;
	sampleIntervalMs: number;
	sourceId?: string | null;
	startTimeMs?: number;
}

export function createCursorRecordingSession(
	options: CreateCursorRecordingSessionOptions,
): CursorRecordingSession {
	if (options.platform === "win32") {
		return new WindowsNativeRecordingSession({
			getDisplayBounds: options.getDisplayBounds,
			maxSamples: options.maxSamples,
			sampleIntervalMs: options.sampleIntervalMs,
			sourceId: options.sourceId,
			startTimeMs: options.startTimeMs,
		});
	}

	if (options.platform === "darwin") {
		return new MacNativeCursorRecordingSession({
			getDisplayBounds: options.getDisplayBounds,
			maxSamples: options.maxSamples,
			sampleIntervalMs: options.sampleIntervalMs,
			startTimeMs: options.startTimeMs,
		});
	}

	// Linux: capture cursor positions via Electron's `screen` API on an interval.
	// No cursor sprites/assets and no clicks, just position telemetry.
	return new TelemetryRecordingSession({
		getDisplayBounds: options.getDisplayBounds,
		maxSamples: options.maxSamples,
		sampleIntervalMs: options.sampleIntervalMs,
		startTimeMs: options.startTimeMs,
	});
}

/**
 * The position-only session to fall back on when the platform helper will not start.
 *
 * A missing or unspawnable helper used to cost the recording its cursor data
 * outright, and with it every feature built on that data — zoom suggestions
 * first among them. Linux has always run on exactly this session, so the
 * fallback is a path that already works rather than a second implementation.
 *
 * Returns null on Linux, where this session is the primary one and retrying it
 * would only repeat the same failure.
 */
export function createFallbackCursorRecordingSession(
	options: CreateCursorRecordingSessionOptions,
): CursorRecordingSession | null {
	if (options.platform !== "win32" && options.platform !== "darwin") {
		return null;
	}

	return new TelemetryRecordingSession({
		getDisplayBounds: options.getDisplayBounds,
		maxSamples: options.maxSamples,
		sampleIntervalMs: options.sampleIntervalMs,
		startTimeMs: options.startTimeMs,
	});
}
