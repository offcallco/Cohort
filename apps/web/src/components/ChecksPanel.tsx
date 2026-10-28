import { Link } from "react-router";
import { Clock } from "lucide-react";
import type { PipelineDetail, PipelineSummary } from "@cohort/shared";
import { useApi } from "../hooks.ts";
import { PipelineStatusPill } from "./PipelineBits.tsx";

const duration = (from: string | null, to: string | null) =>
  from && to ? `${Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000))}s` : null;

// Every check with pass/fail, duration and a link to its log. Failures show what failed.
export function ChecksPanel({ project, pipeline, onRun }: { project: string; pipeline: PipelineSummary | null; onRun?: () => void }) {
  const detail = useApi<{ pipeline: PipelineDetail }>(pipeline ? `/api/projects/${project}/pipelines/${pipeline.id}` : null, {
    pollMs: 2500,
    poll: (d) => d.pipeline.status === "pending" || d.pipeline.status === "running",
  }).data?.pipeline;
  const base = `/${project}`;

  return (
    <aside className="checks-panel" aria-label="Checks">
      <h2>Checks</h2>
      {!pipeline ? (
        <p className="muted small">No pipeline ran for this commit. Add a .cohort-ci.yml to test every change.</p>
      ) : (
        <>
          <div className="row wrap">
            <PipelineStatusPill status={(detail ?? pipeline).status} />
            <Link to={`${base}/pipelines/${pipeline.id}`} className="small">
              Pipeline #{pipeline.id}
            </Link>
          </div>
          {(detail ?? pipeline).status === "manual" && (
            <div className="stack">
              <p className="muted small">It runs commands from the agent's changes on your runner, so it waits for you to start it.</p>
              {onRun && (
                <button className="secondary small" onClick={onRun}>
                  Run pipeline
                </button>
              )}
            </div>
          )}
          {pipeline.error && <p className="error small">{pipeline.error}</p>}
          <ul className="check-list">
            {detail?.jobs.map((j) => (
              <li key={j.id}>
                <PipelineStatusPill status={j.status} />
                <Link className="mono small" to={`${base}/pipelines/${pipeline.id}?job=${j.id}`}>
                  {j.name}
                </Link>
                {duration(j.startedAt, j.finishedAt) && (
                  <span className="muted small">
                    <Clock size={12} aria-hidden /> {duration(j.startedAt, j.finishedAt)}
                  </span>
                )}
                {j.allowFailure && <span className="muted small">allowed to fail</span>}
                {j.status === "failed" && (j.excerpt || j.error) && <pre className="check-excerpt">{j.excerpt ?? j.error}</pre>}
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
