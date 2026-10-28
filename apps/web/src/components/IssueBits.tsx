import { Link } from "react-router";
import { STATUS_LABELS, type IssueRef, type IssueStatus, type IssueSummary, type Label } from "@cohort/shared";
import { timeAgo } from "../format.ts";
import { StatusPill, type Tone } from "./StatusPill.tsx";
import { Actor } from "./Agent.tsx";

const ISSUE_TONES: Record<IssueStatus, Tone> = {
  todo: "idle",
  in_progress: "running",
  review: "waiting",
  done: "passed",
  blocked: "failed",
};

export function StatusBadge({ status }: { status: IssueStatus }) {
  return <StatusPill tone={ISSUE_TONES[status]} label={STATUS_LABELS[status]} />;
}

export function LabelChip({ label, onRemove }: { label: Pick<Label, "name" | "color">; onRemove?: () => void }) {
  return (
    <span className="label" style={{ "--label": label.color } as React.CSSProperties}>
      {label.name}
      {onRemove && (
        <button className="label-x" onClick={onRemove} aria-label={`Remove ${label.name}`}>
          ×
        </button>
      )}
    </span>
  );
}

// Link to an issue; `base` is "/<workspace>/<project>".
export function IssueLink({ base, issue }: { base: string; issue: IssueRef }) {
  return (
    <Link to={`${base}/issues/${issue.number}`} className={issue.status === "done" ? "done-link" : undefined}>
      #{issue.number} {issue.title}
    </Link>
  );
}

export function IssueRow({ issue, showProject }: { issue: IssueSummary; showProject?: boolean }) {
  const base = `/${issue.project}`;
  return (
    <li className="list-row issue-row">
      <div className="issue-main">
        <div className="issue-title">
          <Link to={`${base}/issues/${issue.number}`} data-row>
            {issue.title}
          </Link>
          {issue.labels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
        <div className="muted small">
          {showProject ? `${issue.project}#${issue.number}` : `#${issue.number}`} · updated {timeAgo(issue.updatedAt)}
          {issue.parent !== null && <> · part of #{issue.parent}</>}
          {issue.children > 0 && <> · {issue.children} sub-issues</>}
          {issue.waitingOn > 0 && <> · waiting on {issue.waitingOn}</>}
          {issue.comments > 0 && <> · {issue.comments} comments</>}
        </div>
      </div>
      <div className="issue-meta">
        {issue.assignee && (
          <span className="muted small">
            <Actor name={issue.assignee.username} bot={issue.assignee.kind === "bot"} />
          </span>
        )}
        <StatusBadge status={issue.status} />
      </div>
    </li>
  );
}
