import { Link } from "react-router";
import type { Outcome } from "@cohort/shared";
import { formatCost, plural, timeAgo } from "../format.ts";
import { AgentName } from "./Agent.tsx";
import { StatusPill } from "./StatusPill.tsx";

// What finished: merged with its evidence, or failed/stopped with the reason.
export function OutcomeRow({ outcome }: { outcome: Outcome }) {
  const e = outcome.evidence;
  const evidence = e
    ? [
        plural(e.files, "file"),
        `+${e.additions} −${e.deletions}`,
        e.checksPassed + e.checksFailed > 0 ? `${e.checksPassed} checks passed${e.checksFailed ? ` · ${e.checksFailed} failed` : ""}` : "no checks ran",
      ].join(" · ")
    : outcome.detail;
  return (
    <li className="outcome-row">
      {outcome.kind === "merged" ? (
        <StatusPill tone="passed" label="Merged" />
      ) : outcome.kind === "failed" ? (
        <StatusPill tone="failed" label="Failed" />
      ) : (
        <StatusPill tone="idle" icon="pause" label="Stopped" />
      )}
      <div className="outcome-main">
        <Link to={outcome.href} className="outcome-title">
          {outcome.title}
        </Link>
        <div className="meta">
          <span className="mono">{outcome.project}</span>
          {outcome.agent && <AgentName name={outcome.agent} />}
          <span>{timeAgo(outcome.at)}</span>
        </div>
      </div>
      <div className="outcome-evidence">
        {evidence && <span>{evidence}</span>}
        {outcome.costUsd !== null && <span className="muted">{formatCost(outcome.costUsd)}</span>}
      </div>
    </li>
  );
}
