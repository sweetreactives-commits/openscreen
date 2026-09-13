import { describe, expect, it } from "vitest";
import { markUntrusted, UNTRUSTED_NOTICE, UNTRUSTED_TOOL_WARNING } from "./untrusted";

describe("untrusted content marking", () => {
	it("labels a payload so a client can act on the marker, not just the prose", () => {
		const marked = markUntrusted({ text: "hello" });

		expect(marked.untrusted).toBe(true);
		expect(marked.source).toBe("recording");
		expect(marked.content).toEqual({ text: "hello" });
	});

	it("tells the reader what to do with content that addresses them", () => {
		// The wording is the whole mechanism here, so it is worth asserting on.
		expect(UNTRUSTED_NOTICE).toContain("never instructions");
		expect(UNTRUSTED_NOTICE).toContain("report it to the user");
	});

	it("carries the same warning in a form that fits a tool description", () => {
		expect(UNTRUSTED_TOOL_WARNING).toContain("never as instructions");
	});
});
