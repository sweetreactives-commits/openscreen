import { describe, expect, it, vi } from "vitest";

const cursorPoint = { x: 480, y: 270 };
vi.mock("electron", () => ({
	screen: {
		getCursorScreenPoint: () => cursorPoint,
		getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
	},
}));

const { createFallbackCursorRecordingSession } = await import("./factory");
const { hasNativeCursorRecordingData } = await import("../../../../src/lib/cursor/nativeCursor");

/**
 * Falling back when the platform's cursor helper will not start.
 *
 * A missing helper used to cost the take its cursor data outright, and with it
 * the zoom suggestions built on that data. The fallback samples positions
 * instead — but it must not also claim the recording has a native cursor, or
 * the editor would draw its own on top of the system one already in the picture.
 */

function options(platform: NodeJS.Platform) {
	return {
		getDisplayBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
		maxSamples: 1_000,
		platform,
		sampleIntervalMs: 33,
		sourceId: null,
	};
}

describe("createFallbackCursorRecordingSession", () => {
	it.each(["win32", "darwin"] as const)("offers a fallback on %s", (platform) => {
		expect(createFallbackCursorRecordingSession(options(platform))).not.toBeNull();
	});

	it("offers none on linux, where it is already the primary session", () => {
		expect(createFallbackCursorRecordingSession(options("linux"))).toBeNull();
	});

	it("records cursor positions the zoom suggestions can read", async () => {
		vi.useFakeTimers();
		try {
			const session = createFallbackCursorRecordingSession(options("win32"));
			expect(session).not.toBeNull();
			if (!session) return;

			await session.start();
			await vi.advanceTimersByTimeAsync(200);
			const data = await session.stop();

			expect(data.samples.length).toBeGreaterThan(1);
			expect(data.samples[0].cx).toBeCloseTo(0.25, 2);
			expect(data.samples[0].cy).toBeCloseTo(0.25, 2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not pass its samples off as a native cursor recording", async () => {
		vi.useFakeTimers();
		try {
			const session = createFallbackCursorRecordingSession(options("win32"));
			if (!session) return;

			await session.start();
			await vi.advanceTimersByTimeAsync(200);
			const data = await session.stop();

			expect(data.provider).toBe("sampled");
			// The gate the editor's cursor overlay is behind: two cursors if this slips.
			expect(hasNativeCursorRecordingData(data)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
