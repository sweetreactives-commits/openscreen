import { Pause, Pencil, Play, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useScopedT } from "@/contexts/I18nContext";
import { drawCardFrame } from "@/lib/cardFrame";
import type { ExportSequenceClip } from "@/lib/exporter/exportSequence";
import { lastPathSegment } from "@/lib/mcp/walkthrough";
import { probeMediaDurationMs } from "@/lib/mediaDuration";
import { computeSequence, resolveTimelinePosition, type Sequence } from "@/lib/sequence";
import { type PlaybackStep, stepCard, stepRecording } from "@/lib/sequencePlayback";
import VideoPlayback, { type VideoPlaybackProps, type VideoPlaybackRef } from "./VideoPlayback";

/**
 * Watching the whole sequence, read-only, over the editor's own preview.
 *
 * The editor's player belongs to the recording being edited: export reads its
 * video element, the shortcuts drive it, and its callbacks write that recording's
 * duration and playhead. So this mounts a player of its own, keeps its own clock,
 * and never writes to the editor. The editor's player stays mounted underneath,
 * paused.
 *
 * One clip is on screen at a time. A recording is a player keyed by its clip, so
 * crossing into the next recording remounts it — a short jump at the seam, which
 * the plan accepts; a card is drawn by the same code the export uses. See
 * "Сверка перед этапом 6" in docs/architecture/multiclip.md.
 */

/** One clip as the preview (and the export) needs it, with its id in the project. */
export interface SequenceEntry {
	id: string;
	clip: ExportSequenceClip;
}

/** Settings shared by every clip — the look of the video, not any recording's edits. */
export type SequenceLook = Pick<
	VideoPlaybackProps,
	| "wallpaper"
	| "aspectRatio"
	| "webcamLayoutPreset"
	| "webcamMaskShape"
	| "webcamMirrored"
	| "webcamReactiveZoom"
	| "webcamSizePreset"
	| "webcamPosition"
	| "showShadow"
	| "shadowIntensity"
	| "showBlur"
	| "motionBlurAmount"
	| "transitionStyle"
	| "transitionMs"
	| "borderRadius"
	| "padding"
	| "showCursor"
	| "cursorSize"
	| "cursorSmoothing"
	| "cursorMotionBlur"
	| "cursorClickBounce"
	| "cursorClickRipple"
	| "cursorClipToBounds"
	| "cursorTheme"
>;

interface SequencePreviewProps {
	/** `null` while the editor is still gathering the clips. */
	entries: SequenceEntry[] | null;
	activeClipId: string;
	/** The open recording's length, already known to the editor. */
	activeDurationMs: number;
	/** The shape of the exported frame. */
	frameAspectRatio: number;
	look: SequenceLook;
	onClose: () => void;
	onEditRecording: (clipId: string) => void;
}

const noop = () => {
	// A read-only preview ignores what the player would otherwise write back.
};

function fileLabel(url: string): string {
	try {
		return lastPathSegment(decodeURIComponent(url));
	} catch {
		return lastPathSegment(url);
	}
}

function formatTime(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Lengths of every recording, probed once per file. */
function useRecordingDurations(
	entries: SequenceEntry[] | null,
	activeClipId: string,
	activeDurationMs: number,
): Map<string, number | null> {
	const [probed, setProbed] = useState<Map<string, number | null>>(() => new Map());
	const requested = useRef(new Set<string>());

	useEffect(() => {
		for (const entry of entries ?? []) {
			if (entry.clip.kind !== "recording" || entry.id === activeClipId) continue;
			const url = entry.clip.recording.videoUrl;
			if (requested.current.has(url)) continue;
			requested.current.add(url);
			void probeMediaDurationMs(url).then((ms) => {
				setProbed((prev) => new Map(prev).set(url, ms));
			});
		}
	}, [entries, activeClipId]);

	return useMemo(() => {
		const byClip = new Map<string, number | null>();
		for (const entry of entries ?? []) {
			if (entry.clip.kind !== "recording") continue;
			if (entry.id === activeClipId) {
				byClip.set(entry.id, activeDurationMs > 0 ? activeDurationMs : null);
				continue;
			}
			const url = entry.clip.recording.videoUrl;
			byClip.set(entry.id, probed.has(url) ? (probed.get(url) ?? null) : null);
		}
		return byClip;
	}, [entries, activeClipId, activeDurationMs, probed]);
}

function CardFrame({ title, aspectRatio }: { title?: string; aspectRatio: number }) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const draw = () => {
			const ratio = window.devicePixelRatio || 1;
			const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
			const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (ctx) drawCardFrame(ctx, { width, height, title });
		};
		draw();
		const observer = new ResizeObserver(draw);
		observer.observe(canvas);
		return () => observer.disconnect();
	}, [title]);

	return (
		<canvas
			ref={canvasRef}
			className="w-full rounded-sm"
			style={{ aspectRatio: String(aspectRatio) }}
			data-testid="testId-sequence-card"
		/>
	);
}

