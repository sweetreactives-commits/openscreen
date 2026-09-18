import { FilePlus, Film, MousePointer2, Trash2, Video } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useScopedT } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";
import { toFileUrl } from "./projectPersistence";

/**
 * Everything recorded so far, as a list rather than a folder.
 *
 * Reaching an earlier take meant an OS file dialog and reading filenames, and
 * throwing one away meant leaving the app entirely — which also meant deleting
 * the video and leaving its telemetry and manifest behind. Here a take is one
 * row: what it is, what it cost, and the two things worth doing to it.
 */

type LibraryEntry = Awaited<
	ReturnType<typeof window.electronAPI.listRecordings>
>["entries"][number];

interface RecordingsLibraryProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Adds the take to the open project as another recording. */
	onInsert: (path: string) => void;
}

function formatSize(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * A frame from the take.
 *
 * `preload="metadata"` alone leaves most players on a blank first frame, so the
 * source carries a fragment asking for a moment slightly in — far enough to be
 * past a fade-in, cheap enough not to decode the file.
 */
function EntryThumbnail({ path }: { path: string }) {
	return (
		<video
			src={`${toFileUrl(path)}#t=0.5`}
			preload="metadata"
			muted
			playsInline
			tabIndex={-1}
			className="h-12 w-20 shrink-0 rounded-md border border-white/10 bg-black object-cover"
		/>
	);
}

export function RecordingsLibrary({ open, onOpenChange, onInsert }: RecordingsLibraryProps) {
	const t = useScopedT("editor");
	const [entries, setEntries] = useState<LibraryEntry[]>([]);
	const [loading, setLoading] = useState(false);
	/** The take whose delete button was pressed once; pressing again confirms. */
	const [pendingDelete, setPendingDelete] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		if (!window.electronAPI?.listRecordings) return;
		setLoading(true);
		try {
			const result = await window.electronAPI.listRecordings();
			setEntries(result.success ? result.entries : []);
			if (!result.success) toast.error(t("library.loadFailed"));
		} finally {
			setLoading(false);
		}
	}, [t]);

	useEffect(() => {
		if (!open) {
			setPendingDelete(null);
			return;
		}
		void refresh();
	}, [open, refresh]);

	const handleInsert = useCallback(
		(entry: LibraryEntry) => {
			onInsert(entry.path);
			onOpenChange(false);
			toast.success(t("library.inserted", { name: entry.name }));
		},
		[onInsert, onOpenChange, t],
	);

	const handleDelete = useCallback(
		async (entry: LibraryEntry) => {
			if (pendingDelete !== entry.name) {
				setPendingDelete(entry.name);
				return;
			}
			setPendingDelete(null);
			const result = await window.electronAPI.deleteRecording(entry.name);
			if (!result.success) {
				toast.error(t("library.deleteFailed"));
				return;
			}
			toast.success(t("library.deleted", { name: entry.name }));
			await refresh();
		},
		[pendingDelete, refresh, t],
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Film className="h-4 w-4 text-[#34B27B]" />
						{t("library.title")}
					</DialogTitle>
				</DialogHeader>

				{loading && (
					<p className="py-8 text-center text-sm text-slate-400">{t("library.loading")}</p>
				)}

				{!loading && entries.length === 0 && (
					<div className="py-8 text-center">
						<p className="text-sm text-slate-300">{t("library.emptyTitle")}</p>
						<p className="mt-1 text-xs text-slate-500">{t("library.emptyDescription")}</p>
					</div>
				)}

				{!loading && entries.length > 0 && (
					<div className="max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
						{entries.map((entry) => {
							const confirming = pendingDelete === entry.name;
							return (
								<div
									key={entry.name}
									className="flex items-center gap-3 rounded-lg border border-white/[0.07] bg-white/[0.03] p-2"
								>
									<EntryThumbnail path={entry.path} />

									<div className="flex min-w-0 flex-1 flex-col gap-0.5">
										<span className="truncate text-xs font-medium text-slate-200">
											{entry.name}
										</span>
										<span className="text-[11px] text-slate-500">
											{new Date(entry.modifiedAtMs).toLocaleString()} ·{" "}
											{formatSize(entry.sizeBytes)}
										</span>
										<div className="flex items-center gap-2 text-[10px] text-slate-500">
											{entry.hasWebcam && (
												<span className="flex items-center gap-1">
													<Video className="h-3 w-3" />
													{t("library.withWebcam")}
												</span>
											)}
											{entry.hasCursorData && (
												<span className="flex items-center gap-1">
													<MousePointer2 className="h-3 w-3" />
													{t("library.withCursor")}
												</span>
											)}
										</div>
									</div>

									<Button
										size="sm"
										variant="ghost"
										onClick={() => handleInsert(entry)}
										className="h-8 shrink-0 gap-1.5 text-xs"
									>
										<FilePlus className="h-3.5 w-3.5" />
										{t("library.insert")}
									</Button>

									<Button
										size="sm"
										variant="ghost"
										onClick={() => void handleDelete(entry)}
										onBlur={() => confirming && setPendingDelete(null)}
										title={t("library.deleteHint")}
										className={cn(
											"h-8 shrink-0 gap-1.5 text-xs",
											confirming
												? "bg-red-500/20 text-red-300"
												: "text-red-400/80 hover:bg-red-500/10 hover:text-red-300",
										)}
									>
										<Trash2 className="h-3.5 w-3.5" />
										{confirming ? t("library.deleteConfirm") : t("library.delete")}
									</Button>
								</div>
							);
						})}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
