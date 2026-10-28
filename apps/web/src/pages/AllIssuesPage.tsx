import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { ISSUE_STATUSES, STATUS_LABELS, type IssueSummary, type WorkspaceWithProjects } from "@cohort/shared";
import { IssueRow } from "../components/IssueBits.tsx";
import { useApi } from "../hooks.ts";

const ASSIGNEES = [
  ["", "Anyone"],
  ["me", "Assigned to me"],
  ["agents", "Assigned to agents"],
  ["none", "Unassigned"],
] as const;

// Every issue in every workspace, with filters kept in the URL.
export function AllIssuesPage() {
  const [search, setSearch] = useSearchParams();
  const status = search.get("status") ?? "open";
  const assignee = search.get("assignee") ?? "";
  const workspace = search.get("workspace") ?? "";
  const [q, setQ] = useState(search.get("q") ?? "");

  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (assignee) params.set("assignee", assignee);
  if (workspace) params.set("workspace", workspace);
  if (search.get("q")) params.set("q", search.get("q")!);
  const { data, error } = useApi<{ issues: IssueSummary[] }>(`/api/issues?${params}`, { pollMs: 5000 });
  const workspaces = useApi<{ workspaces: WorkspaceWithProjects[] }>("/api/workspaces").data?.workspaces ?? [];

  const update = (key: string, value: string | null) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearch(next, { replace: true });
  };

  // Debounced search box.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((search.get("q") ?? "") !== q) update("q", q.trim() || null);
    }, 250);
    return () => clearTimeout(t);
  });

  const filtered = status !== "open" || assignee || workspace || search.get("q");

  return (
    <>
      <div className="page-head">
        <h1>Work</h1>
        {data && (
          <span className="muted">
            {data.issues.length} {data.issues.length === 1 ? "issue" : "issues"}
          </span>
        )}
      </div>
      <div className="toolbar">
        <select value={status} onChange={(e) => update("status", e.target.value === "open" ? null : e.target.value)}>
          <option value="open">Open</option>
          <option value="all">All</option>
          {ISSUE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select value={assignee} onChange={(e) => update("assignee", e.target.value || null)}>
          {ASSIGNEES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {workspaces.length > 1 && (
          <select value={workspace} onChange={(e) => update("workspace", e.target.value || null)}>
            <option value="">All workspaces</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.slug}>
                {w.name}
              </option>
            ))}
          </select>
        )}
        <input className="search" placeholder="Search titles" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {error && <p className="error">{error}</p>}
      {data &&
        (data.issues.length === 0 ? (
          <section className="panel empty">
            <h2>{filtered ? "No issues match" : "No open issues"}</h2>
            <p className="muted">
              {filtered ? "Try different filters." : "Issues from every project in every workspace show up here."}
            </p>
          </section>
        ) : (
          <section className="panel flush">
            <ul className="list">
              {data.issues.map((i) => (
                <IssueRow key={i.id} issue={i} showProject />
              ))}
            </ul>
          </section>
        ))}
    </>
  );
}
