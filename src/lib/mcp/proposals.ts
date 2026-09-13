import { isProposedRegion } from "@/components/video-editor/types";
import type { EditorState } from "@/hooks/useEditorHistory";

/**
 * Accepting or discarding what an agent proposed.
 *
 * An agent's edits land on the timeline marked as proposals rather than applied
 * facts, so the user reviews them instead of discovering them. These build the
 * patch for the two bulk answers; both go through the editor's history, so
 * either is a single undo away.
 *
 * Anything the user has touched is already "manual" — dragging a proposal is
 * accepting it — so neither answer can take back their own work.
 */

const REGION_KEYS = [
	"zoomRegions",
	"trimRegions",
	"speedRegions",
	"annotationRegions",
] as const satisfies ReadonlyArray<keyof EditorState>;

type RegionKey = (typeof REGION_KEYS)[number];

export function countProposals(state: EditorState): number {
	return REGION_KEYS.reduce(
		(total, key) => total + state[key].filter((region) => isProposedRegion(region)).length,
		0,
	);
}

/** Keeps every proposal, marking it as the user's own. */
export function acceptProposals(state: EditorState): Partial<EditorState> {
	const patch: Partial<EditorState> = {};

	for (const key of REGION_KEYS) {
		const regions = state[key];
		if (!regions.some((region) => isProposedRegion(region))) continue;
		// Cast once per key: each list is homogeneous, but the union of four
		// element types defeats the inference on a shared helper.
		(patch as Record<RegionKey, unknown>)[key] = regions.map((region) =>
			isProposedRegion(region) ? { ...region, source: "manual" as const } : region,
		);
	}

	return patch;
}

/** Removes every proposal, leaving anything the user made or touched. */
export function discardProposals(state: EditorState): Partial<EditorState> {
	const patch: Partial<EditorState> = {};

	for (const key of REGION_KEYS) {
		const regions = state[key];
		if (!regions.some((region) => isProposedRegion(region))) continue;
		(patch as Record<RegionKey, unknown>)[key] = regions.filter(
			(region) => !isProposedRegion(region),
		);
	}

	return patch;
}
