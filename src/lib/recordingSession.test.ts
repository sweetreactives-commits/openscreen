import { describe, expect, it } from "vitest";
import { normalizeProjectMedia, normalizeRecordingSession } from "./recordingSession";

/**
 * What a take remembers about its own pointer.
 *
 * `cursorCaptureMode` records what was asked for and `systemCursorInVideo` what
 * happened, and the two disagree whenever a platform helper was missing and the
 * recording fell to the browser pipeline. The editor reads the second one to
 * decide whether drawing a cursor of its own would show a second pointer, so it
 * has to survive a round trip through the project file — and be absent, rather
 * than guessed at, on takes made before it was tracked.
 */

const SCREEN = "/recordings/take.webm";

describe("normalizeProjectMedia", () => {
	it("keeps what actually happened to the pointer", () => {
		expect(
			normalizeProjectMedia({
				screenVideoPath: SCREEN,
				cursorCaptureMode: "editable-overlay",
				systemCursorInVideo: true,
			}),
		).toEqual({
			screenVideoPath: SCREEN,
			cursorCaptureMode: "editable-overlay",
			systemCursorInVideo: true,
		});
	});

	it("carries false through rather than dropping it as falsy", () => {
		const media = normalizeProjectMedia({
			screenVideoPath: SCREEN,
			systemCursorInVideo: false,
		});

		expect(media?.systemCursorInVideo).toBe(false);
	});

	it("leaves it absent on a take that never recorded it", () => {
		const media = normalizeProjectMedia({ screenVideoPath: SCREEN });

		expect(media).not.toHaveProperty("systemCursorInVideo");
	});

	it("ignores a value that is not a boolean", () => {
		const media = normalizeProjectMedia({
			screenVideoPath: SCREEN,
			systemCursorInVideo: "yes",
		});

		expect(media).not.toHaveProperty("systemCursorInVideo");
	});

	it("still refuses media with no screen recording behind it", () => {
		expect(normalizeProjectMedia({ systemCursorInVideo: true })).toBeNull();
	});
});

describe("normalizeRecordingSession", () => {
	it("carries the flag alongside the rest of the session", () => {
		const session = normalizeRecordingSession({
			screenVideoPath: SCREEN,
			createdAt: 1_700_000_000_000,
			systemCursorInVideo: true,
		});

		expect(session?.systemCursorInVideo).toBe(true);
		expect(session?.createdAt).toBe(1_700_000_000_000);
	});
});
