import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY } from "../../src/i18n/config";

/**
 * End-to-end cover for the MCP tools.
 *
 * These tools cross both process boundaries — an HTTP request lands in the main
 * process, which asks the editor window over IPC and waits for a correlated
 * reply — so nothing below the whole stack proves they work. Unit tests cover
 * the projection math; this covers the wiring.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");
const TEST_VIDEO = path.join(__dirname, "../fixtures/sample.webm");

const PROTOCOL_VERSION = "2026-07-28";

/** Smallest valid PNG: a single transparent pixel. */
const MINIMAL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

interface McpEndpoint {
	url: string;
	token: string;
}

/** Posts a JSON-RPC request with the headers the 2026-07-28 binding requires. */
async function callMcp(
	endpoint: McpEndpoint,
	method: string,
	params: Record<string, unknown> = {},
	toolName?: string,
): Promise<Record<string, unknown>> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${endpoint.token}`,
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		"MCP-Protocol-Version": PROTOCOL_VERSION,
		"Mcp-Method": method,
	};
	if (toolName) headers["Mcp-Name"] = toolName;

	const response = await fetch(endpoint.url, {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: Math.floor(Math.random() * 1e9),
			method,
			params: {
				...params,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
					"io.modelcontextprotocol/clientInfo": { name: "openscreen-e2e", version: "1" },
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
	});

	return (await response.json()) as Record<string, unknown>;
}

/** Runs a tool and returns its structured payload, failing the test on a tool error. */
async function callTool(
	endpoint: McpEndpoint,
	name: string,
	args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const body = await callMcp(endpoint, "tools/call", { name, arguments: args }, name);
	const result = body.result as
		| { isError?: boolean; content?: Array<{ text: string }>; structuredContent?: unknown }
		| undefined;

	expect(result, `tools/call ${name} returned no result: ${JSON.stringify(body)}`).toBeTruthy();
	expect(result?.isError, `tools/call ${name} failed: ${result?.content?.[0]?.text}`).toBeFalsy();

	return result?.structuredContent as Record<string, unknown>;
}

/**
 * Polls until the editor reports an open project.
 *
 * The editor's controls render before the video's metadata has loaded, so there
 * is no UI signal that means "the duration is known". A real client would retry
 * the same way.
 */
async function waitForOpenProject(
	endpoint: McpEndpoint,
	timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	let last: Record<string, unknown> = {};

	while (Date.now() < deadline) {
		last = await callTool(endpoint, "get_project");
		if (last.open === true) return last;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	throw new Error(`Editor never reported an open project. Last summary: ${JSON.stringify(last)}`);
}

test("serves the project, cursor and audio read tools to a connected client", async () => {
	test.setTimeout(180_000);

	const app = await electron.launch({
		args: [MAIN_JS, "--no-sandbox", "--enable-unsafe-swiftshader"],
		env: {
			...process.env,
			HEADLESS: process.env["HEADLESS"] ?? "true",
			OPENSCREEN_MCP: "1",
		},
	});

	let testVideoInRecordings = "";
	let editorWindow: Awaited<ReturnType<typeof app.waitForEvent>> | null = null;

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		const userDataDir = await app.evaluate(({ app: electronApp }) => {
			return electronApp.getPath("userData");
		});

		// The port is assigned by the OS and the token is regenerated every start,
		// so the discovery file is the only way in — same path a real client takes.
		const discoveryPath = path.join(userDataDir, "mcp.json");
		expect(fs.existsSync(discoveryPath), "MCP discovery file was not written").toBe(true);
		const endpoint = JSON.parse(fs.readFileSync(discoveryPath, "utf-8")) as McpEndpoint;

		const listed = await callMcp(endpoint, "tools/list");
		const tools = (listed.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
		expect(tools).toEqual(
			expect.arrayContaining([
				"get_project",
				"get_cursor_events",
				"get_audio_profile",
				"get_frame",
				"get_transcript",
			]),
		);
		// Read-only must not even advertise editing, rather than offering a tool
		// that always refuses.
		expect(tools).not.toContain("apply_commands");

		// Recorder mode has no editor state at all; that has to read as an
		// explained refusal rather than an empty project.
		const beforeEditor = await callMcp(
			endpoint,
			"tools/call",
			{ name: "get_project", arguments: {} },
			"get_project",
		);
		const refusal = beforeEditor.result as { isError?: boolean; content: Array<{ text: string }> };
		expect(refusal.isError).toBe(true);
		expect(refusal.content[0].text).toContain("No project is open");

		const recordingsDir = path.join(userDataDir, "recordings");
		testVideoInRecordings = path.join(recordingsDir, "mcp-sample.webm");
		fs.mkdirSync(recordingsDir, { recursive: true });
		fs.copyFileSync(TEST_VIDEO, testVideoInRecordings);

		// A fresh profile opens on the first-run language prompt, and the editor
		// never mounts behind it. Answer it up front so the run is deterministic.
		await hudWindow.evaluate(
			([localeKey, promptKey]: [string, string]) => {
				localStorage.setItem(localeKey, "en");
				localStorage.setItem(promptKey, "1");
			},
			[LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY] as [string, string],
		);

		await hudWindow.evaluate(
			(videoPath: string) => window.electronAPI.setCurrentVideoPath(videoPath),
			testVideoInRecordings,
		);
		try {
			await hudWindow.evaluate(() => window.electronAPI.switchToEditor());
		} catch (error) {
			// Switching destroys the HUD, so its evaluate call can reject mid-flight.
			if (
				!(error instanceof Error) ||
				!/closed|destroyed|target page|target closed/i.test(error.message)
			) {
				throw error;
			}
		}

		editorWindow = await app.waitForEvent("window", {
			predicate: (w) => w.url().includes("windowType=editor"),
			timeout: 15_000,
		});
		await editorWindow.waitForLoadState("domcontentloaded");
		// A command sent before the renderer has registered its listener is dropped,
		// and the caller then waits out the full bridge timeout. Wait for a control
		// that only exists once the editor has actually mounted, rather than for the
		// absence of a loading message, which is also true before anything renders.
		await expect(editorWindow.getByTestId("testId-export-panel-button")).toBeVisible({
			timeout: 60_000,
		});

		const summary = await waitForOpenProject(endpoint);
		expect((summary.media as { screenVideoPath: string }).screenVideoPath).toContain(
			"mcp-sample.webm",
		);

		const source = summary.source as { width: number; height: number; durationMs: number };
		expect(source.width).toBeGreaterThan(0);
		expect(source.durationMs).toBeGreaterThan(0);

		// The contract an agent relies on to place regions correctly.
		const timeDomain = summary.timeDomain as { unit: string; origin: string; note: string };
		expect(timeDomain.unit).toBe("milliseconds");
		expect(timeDomain.origin).toBe("source-recording");
		expect(timeDomain.note).toContain("CUT OUT");

		// With no trims, the whole recording survives and output matches source.
		const output = summary.output as { durationMs: number; keepSegments: unknown[] };
		expect(output.keepSegments).toHaveLength(1);
		expect(output.durationMs).toBe(source.durationMs);

		expect(summary.regions).toHaveProperty("zooms");
		expect(summary.cursor).toHaveProperty("size");

		const cursorEvents = await callTool(endpoint, "get_cursor_events");
		expect(cursorEvents).toHaveProperty("clicks");
		expect(cursorEvents).toHaveProperty("idleSpans");

		// Decodes on demand, so this exercises the path where the waveform is off.
		const audio = await callTool(endpoint, "get_audio_profile", { bucketCount: 10 });
		expect(audio).toHaveProperty("loudness");
		expect(audio).toHaveProperty("silences");

		// The point of get_transcript is that it never blocks: Whisper takes minutes,
		// so the call must come back with a status right away. Whether the model is
		// reachable in this environment is beside the point.
		const transcriptStarted = Date.now();
		const transcript = await callTool(endpoint, "get_transcript");
		expect(Date.now() - transcriptStarted).toBeLessThan(9_000);
		expect(["running", "ready", "error"]).toContain(transcript.status);

		// get_frame answers with image content rather than a structured payload.
		const frameBody = await callMcp(
			endpoint,
			"tools/call",
			{ name: "get_frame", arguments: { timeMs: 500, maxWidth: 320 } },
			"get_frame",
		);
		const frameResult = frameBody.result as {
			isError?: boolean;
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		};
		expect(frameResult.isError, `get_frame failed: ${frameResult.content?.[0]?.text}`).toBeFalsy();

		const image = frameResult.content.find((part) => part.type === "image");
		expect(image, "get_frame returned no image part").toBeTruthy();
		expect(image?.mimeType).toBe("image/jpeg");
		// Decodes to a real JPEG: the first bytes of any JPEG are FF D8 FF.
		const jpeg = Buffer.from(image?.data ?? "", "base64");
		expect(jpeg.length).toBeGreaterThan(500);
		expect(jpeg.subarray(0, 3).toString("hex")).toBe("ffd8ff");

		// The recording is only a couple of seconds long, so a far-future request
		// has to clamp into range rather than hang waiting for a seek that never lands.
		const clampedBody = await callMcp(
			endpoint,
			"tools/call",
			{ name: "get_frame", arguments: { timeMs: 99_000_000 } },
			"get_frame",
		);
		const clampedText = (clampedBody.result as { content: Array<{ text?: string }> }).content[0]
			.text;
		expect(clampedText).toMatch(/^Frame at \d+ms/);
	} finally {
		// The editor guards its close with an unsaved-changes prompt, and in a
		// headless run nobody can answer it, so app.close() would hang until the
		// worker teardown timeout. This test isn't exercising that prompt.
		await editorWindow
			?.evaluate(() => window.electronAPI.setHasUnsavedChanges(false))
			.catch(() => {
				// The window may already be gone; closing is about to happen anyway.
			});
		await app.close().catch(() => {
			// Already gone, or refusing to shut down cleanly — either way the run is over.
		});
		if (testVideoInRecordings && fs.existsSync(testVideoInRecordings)) {
			fs.unlinkSync(testVideoInRecordings);
		}
	}
});

test("stays off until the user turns it on, and stops when they turn it off", async () => {
	test.setTimeout(180_000);

	// No OPENSCREEN_MCP here: this is the path a real user takes.
	const app = await electron.launch({
		args: [MAIN_JS, "--no-sandbox", "--enable-unsafe-swiftshader"],
		env: { ...process.env, HEADLESS: process.env["HEADLESS"] ?? "true" },
	});

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		const userDataDir = await app.evaluate(({ app: electronApp }) => {
			return electronApp.getPath("userData");
		});
		const discoveryPath = path.join(userDataDir, "mcp.json");

		// A mode stored by an earlier run would make the rest meaningless, so start
		// from a known-off state rather than assuming a clean profile.
		const initial = await hudWindow.evaluate(() => window.electronAPI.setMcpMode("off"));
		expect(initial.running).toBe(false);
		expect(fs.existsSync(discoveryPath)).toBe(false);

		const enabled = await hudWindow.evaluate(() => window.electronAPI.setMcpMode("read-only"));
		expect(enabled.running).toBe(true);
		expect(enabled.url).toContain("127.0.0.1");
		expect(enabled.token).toBeTruthy();
		expect(fs.existsSync(discoveryPath), "discovery file should appear once running").toBe(true);

		// The endpoint answers even with no editor open — it just has nothing to read.
		const listed = await callMcp(enabled as unknown as McpEndpoint, "tools/list");
		expect((listed.result as { tools: unknown[] }).tools.length).toBeGreaterThan(0);

		const disabled = await hudWindow.evaluate(() => window.electronAPI.setMcpMode("off"));
		expect(disabled.running).toBe(false);
		expect(fs.existsSync(discoveryPath), "discovery file should be cleared on stop").toBe(false);
	} finally {
		await app.close().catch(() => {
			// Nothing left to close, or it refused; the run is over either way.
		});
	}
});

test("edits and exports only in full mode, one undo step per batch", async () => {
	// A real GIF render is CPU-bound; give it room.
	test.setTimeout(300_000);

	const app = await electron.launch({
		args: [MAIN_JS, "--no-sandbox", "--enable-unsafe-swiftshader"],
		env: {
			...process.env,
			HEADLESS: process.env["HEADLESS"] ?? "true",
			OPENSCREEN_MCP: "full",
		},
	});

	let testVideoInRecordings = "";
	let editorWindow: Awaited<ReturnType<typeof app.waitForEvent>> | null = null;

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		const userDataDir = await app.evaluate(({ app: electronApp }) => {
			return electronApp.getPath("userData");
		});
		const endpoint = JSON.parse(
			fs.readFileSync(path.join(userDataDir, "mcp.json"), "utf-8"),
		) as McpEndpoint;

		const listed = await callMcp(endpoint, "tools/list");
		const tools = (listed.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
		expect(tools).toContain("apply_commands");

		const recordingsDir = path.join(userDataDir, "recordings");
		testVideoInRecordings = path.join(recordingsDir, "mcp-edit-sample.webm");
		fs.mkdirSync(recordingsDir, { recursive: true });
		fs.copyFileSync(TEST_VIDEO, testVideoInRecordings);

		await hudWindow.evaluate(
			([localeKey, promptKey]: [string, string]) => {
				localStorage.setItem(localeKey, "en");
				localStorage.setItem(promptKey, "1");
			},
			[LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY] as [string, string],
		);
		await hudWindow.evaluate(
			(videoPath: string) => window.electronAPI.setCurrentVideoPath(videoPath),
			testVideoInRecordings,
		);
		try {
			await hudWindow.evaluate(() => window.electronAPI.switchToEditor());
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!/closed|destroyed|target page|target closed/i.test(error.message)
			) {
				throw error;
			}
		}

		editorWindow = await app.waitForEvent("window", {
			predicate: (w) => w.url().includes("windowType=editor"),
			timeout: 15_000,
		});
		// WebCodecs may not be registered in the renderer on first load, and without
		// it the render fails. The GIF export suite reloads for the same reason.
		await editorWindow.reload();
		await editorWindow.waitForLoadState("domcontentloaded");
		await expect(editorWindow.getByTestId("testId-export-panel-button")).toBeVisible({
			timeout: 60_000,
		});
		await waitForOpenProject(endpoint);

		const applied = await callTool(endpoint, "apply_commands", {
			commands: [
				{ op: "add_zoom", startMs: 200, endMs: 900, scale: 2.5 },
				{ op: "add_text", startMs: 200, endMs: 900, text: "Look here" },
			],
		});
		expect((applied.createdIds as string[]).length).toBe(2);

		const after = await callTool(endpoint, "get_project");
		const regions = after.regions as {
			zooms: Array<{ id: string; scale: number; source: string }>;
			annotations: Array<{ text?: string }>;
		};
		expect(regions.zooms).toHaveLength(1);
		expect(regions.zooms[0].scale).toBe(2.5);
		// Not "auto": the magic wand's toggle must not sweep an agent's zoom away.
		expect(regions.zooms[0].source).toBe("agent");
		expect(regions.annotations[0].text).toBe("Look here");

		// The agent's edits arrive as proposals, not as applied facts: the review
		// bar appears and the regions render dashed until the user answers.
		await expect(editorWindow.getByText(/proposals from an AI agent/)).toBeVisible({
			timeout: 10_000,
		});

		// An image annotation is given as a path and read on this side, so the
		// agent never ships base64 over the wire.
		const imagePath = path.join(userDataDir, "recordings", "mcp-badge.png");
		fs.writeFileSync(imagePath, MINIMAL_PNG);
		const withImage = await callTool(endpoint, "apply_commands", {
			commands: [{ op: "add_image", startMs: 100, endMs: 800, path: imagePath }],
		});
		expect((withImage.createdIds as string[]).length).toBe(1);

		const withImageProject = await callTool(endpoint, "get_project");
		const imageAnnotation = (
			withImageProject.regions as { annotations: Array<{ image?: { present: boolean } }> }
		).annotations.find((annotation) => annotation.image?.present);
		expect(imageAnnotation, "expected an image annotation").toBeTruthy();

		const missingImage = await callMcp(
			endpoint,
			"tools/call",
			{
				name: "apply_commands",
				arguments: {
					commands: [
						{ op: "add_image", startMs: 0, endMs: 500, path: path.join(userDataDir, "nope.png") },
					],
				},
			},
			"apply_commands",
		);
		expect((missingImage.result as { isError?: boolean }).isError).toBe(true);

		// A bad command anywhere in the batch leaves the project untouched.
		const rejected = await callMcp(
			endpoint,
			"tools/call",
			{
				name: "apply_commands",
				arguments: {
					commands: [
						{ op: "add_zoom", startMs: 1_000, endMs: 1_500 },
						{ op: "add_zoom", startMs: 9_000, endMs: 1_000 },
					],
				},
			},
			"apply_commands",
		);
		const failure = rejected.result as { isError?: boolean; content: Array<{ text: string }> };
		expect(failure.isError).toBe(true);
		expect(failure.content[0].text).toContain("Command 2");

		const unchanged = await callTool(endpoint, "get_project");
		expect((unchanged.regions as { zooms: unknown[] }).zooms).toHaveLength(1);

		// Exporting: the agent names the file, never the folder, and polls until done.
		const started = await callTool(endpoint, "export_video", {
			fileName: "mcp-demo.gif",
			format: "gif",
		});
		expect(started.status).toBe("running");

		const exportDeadline = Date.now() + 150_000;
		let exportState = started;
		while (exportState.status === "running" && Date.now() < exportDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			exportState = await callTool(endpoint, "export_video");
		}
		expect(exportState.status, `export ended as ${JSON.stringify(exportState)}`).toBe("ready");

		const exportedPath = exportState.path as string;
		expect(fs.existsSync(exportedPath), `expected a file at ${exportedPath}`).toBe(true);
		expect(fs.readFileSync(exportedPath).subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a/);
		fs.unlinkSync(exportedPath);

		// A path, rather than a name, is refused outright.
		const traversal = await callMcp(
			endpoint,
			"tools/call",
			{ name: "export_video", arguments: { fileName: "../../escaped.gif" } },
			"export_video",
		);
		const traversalResult = traversal.result as {
			isError?: boolean;
			content: Array<{ text: string }>;
		};
		expect(traversalResult.isError).toBe(true);
		expect(traversalResult.content[0].text).toContain("plain file name");

		// A written walkthrough: the agent supplies the words, we supply the frames
		// and the file.
		const guide = await callTool(endpoint, "export_walkthrough", {
			fileName: "mcp-guide.md",
			title: "Sample walkthrough",
			steps: [
				{ timeMs: 100, title: "Open the thing", body: "It is on the left." },
				{ timeMs: 900, title: "Click export" },
			],
		});
		expect(guide.steps).toBe(2);
		expect(guide.screenshots).toBe(2);

		const guidePath = guide.path as string;
		const guideText = fs.readFileSync(guidePath, "utf-8");
		expect(guideText).toContain("# Sample walkthrough");
		expect(guideText).toContain("## 1. Open the thing");
		expect(guideText).toContain("It is on the left.");
		expect(guideText).toContain("![Click export](mcp-guide-images/step-02.jpg)");

		const shot = path.join(path.dirname(guidePath), "mcp-guide-images", "step-01.jpg");
		expect(fs.existsSync(shot), `expected a screenshot at ${shot}`).toBe(true);
		// A real JPEG, not an empty file.
		expect(fs.readFileSync(shot).subarray(0, 3).toString("hex")).toBe("ffd8ff");

		fs.rmSync(path.join(path.dirname(guidePath), "mcp-guide-images"), { recursive: true });
		fs.unlinkSync(guidePath);

		// A step outside the recording is refused before any frame is decoded.
		const badStep = await callMcp(
			endpoint,
			"tools/call",
			{
				name: "export_walkthrough",
				arguments: {
					fileName: "never-written.md",
					steps: [{ timeMs: 99_000_000, title: "Way past the end" }],
				},
			},
			"export_walkthrough",
		);
		const badStepResult = badStep.result as { isError?: boolean; content: Array<{ text: string }> };
		expect(badStepResult.isError).toBe(true);
		expect(badStepResult.content[0].text).toContain("outside the recording");

		// Keeping them settles every proposal at once, and the bar goes away.
		await editorWindow.getByRole("button", { name: "Keep all" }).click();
		await expect(editorWindow.getByText(/proposals from an AI agent/)).not.toBeVisible({
			timeout: 10_000,
		});
		const kept = await callTool(endpoint, "get_project");
		const keptZooms = (kept.regions as { zooms: Array<{ source: string }> }).zooms;
		expect(keptZooms.every((zoom) => zoom.source === "manual")).toBe(true);

		// Every batch is one undo step, and so is answering the proposals: three
		// presses walk back "keep all", the image batch, and the zoom-and-text batch.
		await editorWindow.keyboard.press("Control+z");
		await editorWindow.keyboard.press("Control+z");
		await editorWindow.keyboard.press("Control+z");
		const undone = await callTool(endpoint, "get_project");
		const undoneRegions = undone.regions as { zooms: unknown[]; annotations: unknown[] };
		expect(undoneRegions.zooms).toHaveLength(0);
		expect(undoneRegions.annotations).toHaveLength(0);
	} finally {
		await editorWindow
			?.evaluate(() => window.electronAPI.setHasUnsavedChanges(false))
			.catch(() => {
				// Already gone; closing is about to happen anyway.
			});
		await app.close().catch(() => {
			// Nothing left to close, or it refused; the run is over either way.
		});
		if (testVideoInRecordings && fs.existsSync(testVideoInRecordings)) {
			fs.unlinkSync(testVideoInRecordings);
		}
	}
});
