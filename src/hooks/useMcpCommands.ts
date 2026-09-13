import { useEffect, useRef } from "react";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { decodeAudioPeaks, getCachedAudioPeaks } from "@/hooks/useAudioPeaks";
import type { EditorState } from "@/hooks/useEditorHistory";
import { buildAudioProfile } from "@/lib/mcp/audioProfile";
import type { McpCommandRequest } from "@/lib/mcp/contracts";
import { summarizeCursorEvents } from "@/lib/mcp/cursorEvents";
import { applyCommands, type EditorCommand } from "@/lib/mcp/editorCommands";
import { currentExport, type ExportRunner, requestExport } from "@/lib/mcp/exportJob";
import { grabFrame } from "@/lib/mcp/frameGrab";
import { resolveImageCommands } from "@/lib/mcp/imageAnnotation";
import { buildProjectSummary } from "@/lib/mcp/projectSummary";
import { requestTranscript } from "@/lib/mcp/transcriptJob";
import {
	buildWalkthrough,
	imageFolderName,
	lastPathSegment,
	validateSteps,
	type WalkthroughStep,
} from "@/lib/mcp/walkthrough";
import type { ProjectMedia } from "@/lib/recordingSession";

/**
 * Answers read commands from the MCP endpoint with the editor's live state.
 *
 * Everything an agent can read passes through here, which is why it reads rather
 * than writes: this hook has no way to change the project. Writes will arrive as
 * a separate command set going through the editor's history, so they are
 * undoable — see docs/architecture/mcp-server.md.
 */

