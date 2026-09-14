import { describe, expect, it } from "vitest";
import {
	addCard,
	addIntroCard,
	addOutroCard,
	type ClipEntry,
	INITIAL_CLIPS,
	moveClip,
	nextCardId,
	recordingIndex,
	removeCard,
	updateCard,
} from "./clips";

const recording: ClipEntry = { id: "clip-1", kind: "recording" };
const ids = (clips: readonly ClipEntry[]) => clips.map((clip) => clip.id);

describe("clip list", () => {
	it("starts as a sequence of one: the recording", () => {
		expect(INITIAL_CLIPS).toHaveLength(1);
		expect(INITIAL_CLIPS[0].kind).toBe("recording");
		expect(recordingIndex(INITIAL_CLIPS)).toBe(0);
	});

	it("puts an intro before the recording and an outro after it", () => {
		const withIntro = addIntroCard([recording], { title: "Hello" });
		const both = addOutroCard(withIntro, { title: "Thanks" });

		expect(both.map((clip) => clip.kind)).toEqual(["card", "recording", "card"]);
		expect(both[0].title).toBe("Hello");
		expect(both[2].title).toBe("Thanks");
		expect(recordingIndex(both)).toBe(1);
	});

	it("never reuses an id, even after a card in the middle is removed", () => {
		const three = addOutroCard(addOutroCard(addIntroCard([recording]), {}), {});
		expect(ids(three)).toEqual(["card-1", "clip-1", "card-2", "card-3"]);

		const pruned = removeCard(three, "card-2");
		// card-2 is free again, and taking it back is fine: nothing else holds it.
		expect(nextCardId(pruned)).toBe("card-2");
		expect(ids(pruned)).toEqual(["card-1", "clip-1", "card-3"]);
	});

	it("clamps an out-of-range insertion instead of leaving a hole", () => {
		expect(ids(addCard([recording], -5))).toEqual(["card-1", "clip-1"]);
		expect(ids(addCard([recording], 99))).toEqual(["clip-1", "card-1"]);
	});

	it("refuses to remove the recording, which would empty the project", () => {
		expect(removeCard([recording], "clip-1")).toEqual([recording]);
	});

	it("reorders clips, and moving one past the end lands it last", () => {
		const clips = addOutroCard(addIntroCard([recording]), {});
		expect(ids(clips)).toEqual(["card-1", "clip-1", "card-2"]);

		expect(ids(moveClip(clips, "card-2", 0))).toEqual(["card-2", "card-1", "clip-1"]);
		expect(ids(moveClip(clips, "card-1", 99))).toEqual(["clip-1", "card-2", "card-1"]);
		// The recording moves like anything else.
		expect(ids(moveClip(clips, "clip-1", 0))).toEqual(["clip-1", "card-1", "card-2"]);
	});

	it("leaves the list alone when asked to move something that is not there", () => {
		expect(moveClip([recording], "ghost", 0)).toEqual([recording]);
	});

	it("edits one card without touching its neighbours", () => {
		const clips = addOutroCard(addIntroCard([recording], { title: "Hello" }), { title: "Bye" });
		const edited = updateCard(clips, "card-1", { durationMs: 5_000 });

		expect(edited[0]).toEqual({ id: "card-1", kind: "card", title: "Hello", durationMs: 5_000 });
		expect(edited[1]).toBe(clips[1]);
		expect(edited[2]).toBe(clips[2]);
	});

	it("will not turn the recording into a card by editing it", () => {
		const edited = updateCard([recording], "clip-1", { title: "nope", durationMs: 1_000 });
		expect(edited[0]).toEqual(recording);
	});

	it("never mutates the list it was given", () => {
		const clips = [recording];
		addIntroCard(clips);
		moveClip(clips, "clip-1", 1);
		removeCard(clips, "clip-1");
		expect(clips).toEqual([recording]);
	});
});
