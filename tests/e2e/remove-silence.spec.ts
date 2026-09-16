import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY } from "../../src/i18n/config";

/**
 * Cutting the dead air out of a real recording, in the real app.
 *
 * What to cut is unit-tested against made-up peaks. What only this can show is
 * that the peaks the app decodes from an actual file lead to the same answer: the
 * pause in the middle of the take is found, it becomes a cut on the timeline, and
 * asking again puts the pause back.
 *
 * The state is read through the MCP endpoint, as the other editor specs do — trim
 * regions on the timeline carry nothing to address them by.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(__dirname, "../../dist-electron/main.js");
/** Five seconds: a 440Hz tone, two seconds of silence from 1.5s, then tone again. */
const TAKE = path.join(__dirname, "../fixtures/sample-with-pause.webm");
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
					"io.modelcontextprotocol/clientInfo": { name: "remove-silence-e2e", version: "1" },
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

test("cutting the dead air finds the pause and can put it back", async () => {
	test.setTimeout(300_000);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-remove-silence-e2e-"));
	const app = await electron.launch({
		args: [
			MAIN_JS,
			"--no-sandbox",
			"--enable-unsafe-swiftshader",
			"--autoplay-policy=no-user-gesture-required",
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
	let editorWindow: Awaited<ReturnType<typeof app.waitForEvent>> | null = null;

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
		const take = path.join(recordingsDir, "pause.webm");
		const projectPath = path.join(recordingsDir, "pause.openscreen");
		fs.copyFileSync(TAKE, take);
		created.push(take, projectPath);

		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				version: 4,
				clips: [{ id: "clip-1", media: { screenVideoPath: take }, editor: {} }],
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

		const trims = async () => {
			const project = await call(endpoint, "get_project");
			return ((project.regions as { trims: Array<{ startMs: number; endMs: number }> }).trims ??
				[]) as Array<{ startMs: number; endMs: number }>;
		};

		// Nothing is cut before the button is pressed.
		expect(await trims()).toHaveLength(0);

		await editor.getByTestId("testId-silence-menu").click();
		await editor.getByTestId("testId-silence-apply").click();

		await expect
			.poll(async () => (await trims()).length, {
				timeout: 60_000,
				message: "the pause in the middle of the take was never cut",
			})
			.toBe(1);

		const [cut] = await trims();
		// The silence runs from 1.5s to 3.5s. The cut sits inside it, held off the
		// tone on both sides by the padding — not on it, and not the whole take.
		expect(cut.startMs, `cut at ${cut.startMs}–${cut.endMs}`).toBeGreaterThan(1_500);
		expect(cut.startMs, `cut at ${cut.startMs}–${cut.endMs}`).toBeLessThan(1_900);
		expect(cut.endMs, `cut at ${cut.startMs}–${cut.endMs}`).toBeGreaterThan(3_100);
		expect(cut.endMs, `cut at ${cut.startMs}–${cut.endMs}`).toBeLessThan(3_500);

		// Asking again puts the pause back.
		await editor.getByTestId("testId-silence-menu").click();
		await editor.getByTestId("testId-silence-apply").click();
		await expect
			.poll(async () => (await trims()).length, {
				timeout: 30_000,
				message: "the cuts stayed after asking for the pauses back",
			})
			.toBe(0);
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
