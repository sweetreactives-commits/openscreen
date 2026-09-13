import { randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
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
import { UNTRUSTED_TOOL_WARNING } from "../../src/lib/mcp/untrusted";
import { callEditor, configureMcpBridge, resetMcpBridge } from "./bridge";
import { currentMcpMode, isRecordingAllowed } from "./ipc";
import { startRecordingForAgentConfigured, stopRecordingForAgentConfigured } from "./recording";

/**
 * Local MCP endpoint, so an agent the user already runs (Claude Code, Claude
 * Desktop) can read and eventually edit the project that is open right now.
 *
 * Loopback only, and off unless the user turns it on. See
 * docs/architecture/mcp-server.md for the threat model — the short version is
 * that binding a port makes every process on the machine, and a careless CORS
 * setup makes every open browser tab, a potential caller.
 */

/** Decoding a frame means loading and seeking a video, well past a state read. */
const FRAME_TIMEOUT_MS = 45_000;

/** A guide decodes one frame per step, so it needs far longer than a single grab. */
const WALKTHROUGH_TIMEOUT_MS = 300_000;

/**
 * The first ask decodes the recording's whole audio track into PCM, which
 * scales with its length — an hour of audio can outlast the default timeout
 * that suits state reads. Later asks hit the cache and return at once.
 */
const AUDIO_PROFILE_TIMEOUT_MS = 120_000;

/**
 * Compares the bearer token without leaking how much of it matched.
 *
 * A plain `!==` on strings stops at the first differing byte, so how long it
 * takes says something about the prefix. Over loopback against a 256-bit token
 * that is not a practical attack, but the constant-time comparison costs
 * nothing and removes the question.
 */
function tokenMatches(header: string | undefined, expected: string): boolean {
	if (typeof header !== "string") return false;

	const offered = Buffer.from(header);
	const wanted = Buffer.from(`Bearer ${expected}`);
	// timingSafeEqual throws on a length mismatch, which is itself a disclosure
	// this cannot avoid — the length of a fixed-size token is not a secret.
	if (offered.length !== wanted.length) return false;

	return timingSafeEqual(offered, wanted);
}

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
 *
 * The file holds the bearer token, so it is owner-only: on a multi-user Linux
 * machine the default umask would otherwise let any local account read it and
 * walk straight past the token check.
 */
async function writeDiscoveryFile(current: McpServerInfo): Promise<void> {
	const filePath = discoveryFilePath();
	await fs.writeFile(filePath, JSON.stringify({ ...current, pid: process.pid }, null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	});
	// `mode` applies only when the file is created; tighten one left behind by an
	// earlier version too. On Windows this maps to the read-only flag and is a no-op.
	await fs.chmod(filePath, 0o600);
}

async function removeDiscoveryFile(): Promise<void> {
	await fs.rm(discoveryFilePath(), { force: true });
}

/**
 * Removes the discovery file without touching the event loop, for `will-quit`.
 *
 * Async teardown racing app shutdown may never get to run, and the process
 * dying takes the HTTP server with it anyway — the file pointing at a port and
 * token that no longer exist is the only thing that can outlive us.
 */
export function removeMcpDiscoveryFileSync(): void {
	try {
		rmSync(discoveryFilePath(), { force: true });
	} catch {
		// Best effort: a stale file also self-invalidates through its dead pid.
	}
}

/**
 * Runs an editor command and shapes it as a tool result.
 *
 * A closed editor is an ordinary outcome, not a crash — the app spends half its
 * life in recorder mode — so it comes back as an error result carrying the
 * reason rather than as a thrown exception.
 */
async function readFromEditor(
	command: McpCommand,
	args?: Record<string, unknown>,
	timeoutMs?: number,
) {
	const response = await callEditor<unknown>(command, args, timeoutMs);

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
				"clock — adding a trim does not shift anything around it." +
				UNTRUSTED_TOOL_WARNING,
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
		// Decoding the full track on the first ask outgrows the default timeout.
		async (args) => readFromEditor("get_audio_profile", args, AUDIO_PROFILE_TIMEOUT_MS),
	);

	server.registerTool(
		"get_transcript",
		{
			title: "Read the spoken transcript",
			description:
				"What was said, with timestamps on the source recording's clock. Transcription " +
				"runs locally with Whisper and takes minutes on a long recording, so this never " +
				"waits: it starts the job and reports where it stands. Call it again until " +
				'status is "ready". A status of "error" stays put until you pass restart. ' +
				"The transcript covers the whole recording, including stretches you may be " +
				"planning to trim away." +
				UNTRUSTED_TOOL_WARNING,
			inputSchema: z.object({
				restart: z
					.boolean()
					.optional()
					.describe("Discard a finished or failed transcript and start over."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args) => readFromEditor("get_transcript", args),
	);

	server.registerTool(
		"get_frame",
		{
			title: "Look at a frame",
			description:
				"A single frame of the source recording as an image, so you can see what is " +
				"actually on screen at a moment — which window, which UI, what text. This is " +
				"the raw recording, not the styled preview: no wallpaper, padding or zoom. " +
				"The only expensive tool here, so ask for specific moments (a click from " +
				"get_cursor_events, say) rather than sampling the timeline." +
				UNTRUSTED_TOOL_WARNING,
			inputSchema: z.object({
				timeMs: z
					.number()
					.describe("When to grab, in milliseconds on the source recording's clock."),
				maxWidth: z
					.number()
					.optional()
					.describe("Longest edge of the image. Default 768, capped at 1920."),
				quality: z.number().optional().describe("JPEG quality from 0 to 1. Default 0.7."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args) => {
			// Loading and seeking a fresh video element is slower than a state read.
			const response = await callEditor<{
				timeMs: number;
				width: number;
				height: number;
				mimeType: string;
				base64: string;
			}>("get_frame", args, FRAME_TIMEOUT_MS);

			if (!response.ok) {
				return { isError: true, content: [{ type: "text" as const, text: response.message }] };
			}

			const frame = response.data;
			return {
				content: [
					{
						type: "text" as const,
						text: `Frame at ${frame.timeMs}ms, ${frame.width}x${frame.height}`,
					},
					{ type: "image" as const, data: frame.base64, mimeType: frame.mimeType },
				],
			};
		},
	);

	// Editing is registered only in full mode, so the tool list an agent sees
	// matches what the user actually allowed — rather than offering an edit tool
	// that always refuses.
	if (currentMcpMode() === "full") {
		registerEditTool(server);
		// Exporting writes a file, so it belongs with editing rather than reading.
		registerExportTool(server);
		registerWalkthroughTool(server);
	}

	// Recording is consented to separately, so it appears on its own terms rather
	// than riding along with editing.
	if (isRecordingAllowed()) {
		registerRecordingTools(server);
	}

	return server;
}

const span = {
	startMs: z.number().describe("Start on the source recording's clock, in milliseconds."),
	endMs: z.number().describe("End on the source recording's clock, in milliseconds."),
};

const commandSchema = z.discriminatedUnion("op", [
	z.object({
		op: z.literal("add_zoom"),
		...span,
		scale: z.number().optional().describe("Magnification, 1 to 5. Default 1.8."),
		focus: z
			.object({ cx: z.number(), cy: z.number() })
			.optional()
			.describe("Point to zoom on, each 0 to 1 across the frame. Default centre."),
		followCursor: z.boolean().optional().describe("Track the cursor instead of a fixed point."),
	}),
	z.object({
		op: z.literal("update_zoom"),
		id: z.string(),
		startMs: z.number().optional(),
		endMs: z.number().optional(),
		scale: z.number().optional(),
		focus: z.object({ cx: z.number(), cy: z.number() }).optional(),
		followCursor: z.boolean().optional(),
	}),
	z.object({
		op: z.literal("remove_range"),
		...span,
		// Named for what it does: this cuts the span out of the finished video.
	}),
	z.object({
		op: z.literal("set_speed"),
		...span,
		speed: z.number().describe("Playback multiplier: 2 is twice as fast, 0.5 half."),
	}),
	z.object({
		op: z.literal("add_text"),
		...span,
		text: z.string(),
		position: z
			.object({ x: z.number(), y: z.number() })
			.optional()
			.describe("Centre of the text as a percentage of the frame. Default 50/50."),
		fontSize: z.number().optional(),
		color: z.string().optional().describe("CSS colour, e.g. #ffffff."),
		animation: z
			.enum(["none", "fade", "rise", "pop", "slide-left", "typewriter", "pulse"])
			.optional(),
	}),
	z.object({
		op: z.literal("update_text"),
		id: z.string(),
		text: z.string().optional(),
		startMs: z.number().optional(),
		endMs: z.number().optional(),
		position: z.object({ x: z.number(), y: z.number() }).optional(),
		fontSize: z.number().optional(),
		color: z.string().optional(),
		animation: z
			.enum(["none", "fade", "rise", "pop", "slide-left", "typewriter", "pulse"])
			.optional(),
	}),
	z.object({
		op: z.literal("add_blur"),
		...span,
		style: z
			.enum(["blur", "mosaic"])
			.optional()
			.describe("Mosaic by default; a gaussian blur can still hint at what was there."),
		shape: z.enum(["rectangle", "oval"]).optional(),
		strength: z.number().optional().describe("How strongly to obscure, 1 to 100. Default 50."),
		position: z
			.object({ x: z.number(), y: z.number() })
			.optional()
			.describe("Centre of the region as a percentage of the frame. Default 50/50."),
		size: z
			.object({ width: z.number(), height: z.number() })
			.optional()
			.describe("Size as a percentage of the frame. Default 30 by 20."),
	}),
	z.object({
		op: z.literal("add_image"),
		...span,
		path: z
			.string()
			.describe(
				"Path to an image already on this computer (png, jpg, gif, webp, svg). " +
					"It is read and stored inside the project, so it must be under 2 MB.",
			),
		position: z.object({ x: z.number(), y: z.number() }).optional(),
		size: z.object({ width: z.number(), height: z.number() }).optional(),
	}),
	z.object({
		op: z.literal("set_webcam"),
		layout: z.enum(["picture-in-picture", "vertical-stack", "dual-frame", "no-webcam"]).optional(),
		shape: z.enum(["rectangle", "circle", "square", "rounded"]).optional(),
		sizePercent: z.number().optional().describe("Webcam size across the frame, 10 to 50."),
		position: z
			.object({ cx: z.number(), cy: z.number() })
			.nullable()
			.optional()
			.describe("Centre of the webcam, 0 to 1. Only the picture-in-picture layout uses it."),
		mirrored: z.boolean().optional(),
		reactiveZoom: z.boolean().optional(),
	}),
	z.object({
		op: z.literal("remove_region"),
		id: z.string().describe("Any zoom, removed range, speed change or annotation id."),
	}),
	z.object({
		op: z.literal("set_layout"),
		padding: z.number().optional(),
		borderRadius: z.number().optional(),
		shadowIntensity: z.number().optional(),
		wallpaper: z.string().optional(),
	}),
	z.object({
		op: z.literal("set_cursor"),
		visible: z.boolean().optional(),
		size: z.number().optional(),
		smoothing: z.number().optional(),
		motionBlur: z.number().optional(),
		clickBounce: z.number().optional(),
		clickRipple: z.number().optional(),
	}),
]);

function registerExportTool(server: McpServer): void {
	server.registerTool(
		"export_video",
		{
			title: "Render the project to a file",
			description:
				"Renders the open project and writes it to the user's export folder. " +
				"Rendering takes a while, so this never waits: it starts the job and reports " +
				"where it stands. Call it again with no arguments to check progress, until " +
				'status is "ready". You choose the file name, not the folder, and an ' +
				"existing file is never overwritten — pick another name instead.",
			inputSchema: z.object({
				fileName: z
					.string()
					.optional()
					.describe(
						"Plain file name ending in .mp4 or .gif, with no folders in it. " +
							"Omit to poll a render already under way.",
					),
				format: z
					.enum(["mp4", "gif"])
					.optional()
					.describe("Defaults to gif, which is what a README wants."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async (args) => {
			const response = await callEditor<{ status: string; path?: string; message?: string }>(
				"export_video",
				args,
			);

			if (!response.ok) {
				return { isError: true, content: [{ type: "text" as const, text: response.message }] };
			}

			const state = response.data;
			if (state.status === "error") {
				return {
					isError: true,
					content: [{ type: "text" as const, text: state.message ?? "The export failed." }],
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text:
							state.status === "ready"
								? `Exported to ${state.path}`
								: "Still rendering. Call export_video again with no arguments to check.",
					},
				],
				structuredContent: state as Record<string, unknown>,
			};
		},
	);
}

function registerRecordingTools(server: McpServer): void {
	server.registerTool(
		"start_recording",
		{
			title: "Start a screen recording",
			description:
				"Asks OpenScreen to start recording. The user is shown a dialog and must " +
				"approve it — every time, with no way for you to skip or suppress it — and " +
				"the app's own countdown runs before capture begins. Expect this to be " +
				"refused: it is refused outright unless the user has separately allowed " +
				"agents to record, and while the editor holds unsaved work, since starting " +
				"a recording closes the editor. Tell the user what you are about to record " +
				"before calling this, so the dialog is not a surprise.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async () => {
			const outcome = await startRecordingForAgentConfigured();
			if (!outcome.ok) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: outcome.message ?? "Recording refused." }],
				};
			}
			return {
				content: [
					{
						type: "text" as const,
						text: "The user approved. Recording begins after the countdown.",
					},
				],
			};
		},
	);

	server.registerTool(
		"stop_recording",
		{
			title: "Stop the recording",
			description:
				"Ends a recording in progress. Needs no approval — stopping can only be what " +
				"the user wants — and lands the result in the editor, where get_project can " +
				"read it.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async () => {
			const outcome = stopRecordingForAgentConfigured();
			if (!outcome.ok) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: outcome.message ?? "Nothing is recording." }],
				};
			}
			return { content: [{ type: "text" as const, text: "Stopping the recording." }] };
		},
	);
}

function registerWalkthroughTool(server: McpServer): void {
	server.registerTool(
		"export_walkthrough",
		{
			title: "Write a step-by-step guide from the recording",
			description:
				"Turns the recording into a written walkthrough: a markdown document with a " +
				"screenshot pulled from the video at each step you name. You write the steps " +
				"— read get_transcript for what was said and get_cursor_events for where the " +
				"clicks were, then decide what each one is doing. Saved to the user's export " +
				"folder; you choose the file name, not the folder, and an existing file is " +
				"never overwritten. Times are milliseconds on the source recording's clock.",
			inputSchema: z.object({
				fileName: z.string().describe("Plain file name ending in .md, with no folders in it."),
				title: z.string().optional().describe("Heading for the document."),
				steps: z
					.array(
						z.object({
							timeMs: z.number().describe("The moment this step happens."),
							title: z.string().describe("What the step does, as a heading."),
							body: z.string().optional().describe("Any explanation under the heading."),
						}),
					)
					.describe("The steps, in order. Up to 100."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async (args) => {
			// Each step decodes a frame, so a long guide takes a while.
			const response = await callEditor<
				| { ok: true; path: string; steps: number; screenshots: number }
				| { ok: false; message: string }
			>("export_walkthrough", args, WALKTHROUGH_TIMEOUT_MS);

			if (!response.ok) {
				return { isError: true, content: [{ type: "text" as const, text: response.message }] };
			}
			if (!response.data.ok) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: response.data.message }],
				};
			}

			const { path, steps, screenshots } = response.data;
			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${steps} steps with ${screenshots} screenshots to ${path}`,
					},
				],
				structuredContent: { path, steps, screenshots },
			};
		},
	);
}

function registerEditTool(server: McpServer): void {
	server.registerTool(
		"apply_commands",
		{
			title: "Edit the open project",
			description:
				"Applies a list of edits to the project the user has open. The whole list is " +
				"one undo step for them, and it is all or nothing — if any command is invalid, " +
				"nothing is applied and the reply names the one at fault. Timestamps are " +
				"milliseconds on the source recording's clock, the same clock every read tool " +
				"reports. Note that remove_range CUTS OUT the span you give it. Do not invent " +
				"ids: new regions get ids back in createdIds, and existing ones come from " +
				"get_project.",
			inputSchema: z.object({
				commands: z.array(commandSchema).describe("Edits to apply, in order."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async (args) => {
			const response = await callEditor<
				| { ok: true; createdIds: string[]; changed: string[] }
				| { ok: false; code: string; message: string }
			>("apply_commands", args);

			if (!response.ok) {
				return { isError: true, content: [{ type: "text" as const, text: response.message }] };
			}
			if (!response.data.ok) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: response.data.message }],
				};
			}

			const { createdIds, changed } = response.data;
			return {
				content: [
					{
						type: "text" as const,
						text: `Applied. Changed: ${changed.join(", ") || "nothing"}.${
							createdIds.length ? ` New ids: ${createdIds.join(", ")}.` : ""
						}`,
					},
				],
				structuredContent: { createdIds, changed },
			};
		},
	);
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
		if (!tokenMatches(req.headers.authorization, token)) {
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
