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
import { app } from "electron";

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

function buildMcpServer(): McpServer {
	const server = new McpServer({ name: "openscreen", version: app.getVersion() });

	// Placeholder until the read tools land: proves the endpoint is reachable and
	// gives a client something to call while wiring up a connection.
	server.registerTool(
		"ping",
		{
			title: "Ping OpenScreen",
			description: "Returns ok when the OpenScreen MCP endpoint is reachable.",
		},
		async () => ({ content: [{ type: "text", text: "ok" }] }),
	);

	return server;
}

/**
 * Starts the endpoint on a loopback port chosen by the OS and returns its
 * details. Calling it while already running returns the existing server.
 */
export async function startMcpServer(): Promise<McpServerInfo> {
	if (info) return info;

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

	if (server) {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	}
	await removeDiscoveryFile();
}
