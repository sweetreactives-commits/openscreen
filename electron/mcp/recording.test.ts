import { beforeEach, describe, expect, it, vi } from "vitest";

const isRecordingAllowed = vi.fn(() => true);
vi.mock("./ipc", () => ({ isRecordingAllowed: () => isRecordingAllowed() }));
vi.mock("electron", () => ({ dialog: { showMessageBox: vi.fn() } }));

const { startRecordingForAgent, stopRecordingForAgent } = await import("./recording");

/** Stands in for a BrowserWindow; only these two members are used. */
function fakeWindow() {
	return {
		isDestroyed: () => false,
		webContents: { send: vi.fn() },
	} as unknown as Parameters<typeof stopRecordingForAgent>[0]["getMainWindow"] extends () => infer W
		? NonNullable<W>
		: never;
}

function deps(overrides: Record<string, unknown> = {}) {
	const window = fakeWindow();
	return {
		window,
		options: {
			getMainWindow: () => window,
			hasUnsavedChanges: () => false,
			isRecording: () => false,
			switchToRecorder: vi.fn(),
			confirm: async () => true,
			...overrides,
		},
	};
}

beforeEach(() => {
	isRecordingAllowed.mockReturnValue(true);
});

describe("startRecordingForAgent", () => {
	it("starts once the user approves", async () => {
		const { window, options } = deps();
		const outcome = await startRecordingForAgent(options);

		expect(outcome.ok).toBe(true);
		expect(options.switchToRecorder).toHaveBeenCalled();
		expect(window.webContents.send).toHaveBeenCalledWith("start-recording-from-agent");
	});

	it("refuses when the user has not allowed recording at all", async () => {
		isRecordingAllowed.mockReturnValue(false);
		const { window, options } = deps();
		const outcome = await startRecordingForAgent(options);

		expect(outcome.refusal).toBe("not-allowed");
		expect(window.webContents.send).not.toHaveBeenCalled();
	});

	it("never asks when recording is not allowed", async () => {
		isRecordingAllowed.mockReturnValue(false);
		const confirm = vi.fn(async () => true);
		await startRecordingForAgent(deps({ confirm }).options);

		expect(confirm).not.toHaveBeenCalled();
	});

	it("refuses when the user says no", async () => {
		const { window, options } = deps({ confirm: async () => false });
		const outcome = await startRecordingForAgent(options);

		expect(outcome.refusal).toBe("declined");
		expect(options.switchToRecorder).not.toHaveBeenCalled();
		expect(window.webContents.send).not.toHaveBeenCalled();
	});

	it("asks every time rather than remembering an earlier yes", async () => {
		const confirm = vi.fn(async () => true);
		const { options } = deps({ confirm });

		await startRecordingForAgent(options);
		await startRecordingForAgent(options);
		await startRecordingForAgent(options);

		expect(confirm).toHaveBeenCalledTimes(3);
	});

	it("refuses while the editor holds unsaved work, without prompting", async () => {
		const confirm = vi.fn(async () => true);
		const { options } = deps({ hasUnsavedChanges: () => true, confirm });
		const outcome = await startRecordingForAgent(options);

		expect(outcome.refusal).toBe("unsaved-changes");
		// Saying yes would have closed the editor and taken the work with it.
		expect(confirm).not.toHaveBeenCalled();
	});

	it("refuses when a recording is already running", async () => {
		const outcome = await startRecordingForAgent(deps({ isRecording: () => true }).options);
		expect(outcome.refusal).toBe("already-recording");
	});

	it("refuses when a recording started while the dialog was open", async () => {
		let recording = false;
		const outcome = await startRecordingForAgent(
			deps({
				isRecording: () => recording,
				confirm: async () => {
					recording = true;
					return true;
				},
			}).options,
		);

		expect(outcome.refusal).toBe("already-recording");
	});

	it("refuses when there is no window to record from", async () => {
		const outcome = await startRecordingForAgent(deps({ getMainWindow: () => null }).options);
		expect(outcome.refusal).toBe("no-window");
	});

	it("explains a refusal rather than returning a bare code", async () => {
		isRecordingAllowed.mockReturnValue(false);
		const outcome = await startRecordingForAgent(deps().options);
		expect(outcome.message).toContain("separate switch");
	});
});

describe("stopRecordingForAgent", () => {
	it("stops through the same channel the tray button uses", () => {
		const { window, options } = deps({ isRecording: () => true });
		const outcome = stopRecordingForAgent(options);

		expect(outcome.ok).toBe(true);
		expect(window.webContents.send).toHaveBeenCalledWith("stop-recording-from-tray");
	});

	it("needs no consent, because stopping can only be what the user wants", () => {
		isRecordingAllowed.mockReturnValue(false);
		const { options } = deps({ isRecording: () => true });

		expect(stopRecordingForAgent(options).ok).toBe(true);
	});

	it("says so when nothing is recording", () => {
		expect(stopRecordingForAgent(deps().options).ok).toBe(false);
	});
});
