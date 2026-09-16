import { beforeEach, describe, expect, it, vi } from "vitest";

const isRecordingAllowed = vi.fn(() => true);
vi.mock("./ipc", () => ({ isRecordingAllowed: () => isRecordingAllowed() }));
vi.mock("electron", () => ({ dialog: { showMessageBox: vi.fn() } }));

const { claimPendingRecordingStart, startRecordingForAgent, stopRecordingForAgent } = await import(
	"./recording"
);

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
			parkProject: async () => true,
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

	it("puts the project aside before switching away from it", async () => {
		// Order is the whole guarantee: the switch destroys the editor window, so the
		// project has to be somewhere else by the time it happens.
		const order: string[] = [];
		const { options } = deps({
			parkProject: async () => {
				order.push("park");
				return true;
			},
			switchToRecorder: () => order.push("switch"),
		});

		const outcome = await startRecordingForAgent(options);

		expect(outcome.ok).toBe(true);
		expect(order).toEqual(["park", "switch"]);
	});

	it("does not switch away from work it could not put aside", async () => {
		const switchToRecorder = vi.fn();
		const { options } = deps({ parkProject: async () => false, switchToRecorder });
		const outcome = await startRecordingForAgent(options);

		expect(outcome.refusal).toBe("park-failed");
		expect(
			switchToRecorder,
			"the editor was destroyed with the project still in it",
		).not.toHaveBeenCalled();
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

	it("says so when nothing is recording, with a code that means that", () => {
		const outcome = stopRecordingForAgent(deps().options);
		expect(outcome.ok).toBe(false);
		// Not "already-recording", which is the opposite situation.
		expect(outcome.refusal).toBe("not-recording");
	});
});

describe("pending start handoff", () => {
	it("leaves an approved start for a recorder that was built too late to hear it", async () => {
		await startRecordingForAgent(deps().options);
		expect(claimPendingRecordingStart()).toBe(true);
	});

	it("is claimable only once", async () => {
		await startRecordingForAgent(deps().options);
		expect(claimPendingRecordingStart()).toBe(true);
		expect(claimPendingRecordingStart()).toBe(false);
	});

	it("leaves nothing when the user declined", async () => {
		claimPendingRecordingStart();
		await startRecordingForAgent(deps({ confirm: async () => false }).options);
		expect(claimPendingRecordingStart()).toBe(false);
	});
});
