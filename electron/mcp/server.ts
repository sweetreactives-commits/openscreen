import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import {
	localhostHostValidation,
	localhostOriginValidation,
	toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { app, type BrowserWindow } from "electron";
import { z } from "zod";
import type { McpCommand } from "../../src/lib/mcp/contracts";
import { callEditor, configureMcpBridge, resetMcpBridge } from "./bridge";

/**
 * Local MCP endpoint, so an agent the user already runs (Claude Code, Claude
 * Desktop) can read and eventually edit the project that is open right now.
 *
 * Loopback only, and off unless the user turns it on. See
 * docs/architecture/mcp-server.md for the threat model — the short version is
 * that binding a port makes every process on the machine, and a careless CORS
 * setup makes every open browser tab, a potential caller.
 */

const MCP_ENDPOINT = "/mcp";
const DISCOVERY_FILE = "mcp.json";

/** What the running server advertises to whoever is allowed to connect. */
export interface McpServerInfo {
	port: number;
	token: string;
	url: string;
}

let httpServer: HttpServer | null = null;
let info: McpServerInfo | null = null;

/** Connection details for the running server, or null when it is stopped. */
export function getMcpServerInfo(): McpServerInfo | null {
	return info;
}

function discoveryFilePath(): string {
	return path.join(app.getPath("userData"), DISCOVERY_FILE);
}

/**
 * Writes the live port and token where a client can find them.
 *
 * The port is chosen by the OS, so it cannot be hardcoded in the user's
 * `.mcp.json`; and the token must not be either, since it changes every start.
 */
async function writeDiscoveryFile(current: McpServerInfo): Promise<void> {
	await fs.writeFile(
		discoveryFilePath(),
		JSON.stringify({ ...current, pid: process.pid }, null, 2),
		"utf-8",
	);
}

async function removeDiscoveryFile(): Promise<void> {
	await fs.rm(discoveryFilePath(), { force: true });
}

/**
 * Runs an editor command and shapes it as a tool result.
 *
 * A closed editor is an ordinary outcome, not a crash — the app spends half its
 * life in recorder mode — so it comes back as an error result carrying the
 * reason rather than as a thrown exception.
 */
async function readFromEditor(command: McpCommand, args?: Record<string, unknown>) {
	const response = await callEditor<unknown>(command, args);

	if (!response.ok) {
		return {
			isError: true,
			content: [{ type: "text" as const, text: response.message }],
		};
	}

	return {
		content: [{ type: "text" as const, text: JSON.stringify(response.data, null, 2) }],
		structuredContent: response.data as Record<string, unknown>,
	};
}

function buildMcpServer(): McpServer {
	const server = new McpServer({ name: "openscreen", version: app.getVersion() });

	server.registerTool(
		"get_project",
		{
			title: "Read the open project",
			description:
				"The recording and every edit currently applied to it: source dimensions and " +
				"duration, layout, cursor and webcam settings, and all zoom, trim, speed and " +
				"annotation regions with their ids. Also returns the segments that survive " +
				"trimming and the resulting output duration, so you never have to work those " +
				"out yourself. All timestamps are milliseconds on the original recording's " +
				"clock — adding a trim does not shift anything around it.",
			annotations: { readOnlyHint: true },
		},
		async () => readFromEditor("get_project"),
	);

	server.registerTool(
		"get_cursor_events",
		{
			title: "Read cursor activity",
			description:
				"Where the user clicked and where the cursor sat still, derived from the " +
				"recording's cursor telemetry. Clicks are the natural anchors for zooms; the " +
				"idle stretches are candidates for cutting or speeding up. Returns nothing " +
				"useful on Linux, where the browser capture pipeline records no telemetry — " +
				"check capabilities.cursorTelemetry in get_project first.",
			inputSchema: z.object({
				minIdleMs: z
					.number()
					.optional()
					.describe("Shortest stretch of stillness worth reporting. Default 1500."),
				movementThreshold: z
					.number()
					.optional()
					.describe("Movement below this share of the frame counts as still. Default 0.01."),
				maxClicks: z.number().optional().describe("Ceiling on returned clicks. Default 500."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args) => readFromEditor("get_cursor_events", args),
	);

	server.registerTool(
		"get_audio_profile",
		{
			title: "Read the audio profile",
			description:
				"A coarse loudness curve plus the quiet stretches in the recording — dead air " +
				"worth trimming. Derived from the waveform peaks the editor already computed, " +
				"so it costs nothing extra. Returns an empty profile when the recording has no " +
				"audio track.",
			inputSchema: z.object({
				bucketCount: z.number().optional().describe("Points in the loudness curve. Default 120."),
				silenceThreshold: z
					.number()
					.optional()
					.describe("Amplitude at or below which audio counts as quiet. Default 0.02."),
				minSilenceMs: z
					.number()
					.optional()
					.describe("Shortest quiet stretch worth reporting. Default 700."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args) => readFromEditor("get_audio_profile", args),
	);

	return server;
}

/**
 * Starts the endpoint on a loopback port chosen by the OS and returns its
 * details. Calling it while already running returns the existing server.
 */
export async function startMcpServer(
	getEditorWindow: () => BrowserWindow | null,
): Promise<McpServerInfo> {
	if (info) return info;

	configureMcpBridge(getEditorWindow);
	const token = randomBytes(32).toString("hex");
	const handler = toNodeHandler(createMcpHandler(() => buildMcpServer()));
	// DNS-rebinding guards from the SDK: a page on some other origin must not be
	// able to drive the editor just because the port is open on this machine.
	const checkHost = localhostHostValidation();
	const checkOrigin = localhostOriginValidation();

	const server = createServer((req, res) => {
		if (!checkHost(req, res)) return;
		if (!checkOrigin(req, res)) return;

		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== MCP_ENDPOINT) {
			res.writeHead(404).end();
			return;
		}

		// Anyone who can read the discovery file is already the user; the token is
		// what stops every other local process from walking in.
		if (req.headers.authorization !== `Bearer ${token}`) {
			res
				.writeHead(401, { "content-type": "application/json" })
				.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}

		void handler(req, res);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("MCP server did not bind to a TCP port");
	}

	httpServer = server;
	info = {
		port: address.port,
		token,
		url: `http://127.0.0.1:${address.port}${MCP_ENDPOINT}`,
	};
	await writeDiscoveryFile(info);
	return info;
}

/** Stops the endpoint and clears the discovery file. Safe to call when stopped. */
export async function stopMcpServer(): Promise<void> {
	const server = httpServer;
	httpServer = null;
	info = null;
	resetMcpBridge();

	if (server) {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	}
	await removeDiscoveryFile();
}
