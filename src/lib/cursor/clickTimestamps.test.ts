import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import type { CursorRecordingData } from "@/native/contracts";
import { clickTimestampsFrom, hasEditableCursorOverlay } from "./clickTimestamps";

const telemetry = (clicks: Array<[number, string | undefined]>): CursorTelemetryPoint[] =>
	clicks.map(
		([timeMs, interactionType]) => ({ timeMs, cx: 0.5, cy: 0.5, interactionType }) as never,
	);

const recording = (clicks: Array<[number, string]>): CursorRecordingData =>
	({ samples: clicks.map(([timeMs, interactionType]) => ({ timeMs, interactionType })) }) as never;

describe("clickTimestampsFrom", () => {
	it("prefers the native recording's clicks when it has some", () => {
		expect(clickTimestampsFrom(recording([[100, "click"]]), telemetry([[900, "click"]]))).toEqual([
			100,
		]);
	});

	it("falls back to telemetry when the recording has no clicks", () => {
		expect(clickTimestampsFrom(recording([[100, "move"]]), telemetry([[900, "click"]]))).toEqual([
			900,
		]);
		expect(clickTimestampsFrom(null, telemetry([[900, "double-click"]]))).toEqual([900]);
	});

	it("counts every kind of click and nothing that is not one", () => {
		expect(
			clickTimestampsFrom(
				null,
				telemetry([
					[1, "click"],
					[2, "right-click"],
					[3, "middle-click"],
					[4, "move"],
					[5, undefined],
				]),
			),
		).toEqual([1, 2, 3]);
	});
});

describe("hasEditableCursorOverlay", () => {
	// Real enough for the check: samples, and a cursor asset to draw them with.
	const data = { samples: [{ timeMs: 0 }], assets: [{ id: "arrow" }] } as never;

	it("draws our cursor only for an editable capture on a native platform", () => {
		expect(hasEditableCursorOverlay("editable-overlay", "win32", data)).toBe(true);
		expect(hasEditableCursorOverlay("editable-overlay", "darwin", data)).toBe(true);
	});

	it("never draws a second cursor over one already baked into the picture", () => {
		expect(hasEditableCursorOverlay("system", "win32", data)).toBe(false);
		expect(hasEditableCursorOverlay(undefined, "win32", data)).toBe(false);
	});

	it("has nothing to draw without native cursor data, or on Linux", () => {
		expect(hasEditableCursorOverlay("editable-overlay", "win32", null)).toBe(false);
		expect(hasEditableCursorOverlay("editable-overlay", "linux", data)).toBe(false);
	});
});
