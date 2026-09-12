import { afterEach, describe, expect, it, vi } from "vitest";
import { currentExport, type ExportRunner, requestExport, resetExport } from "./exportJob";

afterEach(() => resetExport());

const settle = async (turns = 3) => {
	for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("requestExport", () => {
	it("starts the render and returns without waiting for it", () => {
		const pending = deferred<string>();
		const runner = vi.fn(() => pending.promise) as unknown as ExportRunner;

		expect(requestExport("demo.gif", "gif", runner)).toEqual({
			status: "running",
			percent: null,
		});
		expect(runner).toHaveBeenCalledTimes(1);
	});

	it("reports progress as the render moves", async () => {
		const pending = deferred<string>();
		let report: ((percent: number | null) => void) | undefined;
		const runner = ((_name: string, _format: string, onProgress: typeof report) => {
			report = onProgress;
			return pending.promise;
		}) as unknown as ExportRunner;

		requestExport("demo.gif", "gif", runner);
		report?.(42);
		expect(currentExport()).toEqual({ status: "running", percent: 42 });
	});

	it("reports the finished file", async () => {
		const runner = (async () => "C:/exports/demo.gif") as unknown as ExportRunner;
		requestExport("demo.gif", "gif", runner);
		await settle();

		expect(currentExport()).toEqual({ status: "ready", path: "C:/exports/demo.gif" });
	});

	it("surfaces why a render failed", async () => {
		const runner = (async () => {
			throw new Error("encoder gave up");
		}) as unknown as ExportRunner;
		requestExport("demo.gif", "gif", runner);
		await settle();

		expect(currentExport()).toEqual({ status: "error", message: "encoder gave up" });
	});

	it("does not start a second render while one is in flight", () => {
		const pending = deferred<string>();
		const runner = vi.fn(() => pending.promise) as unknown as ExportRunner;

		requestExport("one.gif", "gif", runner);
		requestExport("two.gif", "gif", runner);
		requestExport("three.gif", "gif", runner);

		expect(runner).toHaveBeenCalledTimes(1);
	});

	it("lets the next request start once the previous one has been seen", async () => {
		const runner = vi.fn(async () => "C:/exports/done.gif") as unknown as ExportRunner;

		requestExport("first.gif", "gif", runner);
		await settle();
		expect(currentExport()?.status).toBe("ready");

		requestExport("second.gif", "gif", runner);
		expect(runner).toHaveBeenCalledTimes(2);
	});

	it("reports nothing before anything has been asked for", () => {
		expect(currentExport()).toBeNull();
	});
});
