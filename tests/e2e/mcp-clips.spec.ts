import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type Page, test } from "@playwright/test";
import { LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY } from "../../src/i18n/config";

/**
 * What an agent sees when the project holds more than one recording.
 *
 * Until now every MCP tool answered about one recording and said so in absolute
 * terms — "all timestamps are on the original recording's clock". In a project of
 * a card and two takes that answer was not merely incomplete, it was wrong about
 * a project the agent could not see. This checks the whole contract end to end:
 * the sequence is reported, another clip can be read without disturbing the
 * editor, and editing follows an explicit move rather than happening invisibly.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(__dirname, "../../dist-electron/main.js");
const TAKE_ONE = path.join(__dirname, "../fixtures/sample.webm");
const TAKE_TWO = path.join(__dirname, "../fixtures/sample-small.webm");
const PROTOCOL_VERSION = "2026-07-28";

interface McpEndpoint {
	url: string;
	token: string;
}

interface ToolResult {
	isError?: boolean;
	content?: Array<{ text?: string; type: string }>;
	structuredContent?: Record<string, unknown>;
}

async function rawCall(
	endpoint: McpEndpoint,
	name: string,
	args: Record<string, unknown> = {},
): Promise<ToolResult> {
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
					"io.modelcontextprotocol/clientInfo": { name: "mcp-clips-e2e", version: "1" },
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
	});
	const body = (await response.json()) as { result?: ToolResult };
	return body.result ?? {};
}

async function call(endpoint: McpEndpoint, name: string, args: Record<string, unknown> = {}) {
	const result = await rawCall(endpoint, name, args);
	expect(result.isError, `${name} failed: ${result.content?.[0]?.text}`).toBeFalsy();
	return result.structuredContent as Record<string, unknown>;
}

interface SummaryClip {
	id: string;
	kind: string;
	open: boolean;
	title?: string;
	sourceDurationMs: number | null;
	outStartMs: number | null;
	outEndMs: number | null;
}

test("an agent sees every clip, reads another one, and edits only what it opened", async () => {
	test.setTimeout(420_000);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-mcp-clips-e2e-"));
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

	const created: string[] = [];
	let editorWindow: Page | null = null;

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		const resolvedUserData = await app.evaluate(({ app: electronApp }) =>
			electronApp.getPath("userData"),
		);
		const endpoint = JSON.parse(
			fs.readFileSync(path.join(resolvedUserData, "mcp.json"), "utf-8"),
		) as McpEndpoint;

		const recordingsDir = path.join(resolvedUserData, "recordings");
		fs.mkdirSync(recordingsDir, { recursive: true });
		const takeOne = path.join(recordingsDir, "take-one.webm");
		const takeTwo = path.join(recordingsDir, "take-two.webm");
		const projectPath = path.join(recordingsDir, "clips.openscreen");
		fs.copyFileSync(TAKE_ONE, takeOne);
		fs.copyFileSync(TAKE_TWO, takeTwo);
		created.push(takeOne, takeTwo, projectPath);

		// An intro card, a take, and another take with a zoom already on it.
		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				version: 4,
				clips: [
					{ id: "card-1", media: null, durationMs: 1_000, title: "Intro" },
					{ id: "clip-1", media: { screenVideoPath: takeOne }, editor: {} },
					{
						id: "clip-2",
						media: { screenVideoPath: takeTwo },
						editor: {
							zoomRegions: [
								{
									id: "zoom-1",
									startMs: 100,
									endMs: 600,
									depth: 2,
									focus: { cx: 0.5, cy: 0.5 },
								},
							],
						},
					},
				],
				editor: {},
			}),
		);

		await hudWindow.evaluate(
			([localeKey, promptKey]: [string, string]) => {
				localStorage.setItem(localeKey, "en");
				localStorage.setItem(promptKey, "1");
			},
			[LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY] as [string, string],
		);
		const opened = await hudWindow.evaluate(
			(file: string) => window.electronAPI.loadProjectFileFromPath(file),
			projectPath,
		);
		expect(opened.success, JSON.stringify(opened)).toBe(true);
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
		const editor = editorWindow;
		await editor.waitForLoadState("domcontentloaded");
		await expect(editor.getByTestId("testId-export-panel-button")).toBeVisible({ timeout: 60_000 });

		const summary = async () => {
			const deadline = Date.now() + 60_000;
			let project = await call(endpoint, "get_project");
			while (project.open !== true && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				project = await call(endpoint, "get_project");
			}
			expect(project.open).toBe(true);
			return project;
		};

		// The whole project, not the recording that happens to be open.
		let project = await summary();
		let sequence = project.sequence as { clips: SummaryClip[]; durationMs: number | null };
		expect(sequence.clips.map((clip) => [clip.id, clip.kind, clip.open])).toEqual([
			["card-1", "card", false],
			["clip-1", "recording", true],
			["clip-2", "recording", false],
		]);
		expect(sequence.clips[0].title).toBe("Intro");
		// A card of one second, then two takes of two seconds each.
		expect(sequence.clips[1].outStartMs).toBe(1_000);
		expect(sequence.clips[2].outStartMs).toBeGreaterThan(2_000);
		expect(sequence.durationMs).toBeGreaterThan(4_000);
		expect(project.output as { durationMs: number }).toMatchObject({
			durationMs: sequence.durationMs,
		});

		// A frame from a recording the editor does not have open, named by its id.
		const frame = await rawCall(endpoint, "get_frame", { clipId: "clip-2", timeMs: 500 });
		expect(
			frame.isError,
			`get_frame on another clip failed: ${frame.content?.[0]?.text}`,
		).toBeFalsy();
		expect(frame.content?.some((part) => part.type === "image")).toBe(true);

		// Reading another clip leaves the editor where it was.
		project = await call(endpoint, "get_project");
		expect(
			(project.sequence as { clips: SummaryClip[] }).clips.find((clip) => clip.open)?.id,
			"reading another clip moved the editor",
		).toBe("clip-1");

		// Refusals name what could have been asked for instead.
		const card = await rawCall(endpoint, "get_frame", { clipId: "card-1", timeMs: 0 });
		expect(card.isError).toBe(true);
		expect(card.content?.[0]?.text).toMatch(/title card/);
		const missing = await rawCall(endpoint, "get_transcript", { clipId: "clip-9" });
		expect(missing.isError).toBe(true);
		expect(missing.content?.[0]?.text).toContain("clip-1");

		// Edits land on the open recording; the second take's own zoom is not visible
		// from here, which is exactly why open_clip exists.
		expect((project.regions as { zooms: unknown[] }).zooms).toHaveLength(0);

		const moved = await call(endpoint, "open_clip", { clipId: "clip-2" });
		expect(moved).toMatchObject({ ok: true, activeClipId: "clip-2", alreadyOpen: false });
		await expect(editor.getByTestId("testId-clip-clip-2")).toBeDisabled({ timeout: 30_000 });

		project = await summary();
		sequence = project.sequence as { clips: SummaryClip[]; durationMs: number | null };
		expect(sequence.clips.find((clip) => clip.open)?.id).toBe("clip-2");
		// Now its own zoom is the one on the table.
		expect((project.regions as { zooms: Array<{ id: string }> }).zooms.map((z) => z.id)).toEqual([
			"zoom-1",
		]);

		await call(endpoint, "apply_commands", {
			commands: [{ op: "add_zoom", startMs: 1_200, endMs: 1_600, scale: 2 }],
		});
		project = await call(endpoint, "get_project");
		expect(
			(project.regions as { zooms: unknown[] }).zooms,
			"the edit did not land on the clip that was opened",
		).toHaveLength(2);

		// And the first take is untouched by all of that.
		await call(endpoint, "open_clip", { clipId: "clip-1" });
		await expect(editor.getByTestId("testId-clip-clip-1")).toBeDisabled({ timeout: 30_000 });
		project = await summary();
		expect((project.regions as { zooms: unknown[] }).zooms).toHaveLength(0);
	} finally {
		await editorWindow
			?.evaluate(() => window.electronAPI.setHasUnsavedChanges(false))
			.catch(() => {
				// Already gone; closing is about to happen anyway.
			});
		await app.close().catch(() => {
			// Already gone; the run is over either way.
		});
		for (const file of created) {
			if (file && fs.existsSync(file)) fs.unlinkSync(file);
		}
	}
});
