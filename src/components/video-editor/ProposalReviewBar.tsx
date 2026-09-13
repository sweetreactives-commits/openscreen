import { Check, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useScopedT } from "@/contexts/I18nContext";

/**
 * The review step for an agent's edits.
 *
 * Without it an agent's changes are indistinguishable from the user's own once
 * applied. The dashed regions on the timeline say which ones are proposals; this
 * says how many and offers the two answers.
 *
 * Renders nothing when there is nothing to review, so it costs no space in the
 * ordinary case.
 */

interface ProposalReviewBarProps {
	count: number;
	onAccept: () => void;
	onDiscard: () => void;
}

export function ProposalReviewBar({ count, onAccept, onDiscard }: ProposalReviewBarProps) {
	const t = useScopedT("timeline");

	if (count < 1) return null;

	return (
		<div className="flex items-center justify-between gap-3 border-b border-[#34B27B]/25 bg-[#34B27B]/10 px-3 py-1.5">
			<div className="flex min-w-0 items-center gap-2">
				<Sparkles className="h-3.5 w-3.5 shrink-0 text-[#34B27B]" />
				<span className="truncate text-xs text-slate-200">
					{t("proposals.pending", { count: String(count) })}
				</span>
			</div>

			<div className="flex shrink-0 items-center gap-1.5">
				<Button variant="ghost" size="sm" onClick={onDiscard} className="h-7 gap-1 text-xs">
					<X className="h-3.5 w-3.5" />
					{t("proposals.discardAll")}
				</Button>
				<Button size="sm" onClick={onAccept} className="h-7 gap-1 text-xs">
					<Check className="h-3.5 w-3.5" />
					{t("proposals.acceptAll")}
				</Button>
			</div>
		</div>
	);
}
