import { useEffect, useState, type DragEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { ISSUE_STATUSES, STATUS_LABELS, type IssueStatus, type IssueSummary, type Label } from "@cohort/shared";
import { api } from "../../api.ts";
import { IssueRow, LabelChip } from "../../components/IssueBits.tsx";
import { useApi } from "../../hooks.ts";
import { useProject } from "./ProjectLayout.tsx";
import { SkeletonRows } from "../../components/Skeleton.tsx";
import { ErrorState } from "../../components/States.tsx";

const BOARD_ORDER: IssueStatus[] = ["todo", "in_progress", "review", "blocked", "done"];

export function IssuesView() {
  const { project, base } = useProject();
  const [search, setSearch] = useSearchParams();
  const view = search.get("view") === "board" ? "board" : "list";
  const status = search.get("status") ?? "open";
  const label = search.get("label") ?? "";
  const [q, setQ] = useState(search.get("q") ?? "");

  const apiBase = `/api/projects/${project.workspace}/${project.slug}`;
  const params = new URLSearchParams();
  // The board shows every status as a column, so it ignores the status filter.
  if (view === "list" && status !== "all") params.set("status", status);
  if (label) params.set("label", label);
  if (search.get("q")) params.set("q", search.get("q")!);
  const { data, error, reload } = useApi<{ issues: IssueSummary[] }>(`${apiBase}/issues?${params}`);
  const labels = useApi<{ labels: Label[] }>(`${apiBase}/labels`).data?.labels ?? [];

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

  return (
    <>
      <div className="toolbar spread">
        <div className="row wrap">
          <div className="segmented">
            <button className={view === "list" ? "active" : ""} onClick={() => update("view", null)}>
              List
            </button>
            <button className={view === "board" ? "active" : ""} onClick={() => update("view", "board")}>
              Board
            </button>
          </div>
          {view === "list" && (
            <select value={status} onChange={(e) => update("status", e.target.value === "open" ? null : e.target.value)}>
              <option value="open">Open</option>
              <option value="all">All</option>
              {ISSUE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          )}
          {labels.length > 0 && (
            <select value={label} onChange={(e) => update("label", e.target.value || null)}>
              <option value="">Any label</option>
              {labels.map((l) => (
                <option key={l.id} value={l.name}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
          <input className="search" placeholder="Search titles" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Link className="button" to={`${base}/issues/new`}>
          New issue
        </Link>
      </div>

      {error && <ErrorState what="the issues" error={error} />}
      {!data && !error && <SkeletonRows rows={5} height={52} />}
      {data &&
        (view === "board" ? (
          <Board issues={data.issues} apiBase={apiBase} onChange={reload} />
        ) : data.issues.length === 0 ? (
          <section className="panel empty">
            <h2>No issues {status === "open" && !label && !search.get("q") ? "open" : "match"}</h2>
            <p className="muted">Issues describe work for you or, soon, a connected agent.</p>
            <Link className="button" to={`${base}/issues/new`}>
              Create an issue
            </Link>
          </section>
        ) : (
          <section className="panel flush">
            <ul className="list">
              {data.issues.map((i) => (
                <IssueRow key={i.id} issue={i} />
              ))}
            </ul>
          </section>
        ))}
    </>
  );
}

function Board({ issues, apiBase, onChange }: { issues: IssueSummary[]; apiBase: string; onChange: () => void }) {
  const { base } = useProject();
  const [moved, setMoved] = useState<Record<number, IssueStatus>>({});
  const [over, setOver] = useState<IssueStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const statusOf = (i: IssueSummary) => moved[i.number] ?? i.status;

  useEffect(() => setMoved({}), [issues]);

  async function drop(e: DragEvent, status: IssueStatus) {
    e.preventDefault();
    setOver(null);
    const number = Number(e.dataTransfer.getData("text/issue"));
    if (!number) return;
    setMoved((m) => ({ ...m, [number]: status }));
    try {
      await api(`${apiBase}/issues/${number}`, { method: "PATCH", body: { status } });
      setError(null);
      onChange();
    } catch (err) {
      setMoved((m) => {
        const { [number]: _, ...rest } = m;
        return rest;
      });
      setError(err instanceof Error ? err.message : "Couldn't move the issue");
    }
  }

  return (
    <>
      {error && <p className="error">{error}</p>}
      <div className="board">
        {BOARD_ORDER.map((status) => {
          const column = issues.filter((i) => statusOf(i) === status);
          return (
            <section
              key={status}
              className={`column${over === status ? " over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(status);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => drop(e, status)}
            >
              <header>
                {STATUS_LABELS[status]} <span className="muted">{column.length}</span>
              </header>
              {column.map((i) => (
                <div
                  key={i.id}
                  className="card-item"
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/issue", String(i.number))}
                >
                  <Link to={`${base}/issues/${i.number}`}>{i.title}</Link>
                  <div className="row wrap">
                    <span className="muted small">#{i.number}</span>
                    {i.labels.map((l) => (
                      <LabelChip key={l.id} label={l} />
                    ))}
                  </div>
                  {i.waitingOn > 0 && <div className="muted small">Waiting on {i.waitingOn}</div>}
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}
