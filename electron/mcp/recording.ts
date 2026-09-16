import type { BrowserWindow } from "electron";
import { dialog } from "electron";
import { isRecordingAllowed } from "./ipc";

/**
 * Starting and stopping a capture on an agent's word.
 *
 * This is the most dangerous thing the endpoint can do — everything else reads
 * or edits a recording the user already chose to make, while this points a
 * camera at whatever is on their screen right now. So it is guarded three ways,
 * and none of them are the agent's to skip:
 *
 *   1. A consent the user gives separately from editing, off by default.
 *   2. A modal dialog on every single start. There is no "remember this",
 *      no parameter that bypasses it, and no rate at which it stops appearing.
 *   3. A refusal while the editor holds unsaved work, because starting a
 *      recording closes the editor window and would take that work with it.
 *
 * Stopping needs none of this: ending a recording can only ever be what the
 * user would want, and it reuses the same path the tray's stop button takes.
 */

export const START_RECORDING_CHANNEL = "start-recording-from-agent";
export const STOP_RECORDING_CHANNEL = "stop-recording-from-tray";
/** The recorder asks this on mount, to catch a start it was created too late to hear. */
export const CLAIM_PENDING_START = "mcp:claim-pending-recording-start";

/**
 * An approved start that may have arrived before the recorder could listen.
 *
 * Switching to the recorder destroys the editor and builds a fresh window, whose
 * renderer registers its listener only once it has loaded. Sending into that gap
 * drops the message: the user approves, the agent is told yes, and nothing
 * happens. So the approval is also left here, and the recorder claims it when it
 * comes up.
 */
let pendingStartAt: number | null = null;

/** Long enough to cover a window load, short enough not to fire into a later session. */
const PENDING_START_TTL_MS = 30_000;

/** Returns true once for a start approved in the last few seconds. */
export function claimPendingRecordingStart(): boolean {
	if (pendingStartAt === null) return false;
	const fresh = Date.now() - pendingStartAt < PENDING_START_TTL_MS;
	pendingStartAt = null;
	return fresh;
}

export type RecordingRefusal =
	| "not-allowed"
	| "declined"
	| "park-failed"
	| "already-recording"
	| "not-recording"
	| "no-window";

export interface RecordingOutcome {
	ok: boolean;
	refusal?: RecordingRefusal;
	message?: string;
}

export const REFUSAL_MESSAGES: Record<RecordingRefusal, string> = {
	"not-allowed":
		"The user has not allowed agents to start recordings. They can turn that on in " +
		"OpenScreen's AI agent access settings; it is a separate switch from editing.",
	declined: "The user declined the recording.",
	"park-failed":
		"The open project could not be put aside, and starting a recording closes the " +
		"editor, so nothing was started. The user's work is untouched.",
	"already-recording": "A recording is already in progress.",
	"not-recording": "Nothing is recording.",
	"no-window": "OpenScreen has no window to record from.",
};

function refuse(refusal: RecordingRefusal): RecordingOutcome {
	return { ok: false, refusal, message: REFUSAL_MESSAGES[refusal] };
}

export interface RecordingDeps {
	/** The window that hosts the recorder UI. */
	getMainWindow: () => BrowserWindow | null;
	/**
	 * Puts the open project aside so it survives the editor window, and says
	 * whether it worked. Nothing switches away from work that is still loose.
	 */
	parkProject: () => Promise<boolean>;
	/** True while a capture is already running. */
	isRecording: () => boolean;
	/** Brings the recorder UI up, closing the editor. */
	switchToRecorder: () => void;
	/** Asks the user. Injected so a test can answer without a real dialog. */
	confirm?: (window: BrowserWindow) => Promise<boolean>;
}

/**
 * The approval prompt.
 *
 * Modal to the window and worded plainly: the point is that a person reads
 * "something is asking to record your screen" and decides, not that they click
 * through a dialog they have learned to ignore.
 */
async function askTheUser(window: BrowserWindow): Promise<boolean> {
	const { response } = await dialog.showMessageBox(window, {
		type: "warning",
		buttons: ["Cancel", "Start recording"],
		defaultId: 0,
		cancelId: 0,
		title: "Start recording?",
		message: "An AI agent is asking to record your screen.",
		detail:
			"It will capture whatever is on the screen you pick, including anything private " +
			"that happens to be open. Only continue if you are expecting this.",
		noLink: true,
	});

	return response === 1;
}

export async function startRecordingForAgent(deps: RecordingDeps): Promise<RecordingOutcome> {
	if (!isRecordingAllowed()) return refuse("not-allowed");
	if (deps.isRecording()) return refuse("already-recording");

	const window = deps.getMainWindow();
	if (!window || window.isDestroyed()) return refuse("no-window");

	const approved = await (deps.confirm ?? askTheUser)(window);
	if (!approved) return refuse("declined");

	// Re-check: the dialog is modal but the world can still move while it is open.
	if (deps.isRecording()) return refuse("already-recording");

	// Ordered, not optional: the switch below destroys the editor window, so the
	// project has to be somewhere else first.
	if (!(await deps.parkProject())) return refuse("park-failed");

	// Left for the recorder to claim, in case it is created after this point and
	// misses the event below.
	pendingStartAt = Date.now();
	deps.switchToRecorder();

	// The recorder window replaces the editor, so the message goes to whatever is
	// current once the swap has happened. It reaches a recorder that was already
	// up; a freshly built one claims the pending start instead.
	const recorder = deps.getMainWindow();
	if (!recorder || recorder.isDestroyed()) return refuse("no-window");

	recorder.webContents.send(START_RECORDING_CHANNEL);
	return { ok: true };
}

export function stopRecordingForAgent(deps: Pick<RecordingDeps, "getMainWindow" | "isRecording">) {
	if (!deps.isRecording()) return refuse("not-recording");

	const window = deps.getMainWindow();
	if (!window || window.isDestroyed()) return refuse("no-window");

	window.webContents.send(STOP_RECORDING_CHANNEL);
	return { ok: true };
}

let configured: RecordingDeps | null = null;

/** Hands the module the app's windows and state; called once at startup. */
export function configureMcpRecording(deps: RecordingDeps): void {
	configured = deps;
}

export async function startRecordingForAgentConfigured(): Promise<RecordingOutcome> {
	if (!configured) return refuse("no-window");
	return startRecordingForAgent(configured);
}

export function stopRecordingForAgentConfigured(): RecordingOutcome {
	if (!configured) return refuse("no-window");
	return stopRecordingForAgent(configured);
}
