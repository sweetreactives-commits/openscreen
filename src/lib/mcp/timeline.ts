import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";

/**
 * Timeline arithmetic over trim and speed regions, in source-time milliseconds.
 *
 * This is the one implementation: the exporter's decoder delegates here, and the
 * MCP layer hands the result to agents so they never have to derive it themselves.
 * Getting it wrong is expensive in both directions — a wrong keep-segment list
 * either drops footage from the export or tells an agent the video is something
 * other than what it is.
 */

/** A span of the source that survives trimming, and the speed it plays back at. */
export interface KeepSegment {
	startMs: number;
	endMs: number;
	speed: number;
}

/** Sub-millisecond slivers are rounding noise, not segments. */
const MIN_SEGMENT_MS = 0.1;

/**
 * The spans of the source that survive trimming, in order.
 *
 * `TrimRegion`s are what gets **cut out** — the keep-segments are the gaps between
 * them. Trims may arrive unsorted, overlapping, nested, or reaching past the end of
 * the recording; all of those collapse correctly because the cursor only ever moves
 * forward.
 */
export function computeKeepSegments(
	totalMs: number,
	trimRegions?: readonly TrimRegion[],
): Array<{ startMs: number; endMs: number }> {
	if (!(totalMs > 0)) return [];
	if (!trimRegions || trimRegions.length === 0) {
		return [{ startMs: 0, endMs: totalMs }];
	}

	const sorted = [...trimRegions]
		.map((trim) => ({
			startMs: Math.max(0, Math.min(trim.startMs, trim.endMs)),
			endMs: Math.min(totalMs, Math.max(trim.startMs, trim.endMs)),
		}))
		.filter((trim) => trim.endMs > trim.startMs)
		.sort((a, b) => a.startMs - b.startMs);

	const segments: Array<{ startMs: number; endMs: number }> = [];
	let cursor = 0;

	for (const trim of sorted) {
		if (cursor < trim.startMs) {
			segments.push({ startMs: cursor, endMs: trim.startMs });
		}
		// max(), not assignment: a trim nested inside an earlier one would otherwise
		// drag the cursor backwards and resurrect footage the wider trim removed.
		cursor = Math.max(cursor, trim.endMs);
	}

	if (cursor < totalMs) {
		segments.push({ startMs: cursor, endMs: totalMs });
	}

	return segments.filter((segment) => segment.endMs - segment.startMs > MIN_SEGMENT_MS);
}

/**
 * Splits keep-segments wherever a speed region starts or ends, tagging each piece
 * with its playback multiplier. Segments no speed region touches play at 1×.
 */
export function splitBySpeed(
	segments: ReadonlyArray<{ startMs: number; endMs: number }>,
	speedRegions?: readonly SpeedRegion[],
): KeepSegment[] {
	if (!speedRegions || speedRegions.length === 0) {
		return segments.map((segment) => ({ ...segment, speed: 1 }));
	}

	const result: KeepSegment[] = [];

	for (const segment of segments) {
		const overlapping = speedRegions
			.filter((region) => region.startMs < segment.endMs && region.endMs > segment.startMs)
			.sort((a, b) => a.startMs - b.startMs);

		if (overlapping.length === 0) {
			result.push({ ...segment, speed: 1 });
			continue;
		}

		let cursor = segment.startMs;
		for (const region of overlapping) {
			const regionStart = Math.max(region.startMs, segment.startMs);
			const regionEnd = Math.min(region.endMs, segment.endMs);
			if (cursor < regionStart) {
				result.push({ startMs: cursor, endMs: regionStart, speed: 1 });
			}
			if (regionEnd > cursor) {
				result.push({
					startMs: Math.max(cursor, regionStart),
					endMs: regionEnd,
					speed: region.speed,
				});
				cursor = regionEnd;
			}
		}
		if (cursor < segment.endMs) {
			result.push({ startMs: cursor, endMs: segment.endMs, speed: 1 });
		}
	}

	return result.filter((segment) => segment.endMs - segment.startMs > MIN_SEGMENT_MS);
}

/** Keep-segments with speeds applied — the timeline as it will be exported. */
export function computeTimeline(
	totalMs: number,
	trimRegions?: readonly TrimRegion[],
	speedRegions?: readonly SpeedRegion[],
): KeepSegment[] {
	return splitBySpeed(computeKeepSegments(totalMs, trimRegions), speedRegions);
}

/** How long the exported video runs, once trims are cut and speeds applied. */
export function computeOutputDurationMs(
	totalMs: number,
	trimRegions?: readonly TrimRegion[],
	speedRegions?: readonly SpeedRegion[],
): number {
	return computeTimeline(totalMs, trimRegions, speedRegions).reduce(
		(sum, segment) => sum + (segment.endMs - segment.startMs) / segment.speed,
		0,
	);
}
