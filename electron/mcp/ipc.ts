import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { CLAIM_PENDING_START, claimPendingRecordingStart } from "./recording";
import { getMcpServerInfo, startMcpServer, stopMcpServer } from "./server";
import { loadMcpSettings, type McpMode, saveMcpSettings } from "./settings";

/**
 * Turning the endpoint on and off from the UI, and reporting what a client
 * needs to connect.
 */

export interface McpStatus {
	mode: McpMode;
	allowRecording: boolean;
	running: boolean;
	url: string | null;
	/** Only while running; it is regenerated on every start. */
	token: string | null;
	error: string | null;
}

let resolveEditorWindow: (() => BrowserWindow | null) | null = null;
let currentMode: McpMode = "off";
let recordingAllowed = false;
let lastError: string | null = null;

/** What the endpoint is currently allowed to do, read by the tool factory. */
export function currentMcpMode(): McpMode {
	return currentMode;
}

/** Whether the user has separately allowed an agent to start a recording. */
export function isRecordingAllowed(): boolean {
	return currentMode !== "off" && recordingAllowed;
}

function status(): McpStatus {
	const info = getMcpServerInfo();
	return {
		mode: currentMode,
		allowRecording: recordingAllowed,
		running: info !== null,
		url: info?.url ?? null,
		token: info?.token ?? null,
		error: lastError,
	};
}

/**
 * Brings the endpoint in line with `mode`, starting or stopping it as needed.
 * A failure to start is reported rather than thrown: the app must keep working
 * when the port is unavailable.
 */
export async function applyMcpMode(mode: McpMode): Promise<McpStatus> {
	currentMode = mode;
	lastError = null;

	try {
		if (mode === "off") {
			await stopMcpServer();
		} else if (resolveEditorWindow) {
			await startMcpServer(resolveEditorWindow);
		}
	} catch (error) {
		lastError = error instanceof Error ? error.message : String(error);
		console.error("[mcp] could not apply mode", mode, error);
	}

	return status();
}

/**
 * Registers the settings IPC and starts the endpoint if the stored mode says so.
 * `OPENSCREEN_MCP=1` forces read-only on without touching the saved setting, and
 * `OPENSCREEN_MCP=full` also allows editing. That is how the e2e suite and a dev
 * run switch it on.
 */
export async function registerMcpIpc(getEditorWindow: () => BrowserWindow | null): Promise<void> {
	resolveEditorWindow = getEditorWindow;

	ipcMain.handle("mcp:get-status", () => status());
	ipcMain.handle(CLAIM_PENDING_START, () => claimPendingRecordingStart());

	ipcMain.handle("mcp:set-mode", async (_event, mode: McpMode) => {
		const next: McpMode = mode === "read-only" || mode === "full" ? mode : "off";
		await saveMcpSettings({ mode: next, allowRecording: recordingAllowed });
		return applyMcpMode(next);
	});

	ipcMain.handle("mcp:set-allow-recording", async (_event, allowed: boolean) => {
		recordingAllowed = allowed === true;
		await saveMcpSettings({ mode: currentMode, allowRecording: recordingAllowed });
		return status();
	});

	const stored = await loadMcpSettings();
	recordingAllowed = stored.allowRecording;
	const forced = process.env["OPENSCREEN_MCP"];
	const mode: McpMode = forced === "full" ? "full" : forced === "1" ? "read-only" : stored.mode;
	await applyMcpMode(mode);
}
