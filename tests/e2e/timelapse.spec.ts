import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { LOCALE_STORAGE_KEY, SYSTEM_LANGUAGE_PROMPT_SEEN_KEY } from "../../src/i18n/config";

/**
 * Speeding up a real wait, in the real app.
 *
 * Which stretches count as boring is unit-tested against made-up peaks. What only
 * this can show is that the peaks decoded from an actual file lead to the same
 * answer: the long silent wait in the middle becomes a speed region on the
 * timeline, and asking again gives the normal speed back.
 *
 * The state is read through the MCP endpoint, as the other editor specs do —
 * speed regions on the timeline carry nothing to address them by.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(__dirname, "../../dist-electron/main.js");
/** Eleven seconds: a 440Hz tone, seven seconds of silence from 2s, then tone again. */
const TAKE = path.join(__dirname, "../fixtures/sample-with-long-wait.webm");
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
					"io.modelcontextprotocol/clientInfo": { name: "timelapse-e2e", version: "1" },
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

test("speeding up the dull parts finds the wait and can undo it", async () => {
	test.setTimeout(300_000);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-timelapse-e2e-"));
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
		const take = path.join(recordingsDir, "wait.webm");
		const projectPath = path.join(recordingsDir, "wait.openscreen");
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

		const speeds = async () => {
			const project = await call(endpoint, "get_project");
			return ((
				project.regions as { speeds: Array<{ startMs: number; endMs: number; speed: number }> }
			).speeds ?? []) as Array<{ startMs: number; endMs: number; speed: number }>;
		};

		// Nothing is sped up before the button is pressed.
		expect(await speeds()).toHaveLength(0);

		await editor.getByTestId("testId-timelapse-menu").click();
		await editor.getByTestId("testId-timelapse-apply").click();

		await expect
			.poll(async () => (await speeds()).length, {
				timeout: 60_000,
				message: "the wait in the middle of the take was never sped up",
			})
			.toBe(1);

		const [region] = await speeds();
		// The wait runs from 2s to 9s. The region sits inside it, off the tone on
		// both sides by the margin — not over it, and not the whole take.
		const where = `region at ${region.startMs}–${region.endMs}`;
		expect(region.startMs, where).toBeGreaterThan(2_000);
		expect(region.startMs, where).toBeLessThan(2_600);
		expect(region.endMs, where).toBeGreaterThan(8_400);
		expect(region.endMs, where).toBeLessThan(9_000);
		expect(region.speed, "the wait was not sped up at all").toBeGreaterThan(1);

		// Asking again gives the normal speed back.
		await editor.getByTestId("testId-timelapse-menu").click();
		await editor.getByTestId("testId-timelapse-apply").click();
		await expect
			.poll(async () => (await speeds()).length, {
				timeout: 30_000,
				message: "the speeds stayed after asking for normal speed back",
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
