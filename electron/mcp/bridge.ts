import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import {
	MCP_COMMAND_CHANNEL,
	MCP_CONTRACT_VERSION,
	MCP_ERROR_MESSAGES,
	MCP_RESULT_CHANNEL,
	type McpCommand,
	type McpCommandRequest,
	type McpCommandResponse,
	type McpErrorCode,
} from "../../src/lib/mcp/contracts";

/**
 * Asks the editor window a question and waits for its answer.
 *
 * Every read tool ends up here. The editor may not exist at all — recorder mode
 * closes that window — so "no project open" is a normal answer, not a failure.
 */

/** Most reads are cheap; anything slower than this means the renderer is wedged. */
const DEFAULT_TIMEOUT_MS = 10_000;

type Pending = {
	resolve: (response: McpCommandResponse) => void;
	timer: NodeJS.Timeout;
};

const pending = new Map<string, Pending>();
let getEditorWindow: (() => BrowserWindow | null) | null = null;
let listening = false;

function failure(id: string, code: McpErrorCode, detail?: string): McpCommandResponse {
	return {
		id,
		ok: false,
		code,
		message: detail ? `${MCP_ERROR_MESSAGES[code]} (${detail})` : MCP_ERROR_MESSAGES[code],
	};
}

/**
 * Points the bridge at the window that currently hosts the editor, and starts
 * listening for replies. Safe to call more than once.
 */
export function configureMcpBridge(resolveEditorWindow: () => BrowserWindow | null): void {
	getEditorWindow = resolveEditorWindow;
	if (listening) return;
	listening = true;

	ipcMain.on(MCP_RESULT_CHANNEL, (_event, response: McpCommandResponse) => {
		const entry = response?.id ? pending.get(response.id) : undefined;
		// A late reply after the timeout already fired has no one to resolve.
		if (!entry) return;
		pending.delete(response.id);
		clearTimeout(entry.timer);
		entry.resolve(response);
	});
}

/** True when an editor window is up and able to answer. */
export function isEditorAvailable(): boolean {
	const window = getEditorWindow?.() ?? null;
	return window !== null && !window.isDestroyed();
}

export async function callEditor<T>(
	command: McpCommand,
	args?: Record<string, unknown>,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<McpCommandResponse<T>> {
	const id = randomUUID();
	const window = getEditorWindow?.() ?? null;

	if (!window || window.isDestroyed()) {
		return failure(id, "editor-not-open") as McpCommandResponse<T>;
	}

	const request: McpCommandRequest = { id, version: MCP_CONTRACT_VERSION, command, args };

	return new Promise<McpCommandResponse<T>>((resolve) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			resolve(failure(id, "timeout", `${command} after ${timeoutMs}ms`) as McpCommandResponse<T>);
		}, timeoutMs);

		pending.set(id, { resolve: resolve as (response: McpCommandResponse) => void, timer });
		window.webContents.send(MCP_COMMAND_CHANNEL, request);
	});
}

/** Fails every in-flight command. Called when the endpoint stops. */
export function resetMcpBridge(): void {
	for (const [id, entry] of pending) {
		clearTimeout(entry.timer);
		entry.resolve(failure(id, "timeout", "the endpoint stopped"));
	}
	pending.clear();
}
