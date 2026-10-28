import { Link } from "react-router";
import { GitBranch, Plus } from "lucide-react";
import type { RepoSummary } from "@cohort/shared";
import { PipelineStatusPill } from "../components/PipelineBits.tsx";
import { SkeletonRows } from "../components/Skeleton.tsx";
import { plural, timeAgo } from "../format.ts";
import { useApi } from "../hooks.ts";

// Find a repo and see its health: last commit, open work, running agents, main's pipeline.
export function ReposPage() {
  const { data, error, reload } = useApi<{ repos: RepoSummary[] }>("/api/repos", { pollMs: 10_000 });
  const workspaces = [...new Set(data?.repos.map((r) => r.workspace) ?? [])];

  return (
    <>
      <div className="page-head">
        <h1>Repos</h1>
        <Link className="button secondary" to="/new">
          <Plus size={14} aria-hidden /> New workspace
        </Link>
      </div>
      {error && (
        <div className="panel">
          <p className="error">Couldn't load your repos: {error}</p>
          <button className="secondary" onClick={reload}>
            Try again
          </button>
        </div>
      )}
      {!data ? (
        <SkeletonRows rows={4} height={64} />
      ) : data.repos.length === 0 ? (
        <section className="panel empty">
          <h2>No repos yet.</h2>
          <p className="muted">Create a workspace, then add a repo to it or push an existing one.</p>
          <Link className="button" to="/new">
            Create a workspace
          </Link>
        </section>
      ) : (
        workspaces.map((w) => (
          <section key={w} className="section">
            <div className="row spread">
              <h2>
                <Link to={`/${w}`} className="muted">
                  {w}
                </Link>
              </h2>
              <Link to={`/${w}`} className="small">
                <Plus size={12} aria-hidden /> New repo
              </Link>
            </div>
            <ul className="repo-list">
              {data.repos
                .filter((r) => r.workspace === w)
                .map((r) => (
                  <li key={r.slug}>
                    <div className="repo-main">
                      <Link to={`/${r.workspace}/${r.slug}`} className="repo-name" data-row>
                        {r.name}
                      </Link>
                      {r.description && <span className="muted">{r.description}</span>}
                      <div className="meta">
                        {r.defaultBranch ? (
                          <span className="mono">
                            <GitBranch size={12} aria-hidden /> {r.defaultBranch}
                          </span>
                        ) : (
                          <span>Empty: push to get started</span>
                        )}
                        {r.lastCommit && (
                          <span>
                            {r.lastCommit.subject} · {timeAgo(r.lastCommit.date)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="repo-health">
                      {r.pipeline && <PipelineStatusPill status={r.pipeline} />}
                      <span className="muted small">
                        {[
                          r.openIssues && plural(r.openIssues, "open issue"),
                          r.openMergeRequests && plural(r.openMergeRequests, "MR"),
                          r.runningJobs && `${plural(r.runningJobs, "agent")} working`,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "No open work"}
                      </span>
                    </div>
                  </li>
                ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}
