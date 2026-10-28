import { Link } from "react-router";
import type { WorkshopSummary } from "@cohort/shared";
import { timeAgo } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { StatusPill } from "../../components/StatusPill.tsx";
import { useProject } from "./ProjectLayout.tsx";
import { SkeletonRows } from "../../components/Skeleton.tsx";
import { ErrorState } from "../../components/States.tsx";

const statusTone = { active: "running", done: "passed", closed: "idle" } as const;
const statusLabel = { active: "Active", done: "Issues created", closed: "Closed" } as const;

export function WorkshopsView() {
  const { project, base } = useProject();
  const { data, error } = useApi<{ workshops: WorkshopSummary[] }>(`/api/projects/${project.workspace}/${project.slug}/workshops`, {
    pollMs: 3000,
    poll: (d) => d.workshops.some((w) => w.waiting),
  });

  return (
    <>
      <div className="toolbar spread">
        <p className="muted">
          A workshop is an interview with an agent that turns an idea into a plan and a set of issues.
        </p>
        {project.defaultBranch && (
          <Link className="button" to={`${base}/workshops/new`}>
            New workshop
          </Link>
        )}
      </div>
      {error && <ErrorState what="the workshops" error={error} />}
      {!data && !error && <SkeletonRows rows={3} height={52} />}
      {data &&
        (data.workshops.length === 0 ? (
          <section className="panel empty">
            <h2>No workshops yet</h2>
            <p className="muted">
              {project.defaultBranch
                ? "Start one with an idea; the agent reads the code and asks you questions until there's a plan."
                : "Push some code first, so the agent has something to read."}
            </p>
            {project.defaultBranch && (
              <Link className="button" to={`${base}/workshops/new`}>
                Start a workshop
              </Link>
            )}
          </section>
        ) : (
          <section className="panel flush">
            <ul className="list">
              {data.workshops.map((w) => (
                <li key={w.id} className="list-row">
                  <div>
                    <Link to={`${base}/workshops/${w.id}`}>{w.title}</Link>
                    <div className="muted small">
                      with {w.bot} · {w.messages} messages · updated {timeAgo(w.updatedAt)}
                      {w.waiting && " · agent is replying"}
                    </div>
                  </div>
                  <StatusPill tone={w.waiting ? "running" : statusTone[w.status]} label={w.waiting ? "Agent replying" : statusLabel[w.status]} />
                </li>
              ))}
            </ul>
          </section>
        ))}
    </>
  );
}
