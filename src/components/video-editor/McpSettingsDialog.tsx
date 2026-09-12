import { Check, Copy, Plug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useScopedT } from "@/contexts/I18nContext";

/**
 * Turns the local MCP endpoint on and off, and hands over what a client needs to
 * connect.
 *
 * The connection command is the point of the dialog: the port is picked by the
 * OS and the token is regenerated on every start, so neither can be written down
 * once in a config file.
 */

type McpStatus = Awaited<ReturnType<typeof window.electronAPI.getMcpStatus>>;

export function McpSettingsDialog() {
	const t = useScopedT("settings");
	const [open, setOpen] = useState(false);
	const [status, setStatus] = useState<McpStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);

	const refresh = useCallback(async () => {
		if (!window.electronAPI?.getMcpStatus) return;
		setStatus(await window.electronAPI.getMcpStatus());
	}, []);

	useEffect(() => {
		if (open) void refresh();
	}, [open, refresh]);

	const setMode = useCallback(async (mode: "off" | "read-only" | "full") => {
		if (!window.electronAPI?.setMcpMode) return;
		setBusy(true);
		try {
			setStatus(await window.electronAPI.setMcpMode(mode));
		} finally {
			setBusy(false);
		}
	}, []);

	// Everything a client needs, in the form it needs it.
	const connectCommand =
		status?.url && status.token
			? `claude mcp add --transport http openscreen ${status.url} --header "Authorization: Bearer ${status.token}"`
			: null;

	const copyCommand = useCallback(async () => {
		if (!connectCommand) return;
		try {
			await navigator.clipboard.writeText(connectCommand);
			setCopied(true);
			setTimeout(() => setCopied(false), 2_000);
		} catch {
			toast.error(t("mcp.copyFailed"));
		}
	}, [connectCommand, t]);

	const running = status?.running ?? false;
	const canEdit = status?.mode === "full";

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				title={t("mcp.title")}
				className="text-slate-500 transition-colors hover:text-[#34B27B]"
			>
				<Plug className="h-4 w-4" />
			</button>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-[540px]">
					<DialogHeader>
						<DialogTitle>{t("mcp.title")}</DialogTitle>
					</DialogHeader>

					<div className="space-y-4">
						<p className="text-sm text-slate-400">{t("mcp.description")}</p>

						<div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
							<div>
								<div className="text-sm font-medium text-slate-100">{t("mcp.enable")}</div>
								<div className="text-xs text-slate-500">
									{!running
										? t("mcp.stateOff")
										: canEdit
											? t("mcp.stateFull")
											: t("mcp.stateReadOnly")}
								</div>
							</div>
							<Switch
								checked={running}
								disabled={busy}
								onCheckedChange={(on) => setMode(on ? "read-only" : "off")}
							/>
						</div>

						<p className="text-xs text-slate-500">{t("mcp.exposes")}</p>

						{running && (
							<div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
								<div className="pr-3">
									<div className="text-sm font-medium text-slate-100">{t("mcp.allowEdits")}</div>
									<div className="text-xs text-slate-500">{t("mcp.allowEditsHint")}</div>
								</div>
								<Switch
									checked={canEdit}
									disabled={busy}
									onCheckedChange={(on) => setMode(on ? "full" : "read-only")}
								/>
							</div>
						)}

						{status?.error && (
							<p className="text-xs text-red-400">
								{t("mcp.startFailed", { message: status.error })}
							</p>
						)}

						{running && connectCommand && (
							<div className="space-y-2">
								<div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
									{t("mcp.connect")}
								</div>
								<div className="rounded-lg border border-white/10 bg-black/40 p-2">
									<code className="block break-all font-mono text-[11px] leading-relaxed text-slate-300">
										{connectCommand}
									</code>
								</div>
								<Button variant="outline" size="sm" onClick={copyCommand} className="gap-1.5">
									{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
									{copied ? t("mcp.copied") : t("mcp.copyCommand")}
								</Button>
								<p className="text-xs text-slate-500">{t("mcp.security")}</p>
							</div>
						)}
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