function SequenceBar({
	sequence,
	entries,
	activeClipId,
	timelineMs,
	onSeek,
}: {
	sequence: Sequence;
	entries: SequenceEntry[];
	activeClipId: string;
	timelineMs: number;
	onSeek: (timelineMs: number) => void;
}) {
	const barRef = useRef<HTMLDivElement | null>(null);
	const draggingRef = useRef(false);
	const total = sequence.durationMs;

	const seekAt = (clientX: number) => {
		const bar = barRef.current;
		if (!bar || total <= 0) return;
		const rect = bar.getBoundingClientRect();
		const ratio = Math.min(Math.max((clientX - rect.left) / Math.max(1, rect.width), 0), 1);
		onSeek(ratio * total);
	};

	return (
		<div
			ref={barRef}
			className="relative h-8 w-full cursor-pointer select-none overflow-hidden rounded-md bg-white/[0.04]"
			data-testid="testId-sequence-bar"
			onPointerDown={(event) => {
				draggingRef.current = true;
				event.currentTarget.setPointerCapture(event.pointerId);
				seekAt(event.clientX);
			}}
			onPointerMove={(event) => {
				if (draggingRef.current) seekAt(event.clientX);
			}}
			onPointerUp={(event) => {
				draggingRef.current = false;
				try {
					event.currentTarget.releasePointerCapture(event.pointerId);
				} catch {
					// Already released.
				}
			}}
		>
			{total > 0 &&
				sequence.clips.map((placed) => {
					if (placed.outEndMs <= placed.outStartMs) return null;
					const entry = entries.find((candidate) => candidate.id === placed.id);
					if (!entry) return null;
					const isCard = entry.clip.kind === "card";
					const label =
						entry.clip.kind === "card"
							? entry.clip.card.title?.trim() || ""
							: fileLabel(entry.clip.recording.videoUrl);
					return (
						<div
							key={placed.id}
							className={`absolute inset-y-0 flex items-center overflow-hidden border-r border-black/40 px-1.5 text-[10px] ${
								isCard
									? "bg-slate-500/25 text-slate-300"
									: placed.id === activeClipId
										? "bg-[#34B27B]/30 text-slate-100"
										: "bg-[#34B27B]/15 text-slate-300"
							}`}
							style={{
								left: `${(placed.outStartMs / total) * 100}%`,
								width: `${((placed.outEndMs - placed.outStartMs) / total) * 100}%`,
							}}
							data-testid={`testId-sequence-segment-${placed.id}`}
						>
							<span className="truncate">{label}</span>
						</div>
					);
				})}
			{total > 0 && (
				<div
					className="pointer-events-none absolute inset-y-0 w-0.5 bg-white"
					style={{ left: `${(Math.min(timelineMs, total) / total) * 100}%` }}
				/>
			)}
		</div>
	);
}

