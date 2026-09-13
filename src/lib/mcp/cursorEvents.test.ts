import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { summarizeCursorEvents } from "./cursorEvents";

const point = (
	timeMs: number,
	cx: number,
	cy: number,
	interactionType?: CursorTelemetryPoint["interactionType"],
): CursorTelemetryPoint => ({ timeMs, cx, cy, interactionType });

/** A cursor parked at one spot for `count` samples, 33 ms apart. */
function still(fromMs: number, count: number, cx = 0.5, cy = 0.5): CursorTelemetryPoint[] {
	return Array.from({ length: count }, (_, i) => point(fromMs + i * 33, cx, cy));
}

describe("summarizeCursorEvents", () => {
	it("returns an empty summary for no telemetry", () => {
		const summary = summarizeCursorEvents([]);
		expect(summary).toEqual({
			sampleCount: 0,
			clicks: [],
			clicksTruncated: false,
			idleSpans: [],
			totalIdleMs: 0,
		});
	});

	it("keeps every kind of click with its position", () => {
		const summary = summarizeCursorEvents([
			point(100, 0.25, 0.75, "click"),
			point(200, 0.3, 0.7, "double-click"),
			point(300, 0.4, 0.6, "right-click"),
			point(400, 0.5, 0.5, "middle-click"),
		]);

		expect(summary.clicks).toEqual([
			{ timeMs: 100, cx: 0.25, cy: 0.75, type: "click" },
			{ timeMs: 200, cx: 0.3, cy: 0.7, type: "double-click" },
			{ timeMs: 300, cx: 0.4, cy: 0.6, type: "right-click" },
			{ timeMs: 400, cx: 0.5, cy: 0.5, type: "middle-click" },
		]);
	});

	it("ignores moves and mouseups, which are not clicks", () => {
		const summary = summarizeCursorEvents([
			point(100, 0.1, 0.1, "move"),
			point(200, 0.2, 0.2, "mouseup"),
			point(300, 0.3, 0.3),
		]);
		expect(summary.clicks).toEqual([]);
	});

	it("reports a stretch where the cursor sat still", () => {
		const telemetry = [
			point(0, 0.1, 0.1),
			// Parked at the same spot for about three seconds.
			...still(33, 90, 0.5, 0.5),
			point(3_100, 0.9, 0.9),
		];

		const summary = summarizeCursorEvents(telemetry);
		expect(summary.idleSpans).toHaveLength(1);
		expect(summary.idleSpans[0].startMs).toBe(33);
		expect(summary.idleSpans[0].durationMs).toBeGreaterThan(2_900);
		expect(summary.totalIdleMs).toBe(summary.idleSpans[0].durationMs);
	});

	it("does not report brief pauses as idle", () => {
		const telemetry = [point(0, 0.1, 0.1), ...still(33, 10, 0.5, 0.5), point(400, 0.9, 0.9)];
		expect(summarizeCursorEvents(telemetry).idleSpans).toEqual([]);
	});

	it("closes a stretch that runs to the end of the recording", () => {
		const telemetry = [point(0, 0.1, 0.1), ...still(33, 120, 0.5, 0.5)];
		const summary = summarizeCursorEvents(telemetry);
		expect(summary.idleSpans).toHaveLength(1);
		expect(summary.idleSpans[0].endMs).toBe(33 + 119 * 33);
	});

	it("treats drift below the movement threshold as standing still", () => {
		const telemetry = [
			point(0, 0.5, 0.5),
			...Array.from({ length: 90 }, (_, i) => point(33 + i * 33, 0.5 + i * 0.0001, 0.5)),
			point(4_000, 0.9, 0.9),
		];
		expect(summarizeCursorEvents(telemetry).idleSpans).toHaveLength(1);
	});

	it("caps the click list and says so", () => {
		const telemetry = Array.from({ length: 20 }, (_, i) =>
			point(i * 100, 0.5, 0.5, "click" as const),
		);
		const summary = summarizeCursorEvents(telemetry, { maxClicks: 5 });
		expect(summary.clicks).toHaveLength(5);
		expect(summary.clicksTruncated).toBe(true);
	});

	it("does not claim truncation when the clicks exactly fill the cap", () => {
		const telemetry = Array.from({ length: 5 }, (_, i) =>
			point(i * 100, 0.5, 0.5, "click" as const),
		);
		const summary = summarizeCursorEvents(telemetry, { maxClicks: 5 });
		expect(summary.clicks).toHaveLength(5);
		// Every click is in the list; nothing was left out.
		expect(summary.clicksTruncated).toBe(false);
	});

	it("honours a custom idle threshold", () => {
		const telemetry = [point(0, 0.1, 0.1), ...still(33, 20, 0.5, 0.5), point(1_000, 0.9, 0.9)];
		expect(summarizeCursorEvents(telemetry, { minIdleMs: 5_000 }).idleSpans).toEqual([]);
		expect(summarizeCursorEvents(telemetry, { minIdleMs: 100 }).idleSpans).toHaveLength(1);
	});
});
