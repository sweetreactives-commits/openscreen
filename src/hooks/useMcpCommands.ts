import { useEffect, useRef } from "react";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { decodeAudioPeaks, getCachedAudioPeaks } from "@/hooks/useAudioPeaks";
import type { EditorState } from "@/hooks/useEditorHistory";
import { buildAudioProfile } from "@/lib/mcp/audioProfile";
import type { McpCommandRequest } from "@/lib/mcp/contracts";
import { summarizeCursorEvents } from "@/lib/mcp/cursorEvents";
import { applyCommands, type EditorCommand } from "@/lib/mcp/editorCommands";
import { grabFrame } from "@/lib/mcp/frameGrab";
import { resolveImageCommands } from "@/lib/mcp/imageAnnotation";
import { buildProjectSummary } from "@/lib/mcp/projectSummary";
import { requestTranscript } from "@/lib/mcp/transcriptJob";
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
