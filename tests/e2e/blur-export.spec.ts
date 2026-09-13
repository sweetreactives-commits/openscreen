import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY } from "../../src/i18n/config";

/**
 * Blur regions reach the exported file.
 *
 * The feature was complete but switched off behind BLUR_REGIONS_ENABLED, with
 * no recorded reason. Turning it on is only justified if it actually works, so
 * this renders the same clip twice — once plain, once covered by a mosaic — and
 * checks the two exports differ. Identical bytes would mean blur is drawn in the
 * preview and dropped on the way out, which would be a good reason to have hidden
 * it in the first place.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(__dirname, "../../dist-electron/main.js");
const TEST_VIDEO = path.join(__dirname, "../fixtures/sample.webm");
const PROTOCOL_VERSION = "2026-07-28";

interface McpEndpoint {
	url: string;
	token: string;
}

async function call(endpoint: McpEndpoint, name: string, args: Record<string, unknown> = {}) {
	const response = await fetch(endpoint.url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${endpoint.token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": PROTOCOL_VERSION,
			"Mcp-Method": "tools/call",
			"Mcp-Name": name,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: Math.floor(Math.random() * 1e9),
			method: "tools/call",
			params: {
				name,
				arguments: args,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
					"io.modelcontextprotocol/clientInfo": { name: "blur-e2e", version: "1" },
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
	});
	const body = (await response.json()) as {
		result?: { isError?: boolean; content?: Array<{ text: string }>; structuredContent?: unknown };
	};
	expect(body.result?.isError, `${name} failed: ${body.result?.content?.[0]?.text}`).toBeFalsy();
	return body.result?.structuredContent as Record<string, unknown>;
}

/** Renders to a GIF and returns its bytes. */
async function exportGif(endpoint: McpEndpoint, fileName: string): Promise<Buffer> {
	const started = await call(endpoint, "export_video", { fileName, format: "gif" });
	let state = started;
	const deadline = Date.now() + 180_000;
	while (state.status === "running" && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		state = await call(endpoint, "export_video");
	}
	expect(state.status, `export ended as ${JSON.stringify(state)}`).toBe("ready");

	const exported = state.path as string;
	const bytes = fs.readFileSync(exported);
	fs.unlinkSync(exported);
	return bytes;
}

test("a blur region changes what comes out of the exporter", async () => {
	test.setTimeout(420_000);

	// Its own profile per launch: these specs write recordings, settings and the
	// MCP discovery file into userData, and sharing one directory makes them
	// interfere when the suite runs as a whole rather than a file at a time.
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-mcp-e2e-"));
	const app = await electron.launch({
		args: [
			MAIN_JS,
			"--no-sandbox",
			"--enable-unsafe-swiftshader",
			`--user-data-dir=${userDataDir}`,
		],
		env: {
			ELECTRON_USER_DATA_DIR: userDataDir,
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

		const userDataDir = await app.evaluate(({ app: electronApp }) =>
			electronApp.getPath("userData"),
		);
		const endpoint = JSON.parse(
			fs.readFileSync(path.join(userDataDir, "mcp.json"), "utf-8"),
		) as McpEndpoint;

		const recordingsDir = path.join(userDataDir, "recordings");
		testVideoInRecordings = path.join(recordingsDir, "blur-sample.webm");
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
		// WebCodecs may not be registered on first load, and the render needs it.
		await editorWindow.reload();
		await editorWindow.waitForLoadState("domcontentloaded");
		await expect(editorWindow.getByTestId("testId-export-panel-button")).toBeVisible({
			timeout: 60_000,
		});

		const deadline = Date.now() + 60_000;
		let summary = await call(endpoint, "get_project");
		while (summary.open !== true && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			summary = await call(endpoint, "get_project");
		}
		expect(summary.open).toBe(true);

		const plain = await exportGif(endpoint, "blur-off.gif");

		// A mosaic over the whole frame, as strong as the editor allows.
		await call(endpoint, "apply_commands", {
			commands: [
				{
					op: "add_blur",
					startMs: 0,
					endMs: (summary.source as { durationMs: number }).durationMs,
					strength: 100,
					position: { x: 50, y: 50 },
					size: { width: 100, height: 100 },
				},
			],
		});

		const withBlur = await exportGif(endpoint, "blur-on.gif");

		expect(withBlur.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a/);
		expect(
			withBlur.equals(plain),
			"the blurred export is byte-identical to the plain one, so blur never reached the encoder",
		).toBe(false);
	} finally {
		await editorWindow
			?.evaluate(() => window.electronAPI.setHasUnsavedChanges(false))
			.catch(() => {
				// Already gone; closing is about to happen anyway.
			});
		await app.close().catch(() => {
			// Already gone; the run is over either way.
		});
		if (testVideoInRecordings && fs.existsSync(testVideoInRecordings)) {
			fs.unlinkSync(testVideoInRecordings);
		}
	}
});
