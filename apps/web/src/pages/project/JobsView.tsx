import { Link } from "react-router";
import type { Job } from "@cohort/shared";
import { JOB_KIND_LABELS, JobStatusPill } from "../../components/Pills.tsx";
import { timeAgo } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { useProject } from "./ProjectLayout.tsx";

export function JobsView() {
  const { project, base } = useProject();
  const { data, error } = useApi<{ jobs: Job[] }>(`/api/projects/${project.workspace}/${project.slug}/jobs`, {
    pollMs: 3000,
    poll: (d) => d.jobs.some((j) => j.status === "queued" || j.status === "running"),
  });
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  if (data.jobs.length === 0) {
    return (
      <section className="panel empty">
        <h2>No agent jobs yet</h2>
        <p className="muted">Assign an issue to claude-bot or codex-bot to start one.</p>
      </section>
    );
  }
  return (
    <section className="panel flush">
      <ul className="list">
        {data.jobs.map((j) => (
          <li key={j.id} className="list-row">
            <div>
              <Link to={`${base}/jobs/${j.id}`}>Job #{j.id}</Link> <span className="muted small">{JOB_KIND_LABELS[j.kind]}</span>
              {j.issue && (
                <>
                  {" · "}
                  <Link to={`${base}/issues/${j.issue.number}`}>
                    #{j.issue.number} {j.issue.title}
                  </Link>
                </>
              )}
              <div className="muted small">
                {j.bot}
                {j.branch && ` · ${j.branch}`} · created {timeAgo(j.createdAt)}
                {j.status === "queued" && j.waitingReason && <> · {j.waitingReason}</>}
              </div>
            </div>
            <JobStatusPill status={j.status} />
          </li>
        ))}
      </ul>
    </section>
  );
}
