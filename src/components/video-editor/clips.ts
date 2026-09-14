import { SINGLE_CLIP_ID } from "@/lib/sequence";

/**
 * The project's clips as the editor holds them, and the operations on that list.
 *
 * Deliberately smaller than it could be. A card has no zooms, trims or speeds —
 * it is one still moment — so the editor never has to "open" a card the way it
 * opens a recording. That keeps the flat per-clip fields of `EditorState`
 * meaning what they have always meant: the edits on the recording. Nothing that
 * reads `trimRegions` or `zoomRegions` has to learn about clips.
 *
 * The day a project holds two *recordings*, that stops being enough and the
 * editor will need to check one out at a time. That is stage 6 of
 * docs/architecture/multiclip.md, not this.
 */

/** A card's text, its length, or the recording the project was built around. */
export interface ClipEntry {
	id: string;
	kind: "recording" | "card";
	/** Cards only: how long it stays on screen. */
	durationMs?: number;
	/** Cards only: the line shown on it. */
	title?: string;
}

/** A project that has never had a card added is still a sequence — of one. */
export const INITIAL_CLIPS: ClipEntry[] = [{ id: SINGLE_CLIP_ID, kind: "recording" }];

export function isCardEntry(clip: ClipEntry): boolean {
	return clip.kind === "card";
}

/** Where the recording sits in the list, or -1 if the project has none yet. */
export function recordingIndex(clips: readonly ClipEntry[]): number {
	return clips.findIndex((clip) => clip.kind === "recording");
}

/**
 * An id nothing else in the list is using.
 *
 * Ids only have to be unique within one project, and they end up in the saved
 * file, so a counter reads better there than a random string would.
 */
export function nextCardId(clips: readonly ClipEntry[]): string {
	const taken = new Set(clips.map((clip) => clip.id));
	for (let index = 1; ; index++) {
		const candidate = `card-${index}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** Adds a card at `index`, clamped into the list. */
export function addCard(
	clips: readonly ClipEntry[],
	index: number,
	card: Omit<ClipEntry, "id" | "kind"> = {},
): ClipEntry[] {
	const entry: ClipEntry = { id: nextCardId(clips), kind: "card", ...card };
	const at = Math.min(Math.max(Math.round(index), 0), clips.length);
	return [...clips.slice(0, at), entry, ...clips.slice(at)];
}

/** A card before everything else — the intro. */
export function addIntroCard(
	clips: readonly ClipEntry[],
	card?: Omit<ClipEntry, "id" | "kind">,
): ClipEntry[] {
	return addCard(clips, 0, card);
}

/** A card after everything else — the outro. */
export function addOutroCard(
	clips: readonly ClipEntry[],
	card?: Omit<ClipEntry, "id" | "kind">,
): ClipEntry[] {
	return addCard(clips, clips.length, card);
}

/**
 * Removes a card. The recording is never removed this way: losing it would
 * empty the project, which is what "New Project" is for.
 */
export function removeCard(clips: readonly ClipEntry[], id: string): ClipEntry[] {
	return clips.filter((clip) => !(clip.id === id && clip.kind === "card"));
}

/** Moves a clip to a new position, clamped into the list. */
export function moveClip(clips: readonly ClipEntry[], id: string, toIndex: number): ClipEntry[] {
	const from = clips.findIndex((clip) => clip.id === id);
	if (from === -1) return [...clips];

	const rest = [...clips.slice(0, from), ...clips.slice(from + 1)];
	const at = Math.min(Math.max(Math.round(toIndex), 0), rest.length);
	return [...rest.slice(0, at), clips[from], ...rest.slice(at)];
}

/** Changes one card, leaving every other clip identical. */
export function updateCard(
	clips: readonly ClipEntry[],
	id: string,
	patch: Partial<Omit<ClipEntry, "id" | "kind">>,
): ClipEntry[] {
	return clips.map((clip) =>
		clip.id === id && clip.kind === "card" ? { ...clip, ...patch } : clip,
	);
}
