import { describe, expect, it } from "vitest";
import {
	DEFAULT_ANNOTATION_POSITION,
	DEFAULT_ANNOTATION_SIZE,
	DEFAULT_ANNOTATION_STYLE,
	type RegionSource,
} from "@/components/video-editor/types";
import { type EditorState, INITIAL_EDITOR_STATE } from "@/hooks/useEditorHistory";
import { acceptProposals, countProposals, discardProposals } from "./proposals";

const zoom = (id: string, source?: RegionSource) => ({
	id,
	startMs: 0,
	endMs: 1_000,
	depth: 3 as const,
	focus: { cx: 0.5, cy: 0.5 },
	source,
});

const trim = (id: string, source?: RegionSource) => ({ id, startMs: 0, endMs: 500, source });

const speed = (id: string, source?: RegionSource) => ({
	id,
	startMs: 0,
	endMs: 500,
	speed: 2,
	source,
});

const annotation = (id: string, source?: RegionSource) => ({
	id,
	startMs: 0,
	endMs: 500,
	type: "text" as const,
	content: "hi",
	position: DEFAULT_ANNOTATION_POSITION,
	size: DEFAULT_ANNOTATION_SIZE,
	style: DEFAULT_ANNOTATION_STYLE,
	zIndex: 1,
	source,
});

function state(overrides: Partial<EditorState> = {}): EditorState {
	return { ...INITIAL_EDITOR_STATE, ...overrides };
}

describe("countProposals", () => {
	it("is zero for an untouched project", () => {
		expect(countProposals(INITIAL_EDITOR_STATE)).toBe(0);
	});

	it("counts proposals across every kind of region", () => {
		const current = state({
			zoomRegions: [zoom("z1", "agent"), zoom("z2", "manual")],
			trimRegions: [trim("t1", "agent")],
			speedRegions: [speed("s1", "agent")],
			annotationRegions: [annotation("a1", "agent"), annotation("a2")],
		});
		expect(countProposals(current)).toBe(4);
	});

	it("does not count the magic wand's own suggestions", () => {
		// Those have their own lifecycle: the wand toggle removes them.
		expect(countProposals(state({ zoomRegions: [zoom("z1", "auto")] }))).toBe(0);
	});

	it("does not count regions with no recorded origin", () => {
		expect(countProposals(state({ zoomRegions: [zoom("z1")] }))).toBe(0);
	});
});

describe("acceptProposals", () => {
	it("marks every proposal as the user's own", () => {
		const current = state({
			zoomRegions: [zoom("z1", "agent")],
			trimRegions: [trim("t1", "agent")],
		});
		const patch = acceptProposals(current);

		expect(patch.zoomRegions?.[0].source).toBe("manual");
		expect(patch.trimRegions?.[0].source).toBe("manual");
		expect(countProposals({ ...current, ...patch })).toBe(0);
	});

	it("leaves the wand's suggestions and the user's own regions alone", () => {
		const current = state({
			zoomRegions: [zoom("wand", "auto"), zoom("mine", "manual"), zoom("theirs", "agent")],
		});
		const patch = acceptProposals(current);

		expect(patch.zoomRegions?.map((region) => region.source)).toEqual(["auto", "manual", "manual"]);
	});

	it("touches only the kinds that had proposals", () => {
		const patch = acceptProposals(state({ trimRegions: [trim("t1", "agent")] }));
		expect(Object.keys(patch)).toEqual(["trimRegions"]);
	});

	it("returns an empty patch when there is nothing to accept", () => {
		expect(acceptProposals(INITIAL_EDITOR_STATE)).toEqual({});
	});
});

describe("discardProposals", () => {
	it("removes every proposal", () => {
		const current = state({
			zoomRegions: [zoom("z1", "agent")],
			annotationRegions: [annotation("a1", "agent")],
		});
		const patch = discardProposals(current);

		expect(patch.zoomRegions).toEqual([]);
		expect(patch.annotationRegions).toEqual([]);
	});

	it("keeps anything the user made or already accepted", () => {
		const current = state({
			zoomRegions: [zoom("wand", "auto"), zoom("mine", "manual"), zoom("theirs", "agent")],
		});
		expect(discardProposals(current).zoomRegions?.map((region) => region.id)).toEqual([
			"wand",
			"mine",
		]);
	});

	it("touches only the kinds that had proposals", () => {
		const patch = discardProposals(state({ speedRegions: [speed("s1", "agent")] }));
		expect(Object.keys(patch)).toEqual(["speedRegions"]);
	});

	it("returns an empty patch when there is nothing to discard", () => {
		expect(discardProposals(INITIAL_EDITOR_STATE)).toEqual({});
	});
});
