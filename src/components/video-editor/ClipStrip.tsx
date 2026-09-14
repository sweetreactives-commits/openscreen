import { ChevronLeft, ChevronRight, Clapperboard, Plus, Type, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useScopedT } from "@/contexts/I18nContext";
import { drawCardFrame } from "@/lib/cardFrame";
import type { ClipEntry } from "./clips";
import {
	DEFAULT_CARD_DURATION_MS,
	MAX_CARD_DURATION_MS,
	MIN_CARD_DURATION_MS,
} from "./projectPersistence";

/**
 * The project's clips as a strip, and the editor for the selected card.
 *
 * Deliberately not on the timeline's own axis. That axis is the recording's
 * clock, and a card sits outside it — putting the two on one ruler is the
 * sequence-wide preview work of stage 5. Until then this shows the order, which
 * is what a card is actually about, and the timeline below keeps showing the
 * recording's own time.
 */

interface ClipStripProps {
	clips: ClipEntry[];
	selectedCardId: string | null;
	onSelectCard: (id: string | null) => void;
	onAddIntro: () => void;
	onAddOutro: () => void;
	onRemoveCard: (id: string) => void;
	onMoveClip: (id: string, toIndex: number) => void;
	onUpdateCard: (id: string, patch: { title?: string; durationMs?: number }) => void;
	onCommitCard: () => void;
}

/** What the card will look like, drawn by the same code the exporter uses. */
function CardThumbnail({ title }: { title?: string }) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;
		drawCardFrame(ctx, { width: canvas.width, height: canvas.height, title });
	}, [title]);

	return (
		<canvas
			ref={canvasRef}
			width={320}
			height={180}
			className="h-[90px] w-40 shrink-0 rounded-md border border-white/10"
		/>
	);
}

export function ClipStrip({
	clips,
	selectedCardId,
	onSelectCard,
	onAddIntro,
	onAddOutro,
	onRemoveCard,
	onMoveClip,
	onUpdateCard,
	onCommitCard,
}: ClipStripProps) {
	const t = useScopedT("timeline");
	const selected = clips.find((clip) => clip.id === selectedCardId && clip.kind === "card") ?? null;

	return (
		<div className="border-b border-white/10 bg-white/[0.02]">
			<div className="flex items-center gap-1.5 overflow-x-auto px-3 py-1.5">
				<Button
					variant="ghost"
					size="sm"
					onClick={onAddIntro}
					className="h-7 shrink-0 gap-1 text-xs"
					data-testid="testId-add-intro-card"
				>
					<Plus className="h-3.5 w-3.5" />
					{t("clips.addIntro")}
				</Button>

				<div className="flex min-w-0 items-center gap-1.5">
					{clips.map((clip, index) => {
						const isCard = clip.kind === "card";
						const isSelected = isCard && clip.id === selectedCardId;

						return (
							<div
								key={clip.id}
								className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
									isSelected
										? "border-[#34B27B]/60 bg-[#34B27B]/15 text-slate-100"
										: "border-white/10 bg-white/[0.04] text-slate-300"
								}`}
							>
								{isCard ? (
									<Type className="h-3.5 w-3.5 shrink-0 opacity-70" />
								) : (
									<Clapperboard className="h-3.5 w-3.5 shrink-0 opacity-70" />
								)}

								<button
									type="button"
									disabled={!isCard}
									onClick={() => onSelectCard(isSelected ? null : clip.id)}
									className="max-w-[12rem] truncate disabled:cursor-default"
								>
									{isCard ? clip.title?.trim() || t("clips.untitled") : t("clips.recording")}
								</button>

								{index > 0 && (
									<button
										type="button"
										onClick={() => onMoveClip(clip.id, index - 1)}
										title={t("clips.moveEarlier")}
										aria-label={t("clips.moveEarlier")}
										className="opacity-50 transition-opacity hover:opacity-100"
									>
										<ChevronLeft className="h-3.5 w-3.5" />
									</button>
								)}
								{index < clips.length - 1 && (
									<button
										type="button"
										onClick={() => onMoveClip(clip.id, index + 1)}
										title={t("clips.moveLater")}
										aria-label={t("clips.moveLater")}
										className="opacity-50 transition-opacity hover:opacity-100"
									>
										<ChevronRight className="h-3.5 w-3.5" />
									</button>
								)}
								{isCard && (
									<button
										type="button"
										onClick={() => onRemoveCard(clip.id)}
										title={t("clips.remove")}
										aria-label={t("clips.remove")}
										className="opacity-50 transition-opacity hover:text-red-400 hover:opacity-100"
									>
										<X className="h-3.5 w-3.5" />
									</button>
								)}
							</div>
						);
					})}
				</div>

				<Button
					variant="ghost"
					size="sm"
					onClick={onAddOutro}
					className="h-7 shrink-0 gap-1 text-xs"
					data-testid="testId-add-outro-card"
				>
					<Plus className="h-3.5 w-3.5" />
					{t("clips.addOutro")}
				</Button>
			</div>

			{selected && (
				<div
					className="flex items-start gap-3 border-t border-white/10 px-3 py-2"
					data-testid="testId-card-editor"
				>
					<CardThumbnail title={selected.title} />

					<div className="flex min-w-0 flex-1 flex-col gap-2">
						<label className="flex flex-col gap-1 text-[11px] text-slate-400">
							{t("clips.title")}
							<input
								type="text"
								value={selected.title ?? ""}
								onChange={(event) => onUpdateCard(selected.id, { title: event.target.value })}
								onBlur={onCommitCard}
								data-testid="testId-card-title-input"
								className="w-full rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-xs text-slate-100 outline-none focus:border-[#34B27B]/60"
							/>
						</label>

						<label className="flex flex-col gap-1 text-[11px] text-slate-400">
							{t("clips.duration", {
								seconds: ((selected.durationMs ?? DEFAULT_CARD_DURATION_MS) / 1000).toFixed(1),
							})}
							<input
								type="range"
								min={MIN_CARD_DURATION_MS}
								max={MAX_CARD_DURATION_MS}
								step={100}
								value={selected.durationMs ?? DEFAULT_CARD_DURATION_MS}
								onChange={(event) =>
									onUpdateCard(selected.id, { durationMs: Number(event.target.value) })
								}
								onPointerUp={onCommitCard}
								onKeyUp={onCommitCard}
								data-testid="testId-card-duration-input"
								className="w-full accent-[#34B27B]"
							/>
						</label>
					</div>
				</div>
			)}
		</div>
	);
}
