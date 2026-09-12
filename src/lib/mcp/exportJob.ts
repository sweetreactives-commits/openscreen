/**
 * Export as a job an agent can poll.
 *
 * A GIF of a couple of minutes takes longer than any request should wait, so
 * `requestExport` starts the render and returns where it stands. Same shape as
 * the transcript job, for the same reason: it works with every MCP client
 * rather than only those implementing the Tasks extension.
 */

export type ExportState =
	| { status: "running"; percent: number | null }
	| { status: "ready"; path: string }
	| { status: "error"; message: string };

/**
 * Renders to an already-resolved destination and resolves with what it wrote.
 *
 * The path is settled before the job starts, so a bad file name or an existing
 * file is refused straight away rather than surfacing on some later poll.
 */
export type ExportRunner = (
	targetPath: string,
	format: "mp4" | "gif",
	onProgress: (percent: number | null) => void,
) => Promise<string>;

type Job = { state: ExportState };

/** One job at a time: exporting twice at once would fight over the decoder. */
let current: Job | null = null;

async function run(
	job: Job,
	targetPath: string,
	format: "mp4" | "gif",
	runner: ExportRunner,
): Promise<void> {
	try {
		const path = await runner(targetPath, format, (percent) => {
			job.state = { status: "running", percent };
		});
		job.state = { status: "ready", path };
	} catch (error) {
		job.state = {
			status: "error",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Starts an export, or reports the one already in flight. Never waits.
 *
 * A finished or failed job is replaced by the next request, since the caller
 * has already seen the outcome — unlike the transcript job, where a repeat ask
 * should return the cached result rather than redo minutes of work.
 */
export function requestExport(
	targetPath: string,
	format: "mp4" | "gif",
	runner: ExportRunner,
): ExportState {
	if (current && current.state.status === "running") {
		return current.state;
	}

	const job: Job = { state: { status: "running", percent: null } };
	current = job;
	void run(job, targetPath, format, runner);
	return job.state;
}

/** State of the export in flight, or null when nothing has been asked for. */
export function currentExport(): ExportState | null {
	return current?.state ?? null;
}

/** Drops the job. Used by tests, and when a different recording is loaded. */
export function resetExport(): void {
	current = null;
}
