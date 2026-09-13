/**
 * Contract for the main -> renderer command channel behind the MCP endpoint.
 *
 * The endpoint runs in the main process; the editor's state lives in the
 * renderer. Ordinary IPC here runs the wrong way — `ipcMain.handle` answers the
 * renderer, and this needs main to ask. So requests carry a correlation id and
 * replies come back on a second channel, matched by that id.
 *
 * Shared by both sides, like `src/native/contracts.ts`, so the shapes cannot
 * drift apart across the process boundary.
 */

export const MCP_COMMAND_CHANNEL = "mcp:command";
export const MCP_RESULT_CHANNEL = "mcp:command-result";
export const MCP_CONTRACT_VERSION = 1;

export type McpCommand =
	| "get_project"
	| "get_cursor_events"
	| "get_audio_profile"
	| "get_frame"
	| "get_transcript"
	| "apply_commands"
	| "export_video"
	| "export_walkthrough";

export interface McpCommandRequest {
	id: string;
	version: number;
	command: McpCommand;
	args?: Record<string, unknown>;
}

export type McpErrorCode =
	/** No editor window — the app is in recorder mode, so there is no project state. */
	| "editor-not-open"
	/** The renderer never answered. */
	| "timeout"
	/** The renderer does not implement this command. */
	| "unknown-command"
	/** The command threw in the renderer. */
	| "renderer-error"
	/** Request came from a different contract version than the renderer speaks. */
	| "version-mismatch";

export type McpCommandResponse<T = unknown> =
	| { id: string; ok: true; data: T }
	| { id: string; ok: false; code: McpErrorCode; message: string };

/** Human-readable explanations, so an agent gets a reason rather than a code. */
export const MCP_ERROR_MESSAGES: Record<McpErrorCode, string> = {
	"editor-not-open":
		"No project is open. OpenScreen is in recorder mode, or the editor window is closed — " +
		"there is no editor state to read until the user opens a recording.",
	timeout: "The editor did not respond in time.",
	"unknown-command": "The editor does not implement this command.",
	"renderer-error": "The editor failed to run this command.",
	"version-mismatch":
		"The editor speaks a different version of the MCP command contract than this endpoint.",
};
