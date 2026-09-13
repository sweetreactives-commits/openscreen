import { describe, expect, it } from "vitest";
import type { ZoomRegion } from "@/components/video-editor/types";
import { type EditorState, INITIAL_EDITOR_STATE } from "@/hooks/useEditorHistory";
import {
	applyCommands,
	type CommandFailure,
	type CommandSuccess,
	type EditorCommand,
} from "./editorCommands";

const DURATION = 10_000;

function run(commands: EditorCommand[], state: EditorState = INITIAL_EDITOR_STATE) {
	return applyCommands(state, commands, DURATION);
}

const ok = (outcome: ReturnType<typeof run>) => {
	expect(outcome.ok, `expected success, got: ${(outcome as CommandFailure).message}`).toBe(true);
	return outcome as CommandSuccess;
};

const failed = (outcome: ReturnType<typeof run>) => {
	expect(outcome.ok).toBe(false);
	return outcome as CommandFailure;
};

describe("applyCommands", () => {
	it("refuses to edit when no recording is loaded", () => {
		const outcome = applyCommands(INITIAL_EDITOR_STATE, [{ op: "set_cursor", size: 2 }], 0);
		expect(failed(outcome).code).toBe("no-project");
	});

	it("refuses an empty command list", () => {
		expect(failed(run([])).code).toBe("invalid-value");
	});

	describe("zooms", () => {
		it("adds a zoom marked as the agent's, so the magic wand leaves it alone", () => {
			const result = ok(run([{ op: "add_zoom", startMs: 1_000, endMs: 2_000, scale: 2 }]));
			const zooms = result.patch.zoomRegions as ZoomRegion[];

			expect(zooms).toHaveLength(1);
			expect(zooms[0].source).toBe("agent");
			expect(zooms[0].customScale).toBe(2);
			expect(result.createdIds).toEqual([zooms[0].id]);
		});

		it("hands out an id the editor's own counter cannot collide with", () => {
			const result = ok(run([{ op: "add_zoom", startMs: 0, endMs: 1_000 }]));
			const id = (result.patch.zoomRegions as ZoomRegion[])[0].id;
			// deriveNextId only counts `zoom-<digits>`, so this is invisible to it.
			expect(id).toMatch(/^zoom-[0-9a-f]{8}$/);
			expect(id).not.toMatch(/^zoom-\d+$/);
		});

		it("clamps an absurd scale rather than rejecting it", () => {
			const result = ok(run([{ op: "add_zoom", startMs: 0, endMs: 1_000, scale: 99 }]));
			expect((result.patch.zoomRegions as ZoomRegion[])[0].customScale).toBe(5);
		});

		it("clamps focus into the frame", () => {
			const result = ok(
				run([{ op: "add_zoom", startMs: 0, endMs: 1_000, focus: { cx: 3, cy: -1 } }]),
			);
			expect((result.patch.zoomRegions as ZoomRegion[])[0].focus).toEqual({ cx: 1, cy: 0 });
		});

		it("follows the cursor when asked", () => {
			const result = ok(run([{ op: "add_zoom", startMs: 0, endMs: 1_000, followCursor: true }]));
			expect((result.patch.zoomRegions as ZoomRegion[])[0].focusMode).toBe("auto");
		});

		it("updates an existing zoom by id", () => {
			const added = ok(run([{ op: "add_zoom", startMs: 0, endMs: 1_000 }]));
			const state = { ...INITIAL_EDITOR_STATE, ...added.patch };
			const id = added.createdIds[0];

			const updated = ok(run([{ op: "update_zoom", id, scale: 3, endMs: 2_000 }], state));
			const zoom = (updated.patch.zoomRegions as ZoomRegion[])[0];
			expect(zoom.customScale).toBe(3);
			expect(zoom.endMs).toBe(2_000);
		});

		it("reports an unknown id rather than silently doing nothing", () => {
			const outcome = failed(run([{ op: "update_zoom", id: "zoom-nope", scale: 2 }]));
			expect(outcome.code).toBe("unknown-id");
			expect(outcome.message).toContain("zoom-nope");
		});
	});

	describe("spans", () => {
		it("rejects a span that ends before it starts", () => {
			const outcome = failed(run([{ op: "add_zoom", startMs: 5_000, endMs: 1_000 }]));
			expect(outcome.code).toBe("invalid-range");
			expect(outcome.message).toContain("before its start");
		});

		it("rejects a zero-length span", () => {
			expect(failed(run([{ op: "add_zoom", startMs: 1_000, endMs: 1_000 }])).code).toBe(
				"invalid-range",
			);
		});

		it("rejects a span past the end of the recording", () => {
			const outcome = failed(run([{ op: "remove_range", startMs: 9_000, endMs: 99_000 }]));
			expect(outcome.code).toBe("invalid-range");
			expect(outcome.message).toContain("outside the recording");
		});

		it("rejects a negative start", () => {
			expect(failed(run([{ op: "remove_range", startMs: -500, endMs: 1_000 }])).code).toBe(
				"invalid-range",
			);
		});

		it("rejects missing or non-numeric bounds", () => {
			const outcome = failed(
				run([{ op: "add_zoom", startMs: Number.NaN, endMs: 1_000 } as EditorCommand]),
			);
			expect(outcome.code).toBe("invalid-range");
		});
	});

	describe("trims and speed", () => {
		it("adds a removed range as a trim region, marked as the agent's proposal", () => {
			const result = ok(run([{ op: "remove_range", startMs: 2_000, endMs: 4_000 }]));
			expect(result.patch.trimRegions).toEqual([
				{ id: result.createdIds[0], startMs: 2_000, endMs: 4_000, source: "agent" },
			]);
		});

		it("marks a speed change as a proposal too", () => {
			const result = ok(run([{ op: "set_speed", startMs: 0, endMs: 1_000, speed: 2 }]));
			expect(result.patch.speedRegions?.[0].source).toBe("agent");
		});

		it("clamps speed to what the editor supports", () => {
			const result = ok(run([{ op: "set_speed", startMs: 0, endMs: 1_000, speed: 999 }]));
			expect(result.patch.speedRegions?.[0].speed).toBe(16);
		});

		it("rejects a speed of zero", () => {
			expect(failed(run([{ op: "set_speed", startMs: 0, endMs: 1_000, speed: 0 }])).code).toBe(
				"invalid-value",
			);
		});
	});

	describe("text annotations", () => {
		it("adds text with the editor's defaults", () => {
			const result = ok(run([{ op: "add_text", startMs: 0, endMs: 2_000, text: "Click Export" }]));
			const annotation = result.patch.annotationRegions?.[0];
			expect(annotation?.type).toBe("text");
			expect(annotation?.textContent).toBe("Click Export");
			expect(annotation?.zIndex).toBe(1);
			expect(annotation?.source).toBe("agent");
		});

		it("stacks each new annotation above the last", () => {
			const first = ok(run([{ op: "add_text", startMs: 0, endMs: 1_000, text: "one" }]));
			const state = { ...INITIAL_EDITOR_STATE, ...first.patch };
			const second = ok(run([{ op: "add_text", startMs: 0, endMs: 1_000, text: "two" }], state));
			expect(second.patch.annotationRegions?.[1].zIndex).toBe(2);
		});

		it("refuses empty text", () => {
			expect(failed(run([{ op: "add_text", startMs: 0, endMs: 1_000, text: "   " }])).code).toBe(
				"invalid-value",
			);
		});

		it("edits the text of an existing annotation", () => {
			const added = ok(run([{ op: "add_text", startMs: 0, endMs: 1_000, text: "before" }]));
			const state = { ...INITIAL_EDITOR_STATE, ...added.patch };
			const updated = ok(
				run([{ op: "update_text", id: added.createdIds[0], text: "after" }], state),
			);
			expect(updated.patch.annotationRegions?.[0].textContent).toBe("after");
			// An edit aimed at one region accepts it; it is no longer a proposal.
			expect(updated.patch.annotationRegions?.[0].source).toBe("manual");
		});
	});

	describe("remove_region", () => {
		it("removes whichever kind of region carries the id", () => {
			const added = ok(
				run([
					{ op: "add_zoom", startMs: 0, endMs: 1_000 },
					{ op: "remove_range", startMs: 2_000, endMs: 3_000 },
				]),
			);
			const state = { ...INITIAL_EDITOR_STATE, ...added.patch };
			const [zoomId, trimId] = added.createdIds;

			const withoutZoom = ok(run([{ op: "remove_region", id: zoomId }], state));
			expect(withoutZoom.patch.zoomRegions).toEqual([]);
			expect(withoutZoom.patch.trimRegions).toBeUndefined();

			const withoutTrim = ok(run([{ op: "remove_region", id: trimId }], state));
			expect(withoutTrim.patch.trimRegions).toEqual([]);
		});

		it("reports an id that belongs to nothing", () => {
			expect(failed(run([{ op: "remove_region", id: "ghost" }])).code).toBe("unknown-id");
		});
	});

	describe("appearance", () => {
		it("clamps layout values into range", () => {
			// Start from a non-default radius so clamping to 0 is a real change and
			// therefore shows up in the patch.
			const state = { ...INITIAL_EDITOR_STATE, borderRadius: 40 };
			const result = ok(run([{ op: "set_layout", padding: 500, borderRadius: -20 }], state));
			expect(result.patch.padding).toBe(100);
			expect(result.patch.borderRadius).toBe(0);
		});

		it("leaves a field out of the patch when the value did not actually change", () => {
			const state = { ...INITIAL_EDITOR_STATE, padding: 50 };
			const result = ok(run([{ op: "set_layout", padding: 50 }], state));
			expect(result.patch).toEqual({});
		});

		it("sets cursor look, which lives in the document since project version 3", () => {
			const result = ok(run([{ op: "set_cursor", size: 99, visible: false }]));
			expect(result.patch.cursorSize).toBe(10);
			expect(result.patch.showCursor).toBe(false);
		});

		it("rejects a non-numeric cursor size", () => {
			expect(failed(run([{ op: "set_cursor", size: "big" as unknown as number }])).code).toBe(
				"invalid-value",
			);
		});
	});

	describe("webcam", () => {
		it("sets layout, shape and size", () => {
			// Start away from the defaults so each change is real and lands in the patch.
			const state = { ...INITIAL_EDITOR_STATE, webcamLayoutPreset: "no-webcam" as const };
			const result = ok(
				run(
					[{ op: "set_webcam", layout: "picture-in-picture", shape: "circle", sizePercent: 30 }],
					state,
				),
			);
			expect(result.patch.webcamLayoutPreset).toBe("picture-in-picture");
			expect(result.patch.webcamMaskShape).toBe("circle");
			expect(result.patch.webcamSizePreset).toBe(30);
		});

		it("clamps the size to what the panel allows", () => {
			expect(ok(run([{ op: "set_webcam", sizePercent: 90 }])).patch.webcamSizePreset).toBe(50);
			expect(ok(run([{ op: "set_webcam", sizePercent: 1 }])).patch.webcamSizePreset).toBe(10);
		});

		it("rejects a layout the editor does not have", () => {
			const outcome = failed(
				run([{ op: "set_webcam", layout: "floating" as unknown as "no-webcam" }]),
			);
			expect(outcome.code).toBe("invalid-value");
		});

		it("refuses dual-frame on a portrait project, which the loader would undo anyway", () => {
			const portrait = { ...INITIAL_EDITOR_STATE, aspectRatio: "9:16" as const };
			const outcome = failed(run([{ op: "set_webcam", layout: "dual-frame" }], portrait));
			expect(outcome.message).toContain("portrait");
		});

		it("clears the position when the layout is not picture-in-picture", () => {
			const state = {
				...INITIAL_EDITOR_STATE,
				webcamLayoutPreset: "picture-in-picture" as const,
				webcamPosition: { cx: 0.2, cy: 0.8 },
			};
			const result = ok(run([{ op: "set_webcam", layout: "vertical-stack" }], state));
			expect(result.patch.webcamPosition).toBeNull();
		});

		it("clamps a position into the frame", () => {
			const result = ok(
				run([{ op: "set_webcam", layout: "picture-in-picture", position: { cx: 5, cy: -2 } }]),
			);
			expect(result.patch.webcamPosition).toEqual({ cx: 1, cy: 0 });
		});
	});

	describe("image annotations", () => {
		it("adds an image once the renderer has encoded it", () => {
			const result = ok(
				run([
					{
						op: "add_image",
						startMs: 0,
						endMs: 1_000,
						dataUrl: "data:image/png;base64,QUFB",
					},
				]),
			);
			const annotation = result.patch.annotationRegions?.[0];
			expect(annotation?.type).toBe("image");
			expect(annotation?.imageContent).toBe("data:image/png;base64,QUFB");
		});

		it("puts the image where the preview and the exporter look for it", () => {
			// Both read `content`; writing only `imageContent` leaves the annotation on
			// the timeline and invisible in the video.
			const result = ok(
				run([{ op: "add_image", startMs: 0, endMs: 1_000, dataUrl: "data:image/png;base64,QUFB" }]),
			);
			expect(result.patch.annotationRegions?.[0].content).toBe("data:image/png;base64,QUFB");
		});

		it("refuses anything that is not an image", () => {
			const outcome = failed(
				run([{ op: "add_image", startMs: 0, endMs: 1_000, dataUrl: "https://example.com/a.png" }]),
			);
			expect(outcome.code).toBe("invalid-value");
		});
	});

	describe("blur regions", () => {
		it("hides part of the frame with a mosaic by default", () => {
			const result = ok(run([{ op: "add_blur", startMs: 0, endMs: 1_000 }]));
			const annotation = result.patch.annotationRegions?.[0];

			expect(annotation?.type).toBe("blur");
			expect(annotation?.blurData?.type).toBe("mosaic");
			expect(annotation?.blurData?.shape).toBe("rectangle");
			expect(annotation?.source).toBe("agent");
		});

		it("takes a gaussian blur and an oval when asked", () => {
			const result = ok(
				run([{ op: "add_blur", startMs: 0, endMs: 1_000, style: "blur", shape: "oval" }]),
			);
			expect(result.patch.annotationRegions?.[0].blurData?.type).toBe("blur");
			expect(result.patch.annotationRegions?.[0].blurData?.shape).toBe("oval");
		});

		it("maps one strength dial onto both of the editor's ranges", () => {
			const weak = ok(run([{ op: "add_blur", startMs: 0, endMs: 1_000, strength: 1 }]));
			const strong = ok(run([{ op: "add_blur", startMs: 0, endMs: 1_000, strength: 100 }]));

			expect(weak.patch.annotationRegions?.[0].blurData?.intensity).toBe(2);
			expect(weak.patch.annotationRegions?.[0].blurData?.blockSize).toBe(4);
			expect(strong.patch.annotationRegions?.[0].blurData?.intensity).toBe(40);
			expect(strong.patch.annotationRegions?.[0].blurData?.blockSize).toBe(48);
		});

		it("clamps a strength outside the dial", () => {
			const result = ok(run([{ op: "add_blur", startMs: 0, endMs: 1_000, strength: 900 }]));
			expect(result.patch.annotationRegions?.[0].blurData?.intensity).toBe(40);
		});

		it("rejects a span outside the recording", () => {
			expect(failed(run([{ op: "add_blur", startMs: 0, endMs: 99_000 }])).code).toBe(
				"invalid-range",
			);
		});
	});

	describe("batches", () => {
		it("applies several commands as one patch", () => {
			const result = ok(
				run([
					{ op: "add_zoom", startMs: 0, endMs: 1_000 },
					{ op: "add_zoom", startMs: 2_000, endMs: 3_000 },
					{ op: "remove_range", startMs: 5_000, endMs: 6_000 },
					{ op: "set_cursor", size: 4 },
				]),
			);

			expect(result.patch.zoomRegions).toHaveLength(2);
			expect(result.patch.trimRegions).toHaveLength(1);
			expect(result.patch.cursorSize).toBe(4);
			expect(result.createdIds).toHaveLength(3);
		});

		it("abandons the whole batch when one command is bad", () => {
			const outcome = failed(
				run([
					{ op: "add_zoom", startMs: 0, endMs: 1_000 },
					{ op: "add_zoom", startMs: 8_000, endMs: 2_000 },
				]),
			);
			expect(outcome.code).toBe("invalid-range");
			// Names the offending command so the caller can fix that one.
			expect(outcome.message).toContain("Command 2 (add_zoom)");
		});

		it("touches only the fields the commands changed", () => {
			const result = ok(run([{ op: "set_cursor", size: 4 }]));
			expect(Object.keys(result.patch)).toEqual(["cursorSize"]);
		});
	});
});
