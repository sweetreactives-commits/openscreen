import { HelpCircle, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useScopedT } from "@/contexts/I18nContext";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import { FIXED_SHORTCUTS, formatBinding, SHORTCUT_ACTIONS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { BLUR_REGIONS_ENABLED } from "./featureFlags";

const PANEL_WIDTH = 256;
/** Space between the trigger and the panel, and from the window edge. */
const GAP = 8;
/** Long enough to cross the gap into the panel, short enough not to linger. */
const CLOSE_DELAY_MS = 120;

/**
 * The shortcut list, shown on hover.
 *
 * It hangs in a portal rather than beside the trigger, because the trigger lives
 * in the inspector's mode rail — a 44px column inside a panel that clips its
 * overflow, which left the list drawn inside the rail and effectively invisible.
 * The position is measured from the trigger and fixed to the viewport, so the
 * panel is bound by the window rather than by whatever encloses the button.
 */
export function KeyboardShortcutsHelp({ triggerClassName }: { triggerClassName?: string }) {
	const { shortcuts, isMac, openConfig } = useShortcuts();
	const t = useScopedT("shortcuts");
	const triggerRef = useRef<HTMLDivElement | null>(null);
	const closeTimerRef = useRef<number | null>(null);
	const [anchor, setAnchor] = useState<{ right: number; bottom: number; maxHeight: number } | null>(
		null,
	);

	const cancelClose = useCallback(() => {
		if (closeTimerRef.current !== null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	}, []);

	const open = useCallback(() => {
		cancelClose();
		const rect = triggerRef.current?.getBoundingClientRect();
		if (!rect) return;
		// To the left of the rail, and rising from the trigger's own bottom edge:
		// it sits low in the window, where a panel hung downward would be cut off.
		setAnchor({
			right: Math.max(GAP, window.innerWidth - rect.left + GAP),
			bottom: Math.max(GAP, window.innerHeight - rect.bottom),
			maxHeight: Math.max(160, rect.bottom - 2 * GAP),
		});
	}, [cancelClose]);

	const scheduleClose = useCallback(() => {
		cancelClose();
		closeTimerRef.current = window.setTimeout(() => setAnchor(null), CLOSE_DELAY_MS);
	}, [cancelClose]);

	useEffect(() => cancelClose, [cancelClose]);

	const panel = anchor ? (
		<div
			// Hovering the panel keeps it open; the trigger below owns the interaction.
			onMouseEnter={cancelClose}
			onMouseLeave={scheduleClose}
			style={{
				position: "fixed",
				right: anchor.right,
				bottom: anchor.bottom,
				width: PANEL_WIDTH,
				maxHeight: anchor.maxHeight,
			}}
			className="z-[200] overflow-y-auto rounded-lg border border-white/10 bg-[#09090b] p-3 shadow-xl"
		>
			<div className="flex items-center justify-between mb-2">
				<span className="text-xs font-semibold text-slate-200">{t("title")}</span>
				<button
					type="button"
					onClick={openConfig}
					title="Customize shortcuts"
					className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-[#34B27B] transition-colors"
				>
					<Settings2 className="w-3 h-3" />
					{t("customize")}
				</button>
			</div>

			<div className="space-y-1.5 text-[10px]">
				{SHORTCUT_ACTIONS.filter((action) => BLUR_REGIONS_ENABLED || action !== "addBlur").map(
					(action) => (
						<div key={action} className="flex items-center justify-between">
							<span className="text-slate-400">{t(`actions.${action}`)}</span>
							<kbd className="px-1 py-0.5 bg-white/5 border border-white/10 rounded text-[#34B27B] font-mono">
								{formatBinding(shortcuts[action], isMac)}
							</kbd>
						</div>
					),
				)}

				<div className="pt-1 border-t border-white/5 mt-1 space-y-1.5">
					{FIXED_SHORTCUTS.map((fixed) => (
						<div key={fixed.i18nKey} className="flex items-center justify-between">
							<span className="text-slate-400">
								{t(`fixedActions.${fixed.i18nKey}`, { defaultValue: fixed.label })}
							</span>
							<kbd className="px-1 py-0.5 bg-white/5 border border-white/10 rounded text-[#34B27B] font-mono">
								{isMac
									? fixed.display.replace(/Ctrl/g, "⌘").replace(/Shift/g, "⇧").replace(/Alt/g, "⌥")
									: fixed.display}
							</kbd>
						</div>
					))}
				</div>
			</div>
		</div>
	) : null;

	return (
		<div
			ref={triggerRef}
			onMouseEnter={open}
			onMouseLeave={scheduleClose}
			className={cn("relative", triggerClassName)}
		>
			<HelpCircle
				className={cn(
					"w-4 h-4 transition-colors cursor-help",
					anchor ? "text-[#34B27B]" : "text-slate-500",
				)}
			/>
			{panel && createPortal(panel, document.body)}
		</div>
	);
}
