import { Link, useSearchParams } from "react-router";
import type { ActivityEntry, RepoSummary } from "@cohort/shared";
import { Actor } from "../components/Agent.tsx";
import { SkeletonRows } from "../components/Skeleton.tsx";
import { ErrorState } from "../components/States.tsx";
import { timeAgo } from "../format.ts";
import { useApi } from "../hooks.ts";

// The audit trail: who or what changed what, and when. Newest first.
export function ActivityPage() {
  const [search, setSearch] = useSearchParams();
  const actor = search.get("actor") ?? "";
  const project = search.get("project") ?? "";
  const params = new URLSearchParams();
  if (actor) params.set("actor", actor);
  if (project) params.set("project", project);
  const { data, error, reload } = useApi<{ entries: ActivityEntry[] }>(`/api/activity?${params}`, { pollMs: 10_000 });
  const repos = useApi<{ repos: RepoSummary[] }>("/api/repos").data?.repos ?? [];

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearch(next, { replace: true });
  };

  // Group by day so the trail is easy to scan.
  const days = new Map<string, ActivityEntry[]>();
  for (const e of data?.entries ?? []) {
    const day = new Date(e.at).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    days.set(day, [...(days.get(day) ?? []), e]);
  }

  return (
    <>
      <h1>Activity</h1>
      <div className="toolbar">
        <div className="chips" role="group" aria-label="Who">
          {[
            ["", "Everyone"],
            ["people", "People"],
            ["agents", "Agents"],
          ].map(([key, label]) => (
            <button key={key} className={`chip${actor === key ? " active" : ""}`} aria-pressed={actor === key} onClick={() => set("actor", key!)}>
              {label}
            </button>
          ))}
        </div>
        {repos.length > 1 && (
          <select value={project} onChange={(e) => set("project", e.target.value)} aria-label="Repo">
            <option value="">All repos</option>
            {repos.map((r) => (
              <option key={`${r.workspace}/${r.slug}`} value={`${r.workspace}/${r.slug}`}>
                {r.workspace}/{r.slug}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <ErrorState what="the activity" error={error} onRetry={reload} />}
      {!data && !error ? (
        <SkeletonRows rows={6} height={40} />
      ) : data && data.entries.length === 0 ? (
        <section className="panel empty">
          <h2>No activity{actor || project ? " matches" : " yet"}.</h2>
          <p className="muted">Issues, agent runs, merges and pipelines show up here as they happen.</p>
        </section>
      ) : (
        [...days].map(([day, entries]) => (
          <section key={day} className="section">
            <h2 className="muted">{day}</h2>
            <ol className="activity-list">
              {entries.map((e, n) => (
                <li key={n}>
                  <span className="muted small activity-time">{timeAgo(e.at)}</span>
                  <div className="activity-main">
                    <Actor name={e.actor} bot={e.bot} />{" "}
                    {e.href ? (
                      <Link to={e.href} data-row>
                        {e.text}
                      </Link>
                    ) : (
                      e.text
                    )}
                  </div>
                  <span className="mono muted small">{e.project}</span>
                </li>
              ))}
            </ol>
          </section>
        ))
      )}
    </>
  );
}
