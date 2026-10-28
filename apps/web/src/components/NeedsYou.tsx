import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Clock, Eye, MessageSquare, Play, RotateCcw, TriangleAlert, type LucideIcon } from "lucide-react";
import type { NeedKind, NeedsYouItem } from "@cohort/shared";
import { api } from "../api.ts";
import { timeAgo } from "../format.ts";
import { AgentName } from "./Agent.tsx";

const ICONS: Record<NeedKind, LucideIcon> = {
  review: Eye,
  pipeline: Play,
  plan: Eye,
  split: Eye,
  failed_job: TriangleAlert,
  workshop: MessageSquare,
  failed_pipeline: TriangleAlert,
};

// One thing waiting on you: what it is, what it needs, how long it's waited, one action.
export function NeedsYouRow({ item, onDone }: { item: NeedsYouItem; onDone: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Icon = ICONS[item.kind];
  const failed = item.kind === "failed_job" || item.kind === "failed_pipeline";

  async function act() {
    if (item.action.method === "link") return navigate(item.href);
    setBusy(true);
    try {
      await api(item.action.url!, { method: "POST" });
      setError(null);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`need-row${failed ? " need-failed" : ""}`}>
      <Icon size={16} className="need-icon" aria-hidden />
      <div className="need-main">
        <Link to={item.href} className="need-title">
          {item.title}
        </Link>
        <div className="need-text">{item.need}</div>
        <div className="meta">
          <span className="mono">{item.project}</span>
          {item.agent && <AgentName name={item.agent} />}
          <span>
            <Clock size={12} aria-hidden /> waiting {timeAgo(item.since).replace(" ago", "")}
          </span>
        </div>
        {error && <div className="error small">{error}</div>}
      </div>
      <button className="secondary" disabled={busy} onClick={act}>
        {item.action.method === "post" && item.action.label === "Retry" && <RotateCcw size={14} aria-hidden />}
        {item.action.label}
      </button>
    </li>
  );
}