export function SequencePreview({
	entries,
	activeClipId,
	activeDurationMs,
	frameAspectRatio,
	look,
	onClose,
	onEditRecording,
}: SequencePreviewProps) {
	const t = useScopedT("timeline");
	const durations = useRecordingDurations(entries, activeClipId, activeDurationMs);

	const ready = useMemo(
		() =>
			entries !== null &&
			entries.every((entry) => entry.clip.kind === "card" || durations.get(entry.id) != null),
		[entries, durations],
	);

	const sequence = useMemo(
		() =>
			computeSequence(
				(entries ?? []).map((entry) =>
					entry.clip.kind === "card"
						? { id: entry.id, sourceDurationMs: entry.clip.card.durationMs }
						: {
								id: entry.id,
								sourceDurationMs: durations.get(entry.id) ?? 0,
								trimRegions: entry.clip.recording.trimRegions,
								speedRegions: entry.clip.recording.speedRegions,
							},
				),
			),
		[entries, durations],
	);

	const [timelineMs, setTimelineMs] = useState(0);
	const [isPlaying, setIsPlaying] = useState(false);
	const [sourceSeconds, setSourceSeconds] = useState(0);

	const timelineRef = useRef(0);
	const playingRef = useRef(false);
	const sequenceRef = useRef(sequence);
	const playbackRef = useRef<VideoPlaybackRef>(null);
	/** The recording whose player has a frame up; time reports from any other are stale. */
	const readyClipRef = useRef<string | null>(null);

	sequenceRef.current = sequence;

	const position = ready ? resolveTimelinePosition(sequence, timelineMs) : null;
	const currentEntry = position
		? (entries?.find((entry) => entry.id === position.clipId) ?? null)
		: null;
	const currentClipIdRef = useRef<string | null>(null);
	currentClipIdRef.current = currentEntry?.id ?? null;

	const moveTimeline = useCallback((ms: number) => {
		timelineRef.current = ms;
		setTimelineMs(ms);
	}, []);

	const setPlaying = useCallback((playing: boolean) => {
		playingRef.current = playing;
		setIsPlaying(playing);
	}, []);

	/** Put the on-screen recording's video at `sourceMs`, then play it if playback is on. */
	const cueRecording = useCallback((sourceMs: number) => {
		const playback = playbackRef.current;
		const video = playback?.video;
		if (!playback || !video) return;
		const seconds = sourceMs / 1000;
		setSourceSeconds(seconds);
		const resume = () => {
			if (playingRef.current) void playback.play().catch(noop);
		};
		if (Math.abs(video.currentTime - seconds) < 0.01) {
			resume();
			return;
		}
		// Play only after the seek lands: the player refuses to start mid-seek.
		video.addEventListener("seeked", resume, { once: true });
		video.currentTime = seconds;
	}, []);

	const applyStep = useCallback(
		(step: PlaybackStep) => {
			if (step.kind === "continue") {
				moveTimeline(step.timelineMs);
				return;
			}
			if (step.kind === "end") {
				setPlaying(false);
				playbackRef.current?.pause();
				moveTimeline(step.timelineMs);
				return;
			}
			moveTimeline(step.timelineMs);
			// Crossing into another recording remounts the player; it cues itself once it
			// has a frame. A card needs nothing: its clock picks the new time up.
		},
		[moveTimeline, setPlaying],
	);

	const handleVideoReady = useCallback(() => {
		const clipId = currentClipIdRef.current;
		readyClipRef.current = clipId;
		const here = resolveTimelinePosition(sequenceRef.current, timelineRef.current);
		if (here && here.clipId === clipId) cueRecording(here.sourceMs);
	}, [cueRecording]);

	const handleSourceTime = useCallback(
		(seconds: number) => {
			const clipId = currentClipIdRef.current;
			if (!clipId || readyClipRef.current !== clipId) return;
			setSourceSeconds(seconds);
			if (!playingRef.current) return;
			applyStep(stepRecording(sequenceRef.current, clipId, seconds * 1000));
		},
		[applyStep],
	);

	const handlePlayState = useCallback(
		(playing: boolean) => {
			const clipId = currentClipIdRef.current;
			if (playing || !playingRef.current || !clipId || readyClipRef.current !== clipId) return;
			// The only pause that means anything here is the file running out: the viewer
			// pauses through this component, which clears playingRef first. A mounting
			// player also pauses itself while it settles, and those land after playback
			// has already been started, so a stop mid-clip is ignored rather than obeyed.
			const video = playbackRef.current?.video;
			if (!video) return;
			const sourceMs = video.currentTime * 1000;
			const placed = sequenceRef.current.clips.find((clip) => clip.id === clipId);
			const lastEnd = placed?.segments[placed.segments.length - 1]?.endMs ?? 0;
			if (video.ended || sourceMs >= lastEnd - 250) {
				applyStep(stepRecording(sequenceRef.current, clipId, sourceMs, true));
			}
		},
		[applyStep],
	);

	// A card has no video to report time; count it.
	const currentIsCard = currentEntry?.clip.kind === "card";
	useEffect(() => {
		if (!isPlaying || !currentIsCard) return;
		let frame = 0;
		let last = performance.now();
		const tick = (now: number) => {
			const clipId = currentClipIdRef.current;
			if (!clipId) return;
			const next = timelineRef.current + (now - last);
			last = now;
			applyStep(stepCard(sequenceRef.current, clipId, next));
			if (playingRef.current) frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [isPlaying, currentIsCard, applyStep]);

	const seek = useCallback(
		(ms: number) => {
			const target = resolveTimelinePosition(sequenceRef.current, ms);
			if (!target) return;
			const sameClip = target.clipId === currentClipIdRef.current;
			moveTimeline(target.timelineMs);
			if (sameClip && readyClipRef.current === target.clipId) cueRecording(target.sourceMs);
			// Another clip: the player for it cues itself when it mounts.
		},
		[moveTimeline, cueRecording],
	);

	const togglePlay = useCallback(() => {
		if (playingRef.current) {
			setPlaying(false);
			playbackRef.current?.pause();
			return;
		}
		const seq = sequenceRef.current;
		if (seq.durationMs <= 0) return;
		setPlaying(true);
		const atEnd = timelineRef.current >= seq.durationMs - 1;
		if (atEnd) {
			seek(0);
			return;
		}
		const here = resolveTimelinePosition(seq, timelineRef.current);
		if (here && readyClipRef.current === here.clipId) cueRecording(here.sourceMs);
	}, [cueRecording, seek, setPlaying]);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			const target = event.target;
			if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
			if (event.key === " ") {
				event.preventDefault();
				event.stopPropagation();
				togglePlay();
			} else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", handleKeyDown, { capture: true });
		return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
	}, [togglePlay, onClose]);

	const recording = currentEntry?.clip.kind === "recording" ? currentEntry.clip.recording : null;
	const annotationRegions = useMemo(
		() => (recording?.annotationRegions ?? []).filter((region) => region.type !== "blur"),
		[recording],
	);
	const blurRegions = useMemo(
		() => (recording?.annotationRegions ?? []).filter((region) => region.type === "blur"),
		[recording],
	);

	return (
		<div
			className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-[#09090b]"
			data-testid="testId-sequence-preview"
			data-clip-id={currentEntry?.id ?? ""}
			data-timeline-ms={Math.round(timelineMs)}
			data-playing={isPlaying ? "true" : "false"}
		>
			<div className="flex min-h-0 w-full flex-auto items-center justify-center px-4 pt-4">
				<div
					className="relative box-border flex h-full w-auto max-w-full items-center justify-center"
					style={{ aspectRatio: String(frameAspectRatio) }}
				>
					{!ready && <span className="text-xs text-slate-400">{t("clips.sequencePreparing")}</span>}
					{ready && currentEntry?.clip.kind === "card" && (
						<CardFrame title={currentEntry.clip.card.title} aspectRatio={frameAspectRatio} />
					)}
					{ready && recording && currentEntry && (
						<VideoPlayback
							key={currentEntry.id}
							ref={playbackRef}
							{...look}
							nativeAspectRatio={frameAspectRatio}
							videoPath={recording.videoUrl}
							webcamVideoPath={recording.webcamVideoUrl}
							zoomRegions={recording.zoomRegions}
							trimRegions={recording.trimRegions}
							speedRegions={recording.speedRegions}
							cropRegion={recording.cropRegion}
							annotationRegions={annotationRegions}
							blurRegions={blurRegions}
							cursorRecordingData={recording.cursorRecordingData}
							cursorTelemetry={recording.cursorTelemetry}
							cursorClickTimestamps={recording.cursorClickTimestamps}
							showCursor={Boolean(look.showCursor && recording.cursorRecordingData)}
							currentTime={sourceSeconds}
							isPlaying={isPlaying}
							onTimeUpdate={handleSourceTime}
							onPlayStateChange={handlePlayState}
							onVideoReady={handleVideoReady}
							onDurationChange={noop}
							onError={noop}
							selectedZoomId={null}
							onSelectZoom={noop}
							onZoomFocusChange={noop}
						/>
					)}
				</div>
			</div>

			<div className="flex w-full max-w-[760px] flex-shrink-0 items-center gap-2 px-4 py-2">
				<Button
					variant="ghost"
					size="sm"
					onClick={togglePlay}
					disabled={!ready}
					aria-label={isPlaying ? t("clips.sequencePause") : t("clips.sequencePlay")}
					title={isPlaying ? t("clips.sequencePause") : t("clips.sequencePlay")}
					className="h-8 w-8 shrink-0 p-0"
					data-testid="testId-sequence-play"
				>
					{isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
				</Button>
				<span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-400">
					{formatTime(timelineMs)} / {formatTime(sequence.durationMs)}
				</span>
				<div className="min-w-0 flex-1">
					{ready && entries && (
						<SequenceBar
							sequence={sequence}
							entries={entries}
							activeClipId={activeClipId}
							timelineMs={timelineMs}
							onSeek={seek}
						/>
					)}
				</div>
				{currentEntry?.clip.kind === "recording" && currentEntry.id !== activeClipId && (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onEditRecording(currentEntry.id)}
						className="h-8 shrink-0 gap-1 text-xs"
						data-testid="testId-sequence-edit-recording"
					>
						<Pencil className="h-3.5 w-3.5" />
						{t("clips.sequenceEditRecording")}
					</Button>
				)}
				<Button
					variant="ghost"
					size="sm"
					onClick={onClose}
					className="h-8 shrink-0 gap-1 text-xs"
					data-testid="testId-sequence-close"
				>
					<X className="h-3.5 w-3.5" />
					{t("clips.sequenceClose")}
				</Button>
			</div>
		</div>
	);
}
