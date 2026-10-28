import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { Job } from "@cohort/shared";
import { api } from "../../api.ts";
import { JobStatusPill } from "../../components/Pills.tsx";
import { timeAgo } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { useProject } from "./ProjectLayout.tsx";

const isActive = (job: Job) => job.status === "queued" || job.status === "running";

// Latest agent job for an issue, with live status while it's active.
export function AgentPanel({ issueNumber, onChange }: { issueNumber: number; onChange: () => void }) {
  const { project, base } = useProject();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasActive = useRef(false);
  const { data, reload } = useApi<{ jobs: Job[] }>(
    `/api/projects/${project.workspace}/${project.slug}/issues/${issueNumber}/jobs`,
    { pollMs: 2000, poll: (d) => d.jobs.some(isActive) },
  );
  const job = data?.jobs[0];

  // When a job finishes, the issue's status and comments change too.
  const active = job ? isActive(job) : false;
  useEffect(() => {
    if (wasActive.current && !active) onChange();
    wasActive.current = active;
  }, [active, onChange]);

  if (!job) return null;

  async function act(action: "cancel" | "retry") {
    setBusy(true);
    try {
      await api(`/api/jobs/${job!.id}/${action}`, { method: "POST" });
      setError(null);
      await reload();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel agent-panel">
      <div className="row spread">
        <div className="row wrap">
          <strong>{job.bot}</strong>
          <JobStatusPill status={job.status} />
          <Link to={`${base}/jobs/${job.id}`} className="small">
            Job #{job.id} log
          </Link>
        </div>
        <div className="row">
          {isActive(job) && (
            <button className="secondary small" disabled={busy} onClick={() => act("cancel")}>
              Cancel
            </button>
          )}
          {(job.status === "failed" || job.status === "canceled") && (
            <button className="secondary small" disabled={busy} onClick={() => act("retry")}>
              Retry
            </button>
          )}
        </div>
      </div>
      <div className="muted small">
        {job.status === "queued" && (job.waitingReason ?? "Waiting for a runner")}
        {job.status === "running" && `Working on ${job.branch} on ${job.runner ?? "a runner"} · started ${timeAgo(job.startedAt!)}`}
        {job.status === "succeeded" && (
          <>
            Finished {timeAgo(job.finishedAt!)}
            {job.mergeRequest && (
              <>
                {" · "}
                <Link to={`${base}/merge_requests/${job.mergeRequest}`}>!{job.mergeRequest}</Link>
              </>
            )}
          </>
        )}
        {job.status === "failed" && job.error}
        {job.status === "canceled" && `Canceled ${timeAgo(job.finishedAt!)}`}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
