import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

/**
 * Whether the MCP endpoint runs, persisted where the main process can read it
 * at boot.
 *
 * Deliberately not in `userPreferences`, which lives in renderer localStorage:
 * the endpoint has to decide whether to listen before any window exists. Same
 * shape as `shortcuts.json` — a small JSON file in userData.
 */

/**
 * `read-only` serves the read tools; `full` also exposes editing. Stored as a
 * string rather than a pair of booleans so the set can grow again without a
 * migration.
 */
export type McpMode = "off" | "read-only" | "full";

export interface McpSettings {
	mode: McpMode;
}

/** Off until the user says otherwise: this opens a port. */
export const DEFAULT_MCP_SETTINGS: McpSettings = { mode: "off" };

const VALID_MODES: readonly McpMode[] = ["off", "read-only", "full"];

function settingsFile(): string {
	return path.join(app.getPath("userData"), "mcp-settings.json");
}

function normalize(raw: unknown): McpSettings {
	if (!raw || typeof raw !== "object") return DEFAULT_MCP_SETTINGS;
	const mode = (raw as { mode?: unknown }).mode;
	return VALID_MODES.includes(mode as McpMode) ? { mode: mode as McpMode } : DEFAULT_MCP_SETTINGS;
}

/** Never throws: a missing or corrupt file means the endpoint stays off. */
export async function loadMcpSettings(): Promise<McpSettings> {
	try {
		return normalize(JSON.parse(await fs.readFile(settingsFile(), "utf-8")));
	} catch {
		return DEFAULT_MCP_SETTINGS;
	}
}

export async function saveMcpSettings(settings: McpSettings): Promise<void> {
	await fs.writeFile(settingsFile(), JSON.stringify(normalize(settings), null, 2), "utf-8");
}