export interface McpCommandSources {
	editor: EditorState;
	media: ProjectMedia | null;
	projectPath: string | null;
	durationMs: number;
	/** Read through the live <video> element, which is where the real dimensions are. */
	getSourceDimensions: () => { width: number; height: number };
	cursorTelemetry: readonly CursorTelemetryPoint[];
	/** Source to decode audio from, on demand. */
	videoUrl: string | null;
	/**
	 * Applies an agent's edit through the editor's history, so the whole batch is
	 * a single step the user can undo.
	 */
	applyPatch: (patch: Partial<EditorState>) => void;
	/** Renders the project to an already-resolved destination. */
	runExport: ExportRunner;
	/** The user's chosen export folder, or null to fall back to the recordings folder. */
	exportFolder: string | null;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function useMcpCommands(sources: McpCommandSources): void {
	// The listener is registered once but must always see current state, so it
	// reads through a ref rather than closing over a render's values.
	const sourcesRef = useRef(sources);
	sourcesRef.current = sources;

	useEffect(() => {
		if (!window.electronAPI?.onMcpCommand) return;

		return window.electronAPI.onMcpCommand(async (request: McpCommandRequest) => {
			const current = sourcesRef.current;
			const args = request.args ?? {};

			switch (request.command) {
				case "get_project": {
					const dimensions = current.getSourceDimensions();
					// Don't decode audio just to answer this: report what is already known
					// and let get_audio_profile settle it.
					const cachedPeaks = getCachedAudioPeaks(current.videoUrl ?? undefined);
					return buildProjectSummary({
						editor: current.editor,
						media: current.media,
						projectPath: current.projectPath,
						durationMs: current.durationMs,
						sourceWidth: dimensions.width,
						sourceHeight: dimensions.height,
						hasCursorTelemetry: current.cursorTelemetry.length > 0,
						hasAudio: cachedPeaks ? true : null,
					});
				}

				case "get_cursor_events":
					return summarizeCursorEvents(current.cursorTelemetry, {
						minIdleMs: asNumber(args.minIdleMs),
						movementThreshold: asNumber(args.movementThreshold),
						maxClicks: asNumber(args.maxClicks),
					});

				case "get_audio_profile": {
					// Decodes on first ask and caches, so the waveform being off costs nothing
					// and a second call is free.
					const peaks = current.videoUrl ? await decodeAudioPeaks(current.videoUrl) : null;
					return buildAudioProfile(peaks, current.durationMs, {
						bucketCount: asNumber(args.bucketCount),
						silenceThreshold: asNumber(args.silenceThreshold),
						minSilenceMs: asNumber(args.minSilenceMs),
					});
				}

				case "get_frame": {
					if (!current.videoUrl) throw new Error("No video is loaded");
					return grabFrame(current.videoUrl, asNumber(args.timeMs) ?? 0, {
						maxWidth: asNumber(args.maxWidth),
						quality: asNumber(args.quality),
					});
				}

				case "apply_commands": {
					const raw = Array.isArray(args.commands)
						? (args.commands as Record<string, unknown>[])
						: [];
					// Image annotations arrive as paths. Read them here, before anything is
					// applied, so an unreadable file fails the batch rather than leaving
					// half of it written.
					const commands = (await resolveImageCommands(
						raw,
						window.electronAPI.readBinaryFile,
					)) as unknown as EditorCommand[];
					const outcome = applyCommands(current.editor, commands, current.durationMs);
					if (!outcome.ok) {
						// Nothing was applied — the layer validates the whole batch first.
						return outcome;
					}
					current.applyPatch(outcome.patch);
					return {
						ok: true,
						createdIds: outcome.createdIds,
						changed: Object.keys(outcome.patch),
					};
				}

				case "export_video": {
					const format = args.format === "mp4" ? "mp4" : "gif";
					const fileName = typeof args.fileName === "string" ? args.fileName : "";
					// Asking with no name is how a caller polls a render already going.
					if (!fileName) {
						const state = currentExport();
						if (state) return state;
						return { status: "error", message: "Give a fileName to start an export." };
					}
					// Settle the destination before starting: a bad name or an existing
					// file should be refused now, not discovered on a later poll.
					const resolved = await window.electronAPI.resolveMcpExportPath(
						fileName,
						current.exportFolder,
					);
					if (!resolved.success || !resolved.path) {
						return {
							status: "error",
							message: resolved.message ?? "Could not resolve a path for the export.",
						};
					}
					return requestExport(resolved.path, format, current.runExport);
				}

				case "export_walkthrough": {
					if (!current.videoUrl) throw new Error("No video is loaded");

					const steps = args.steps as WalkthroughStep[];
					const invalid = validateSteps(steps, current.durationMs);
					if (invalid) return { ok: false, message: invalid };

					const fileName = typeof args.fileName === "string" ? args.fileName : "";
					const resolved = await window.electronAPI.resolveMcpExportPath(
						fileName,
						current.exportFolder,
						["md"],
					);
					if (!resolved.success || !resolved.path) {
						return { ok: false, message: resolved.message ?? "Could not resolve a path." };
					}

					// A frame that will not decode costs its step a screenshot, not the
					// whole document — the words are the part worth keeping.
					const frames = await Promise.all(
						steps.map(async (step) => {
							try {
								const frame = await grabFrame(current.videoUrl as string, step.timeMs, {
									maxWidth: 960,
								});
								return frame.base64;
							} catch {
								return null;
							}
						}),
					);

					const docFileName = lastPathSegment(resolved.path);
					const title =
						typeof args.title === "string" && args.title.trim() ? args.title : "Walkthrough";
					const built = buildWalkthrough(title, steps, frames, docFileName);
					const written = await window.electronAPI.writeMcpWalkthrough(
						resolved.path,
						built.markdown,
						imageFolderName(docFileName),
						built.images,
					);

					if (!written.success) {
						return { ok: false, message: written.message ?? "Could not write the walkthrough." };
					}
					return {
						ok: true,
						path: written.path,
						steps: steps.length,
						screenshots: written.imageCount ?? 0,
					};
				}

				case "get_transcript": {
					if (!current.videoUrl) throw new Error("No video is loaded");
					// Returns the current state without waiting; Whisper runs for minutes.
					return requestTranscript(current.videoUrl, { restart: args.restart === true });
				}

				default:
					throw new Error(`Unknown command: ${request.command}`);
			}
		});
	}, []);
}
