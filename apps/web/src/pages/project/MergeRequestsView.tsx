import { Link, useSearchParams } from "react-router";
import type { MergeRequestSummary } from "@cohort/shared";
import { MergeRequestPill } from "../../components/Pills.tsx";
import { timeAgo } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { useProject } from "./ProjectLayout.tsx";
import { SkeletonRows } from "../../components/Skeleton.tsx";
import { ErrorState } from "../../components/States.tsx";

export function MergeRequestsView() {
  const { project, base } = useProject();
  const [search, setSearch] = useSearchParams();
  const status = search.get("status") ?? "open";
  const query = status === "all" ? "" : `?status=${status}`;
  const { data, error } = useApi<{ mergeRequests: MergeRequestSummary[] }>(
    `/api/projects/${project.workspace}/${project.slug}/merge_requests${query}`,
  );

  return (
    <>
      <div className="toolbar spread">
        <div className="segmented">
          {["open", "merged", "closed", "all"].map((s) => (
            <button key={s} className={status === s ? "active" : ""} onClick={() => setSearch(s === "open" ? {} : { status: s })}>
              {s[0]!.toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        {project.defaultBranch && (
          <Link className="button" to={`${base}/merge_requests/new`}>
            New merge request
          </Link>
        )}
      </div>
      {error && <ErrorState what="the merge requests" error={error} />}
      {!data && !error && <SkeletonRows rows={4} height={52} />}
      {data &&
        (data.mergeRequests.length === 0 ? (
          <section className="panel empty">
            <h2>No {status === "all" ? "" : status} merge requests</h2>
            <p className="muted">Agents open one when they finish an issue. You can also open one between any two branches.</p>
          </section>
        ) : (
          <section className="panel flush">
            <ul className="list">
              {data.mergeRequests.map((m) => (
                <li key={m.id} className="list-row">
                  <div>
                    <Link to={`${base}/merge_requests/${m.number}`}>{m.title}</Link>
                    <div className="muted small">
                      !{m.number} · {m.sourceBranch} → {m.targetBranch} · by {m.author.username} · updated {timeAgo(m.updatedAt)}
                      {m.issue && <> · for #{m.issue.number}</>}
                    </div>
                  </div>
                  <MergeRequestPill status={m.status} />
                </li>
              ))}
            </ul>
          </section>
        ))}
    </>
  );
}
