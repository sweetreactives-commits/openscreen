import { useEffect, useRef } from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { decodeAudioPeaks, getCachedAudioPeaks } from "@/hooks/useAudioPeaks";
import type { EditorState } from "@/hooks/useEditorHistory";
import { buildAudioProfile } from "@/lib/mcp/audioProfile";
import { type ClipTarget, isClipTargetError, resolveClipTarget } from "@/lib/mcp/clipTargets";
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
import { probeMediaDurationMs } from "@/lib/mediaDuration";
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
	/** Cursor telemetry of a recording that is not the open one, read from its files. */
	getClipTelemetry: (sourcePath: string) => Promise<readonly CursorTelemetryPoint[]>;
	/** Opens another recording for editing, as clicking it in the strip does. */
	openClip: (clipId: string) => boolean;
	/**
	 * Puts the open project aside so the editor window can be destroyed.
	 *
	 * The same thing "Back to recording" does, and it has to be the same: the
	 * snapshot of the project lives here, in the renderer, and the main process
	 * cannot build one. Resolves false if the work could not be put aside — then
	 * nothing may switch away from it.
	 */
	parkProject: () => Promise<boolean>;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function useMcpCommands(sources: McpCommandSources): void {
	// The listener is registered once but must always see current state, so it
	// reads through a ref rather than closing over a render's values.
	const sourcesRef = useRef(sources);
	sourcesRef.current = sources;

	// Lengths of the recordings the editor does not have open, read from the files
	// once each: a recording does not change length, and get_project is asked often.
	const clipDurationsRef = useRef(new Map<string, Promise<number | null>>());

	useEffect(() => {
		if (!window.electronAPI?.onMcpCommand) return;

		return window.electronAPI.onMcpCommand(async (request: McpCommandRequest) => {
			const current = sourcesRef.current;
			const args = request.args ?? {};

			/** The recording a read is about: the open one unless another is named. */
			const target = (): ClipTarget | { error: string } =>
				resolveClipTarget(
					current.editor.clips,
					current.editor.activeClipId,
					current.videoUrl,
					current.media?.screenVideoPath ?? null,
					args.clipId,
				);

			const clipDuration = async (clip: ClipTarget): Promise<number> => {
				if (clip.open || !clip.sourcePath) return current.durationMs;
				return (await clipDurationsRef.current.get(clip.sourcePath)) ?? current.durationMs;
			};

			switch (request.command) {
				case "get_project": {
					const dimensions = current.getSourceDimensions();
					// Every other recording's length, so the clips can be laid out on the
					// finished video's clock. The open one's comes from its own player.
					const durations: Record<string, number | null> = {};
					await Promise.all(
						current.editor.clips.map(async (clip) => {
							if (clip.kind !== "recording" || clip.id === current.editor.activeClipId) return;
							const sourcePath = clip.media?.screenVideoPath;
							if (!sourcePath) {
								durations[clip.id] = null;
								return;
							}
							let probe = clipDurationsRef.current.get(sourcePath);
							if (!probe) {
								probe = probeMediaDurationMs(toFileUrl(sourcePath));
								clipDurationsRef.current.set(sourcePath, probe);
							}
							durations[clip.id] = await probe;
						}),
					);
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
						clipDurationsMs: durations,
					});
				}

				case "get_cursor_events": {
					const clip = target();
					if (isClipTargetError(clip)) throw new Error(clip.error);
					const telemetry = clip.open
						? current.cursorTelemetry
						: clip.sourcePath
							? await current.getClipTelemetry(clip.sourcePath)
							: [];
					return {
						clipId: clip.clipId,
						...summarizeCursorEvents(telemetry, {
							minIdleMs: asNumber(args.minIdleMs),
							movementThreshold: asNumber(args.movementThreshold),
							maxClicks: asNumber(args.maxClicks),
						}),
					};
				}

				case "get_audio_profile": {
					const clip = target();
					if (isClipTargetError(clip)) throw new Error(clip.error);
					// Decodes on first ask and caches, so the waveform being off costs nothing
					// and a second call is free.
					const peaks = await decodeAudioPeaks(clip.videoUrl);
					return {
						clipId: clip.clipId,
						...buildAudioProfile(peaks, await clipDuration(clip), {
							bucketCount: asNumber(args.bucketCount),
							silenceThreshold: asNumber(args.silenceThreshold),
							minSilenceMs: asNumber(args.minSilenceMs),
						}),
					};
				}

				case "get_frame": {
					const clip = target();
					if (isClipTargetError(clip)) throw new Error(clip.error);
					const frame = await grabFrame(clip.videoUrl, asNumber(args.timeMs) ?? 0, {
						maxWidth: asNumber(args.maxWidth),
						quality: asNumber(args.quality),
					});
					return { ...frame, clipId: clip.clipId };
				}

				/**
				 * Opens another recording for editing.
				 *
				 * Editing has no clipId of its own: it goes through the editor's undo
				 * history, which belongs to whatever recording is open. This moves that,
				 * and starts a new undo history in doing so — exactly as the user clicking
				 * the clip in the strip would.
				 */
				case "open_clip": {
					const clipId = typeof args.clipId === "string" ? args.clipId : "";
					if (!clipId) return { ok: false, message: "Name the clip to open." };
					if (clipId === current.editor.activeClipId) {
						return { ok: true, activeClipId: clipId, alreadyOpen: true };
					}
					const clip = target();
					if (isClipTargetError(clip)) return { ok: false, message: clip.error };
					if (!current.openClip(clipId)) {
						return { ok: false, message: `Could not open clip "${clipId}".` };
					}
					return { ok: true, activeClipId: clipId, alreadyOpen: false };
				}

				case "park_project": {
					// Asked for just before the editor is torn down for a recording. If this
					// says no, nothing tears anything down.
					const parked = await current.parkProject();
					return parked
						? { ok: true, parked: true }
						: { ok: false, message: "Could not put the project aside." };
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
						window.electronAPI.readMcpImage,
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
					// A gif rendered into a .mp4 opens in nothing. The name is explicit and
					// the format has a default, so the name wins the disagreement.
					const named = fileName.toLowerCase().endsWith(".mp4") ? "mp4" : "gif";
					if (args.format !== undefined && named !== format) {
						return {
							status: "error",
							message: `"${fileName}" asks for ${named} but format says ${format}. Name the file to match the format you want.`,
						};
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
					return requestExport(resolved.path, named, current.runExport);
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
					const clip = target();
					if (isClipTargetError(clip)) throw new Error(clip.error);
					// Returns the current state without waiting; Whisper runs for minutes.
					const state = await requestTranscript(clip.videoUrl, {
						restart: args.restart === true,
					});
					return { ...state, clipId: clip.clipId };
				}

				default:
					throw new Error(`Unknown command: ${request.command}`);
			}
		});
	}, []);
}
