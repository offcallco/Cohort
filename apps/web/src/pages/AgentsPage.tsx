import { Link } from "react-router";
import type { Bot, Job, MissionControl } from "@cohort/shared";
import { AgentName } from "../components/Agent.tsx";
import { JOB_KIND_LABELS, JobStatusPill } from "../components/Pills.tsx";
import { RunCard } from "../components/RunCard.tsx";
import { SkeletonRows } from "../components/Skeleton.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { elapsed, formatCost, timeAgo } from "../format.ts";
import { useApi } from "../hooks.ts";
import { RunnersPage } from "./RunnersPage.tsx";

// All agents and their runs: what's running, what it cost, and the history.
export function AgentsPage() {
  const bots = useApi<{ bots: Bot[] }>("/api/bots", { pollMs: 10_000 }).data?.bots;
  const mission = useApi<MissionControl>("/api/mission", { pollMs: 3000 });
  const runs = useApi<{ jobs: Job[] }>("/api/jobs", { pollMs: 5000 });
  const history = runs.data?.jobs ?? [];
  const since = Date.now() - 24 * 3600_000;

  return (
    <>
      <h1>Agents</h1>
      <section className="section">
        <ul className="agent-list">
          {!bots ? (
            <SkeletonRows rows={2} height={48} />
          ) : (
            bots.map((b) => {
              const mine = history.filter((j) => j.bot === b.username);
              const today = mine.filter((j) => new Date(j.createdAt).getTime() > since);
              const cost = today.reduce((n, j) => n + (j.costUsd ?? 0), 0);
              const running = mine.filter((j) => j.status === "running").length;
              return (
                <li key={b.id}>
                  <AgentName name={b.username} />
                  <span className="muted small mono">{b.agentType}</span>
                  <StatusPill tone={b.available ? "passed" : "idle"} label={b.available ? "A runner can take its work" : "No runner online"} />
                  <span className="muted small">
                    {running ? `${running} running · ` : ""}
                    {today.length} runs in 24h{cost ? ` · ${formatCost(cost)}` : ""}
                  </span>
                </li>
              );
            })
          )}
        </ul>
      </section>

      <section className="section">
        <h2>Running now</h2>
        {!mission.data ? (
          <SkeletonRows rows={1} height={140} />
        ) : mission.data.running.length === 0 ? (
          <p className="empty-line">No agents are running.</p>
        ) : (
          <div className="run-grid">
            {mission.data.running.map((r) => (
              <RunCard key={r.jobId} run={r} onChange={mission.reload} />
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <h2>History</h2>
        {!runs.data ? (
          <SkeletonRows rows={4} height={40} />
        ) : history.length === 0 ? (
          <p className="empty-line">No runs yet. Assign an issue to an agent to start one.</p>
        ) : (
          <table className="runs-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Task</th>
                <th>Agent</th>
                <th>Took</th>
                <th>Cost</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {history.map((j) => (
                <tr key={j.id}>
                  <td>
                    <JobStatusPill status={j.status} />
                  </td>
                  <td>
                    <Link to={`/${j.project}/jobs/${j.id}`}>{j.issue?.title ?? (j.workshop ? `Workshop #${j.workshop}` : `Run #${j.id}`)}</Link>
                    <div className="muted small">
                      {JOB_KIND_LABELS[j.kind]} · <span className="mono">{j.project}</span>
                    </div>
                  </td>
                  <td>
                    <AgentName name={j.bot} />
                  </td>
                  <td className="muted small">{j.startedAt ? elapsed(j.startedAt, j.finishedAt ? new Date(j.finishedAt).getTime() : Date.now()) : "—"}</td>
                  <td className="muted small">{j.costUsd !== null ? formatCost(j.costUsd) : "—"}</td>
                  <td className="muted small">{timeAgo(j.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <RunnersPage embedded />
    </>
  );
}
