import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { CiJob, PipelineDetail } from "@cohort/shared";
import { api } from "../../api.ts";
import { PipelineStatusPill } from "../../components/PipelineBits.tsx";
import { shortSha, timeAgo } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { useProject } from "./ProjectLayout.tsx";
import { SkeletonRows } from "../../components/Skeleton.tsx";

const ACTIVE = new Set(["pending", "running", "manual"]);

export function PipelineView() {
  const { project, base } = useProject();
  const { id = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const url = `/api/projects/${project.workspace}/${project.slug}/pipelines/${id}`;
  const { data, error: loadError, reload } = useApi<{ pipeline: PipelineDetail }>(url, {
    pollMs: 1500,
    poll: (d) => d.pipeline.status === "pending" || d.pipeline.status === "running",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(action: "run" | "cancel" | "retry") {
    setBusy(true);
    try {
      const res = await api<{ pipeline: PipelineDetail }>(`${url}/${action}`, { method: "POST" });
      setError(null);
      if (action === "retry") location.assign(`${base}/pipelines/${res.pipeline.id}`);
      else await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <p className="error">{loadError}</p>;
  if (!data) return <SkeletonRows rows={3} height={56} />;
  const p = data.pipeline;
  const selected = p.jobs.find((j) => String(j.id) === search.get("job")) ?? null;

  return (
    <>
      <div className="crumbs">
        <Link to={`${base}/pipelines`}>Pipelines</Link> / #{p.id}
      </div>
      <div className="page-head">
        <div>
          <h1>
            Pipeline #{p.id} <PipelineStatusPill status={p.status} />
          </h1>
          <div className="muted small">
            <code>{p.ref}</code> at{" "}
            <Link className="sha" to={`${base}/commit/${p.sha}`}>
              {shortSha(p.sha)}
            </Link>{" "}
            · by {p.triggeredBy} · {timeAgo(p.createdAt)}
            {p.mergeRequest && (
              <>
                {" · "}
                <Link to={`${base}/merge_requests/${p.mergeRequest}`}>!{p.mergeRequest}</Link>
              </>
            )}
          </div>
        </div>
        <div className="row">
          {p.status === "manual" && (
            <button disabled={busy} onClick={() => act("run")}>
              Run pipeline
            </button>
          )}
          {ACTIVE.has(p.status) && (
            <button className="secondary" disabled={busy} onClick={() => act("cancel")}>
              Cancel
            </button>
          )}
          {!ACTIVE.has(p.status) && (
            <button className="secondary" disabled={busy} onClick={() => act("retry")}>
              Retry
            </button>
          )}
        </div>
      </div>
      {p.status === "manual" && (
        <div className="panel notice">
          This pipeline is for an agent's changes, so it waits for you. Check the merge request's changes, then run it: its
          jobs run commands from those changes on your runner.
        </div>
      )}
      {p.error && <p className="error">{p.error}</p>}
      {error && <p className="error">{error}</p>}

      {p.jobs.length > 0 && (
        <div className="stages">
          {p.stages.map((stage) => (
            <section key={stage} className="stage">
              <header>{stage}</header>
              {p.jobs
                .filter((j) => j.stage === stage)
                .map((j) => (
                  <button
                    key={j.id}
                    className={`ci-job${selected?.id === j.id ? " selected" : ""}`}
                    onClick={() => setSearch({ job: String(j.id) })}
                  >
                    <span>{j.name}</span>
                    <PipelineStatusPill status={j.status} />
                    {j.allowFailure && <span className="muted small">allowed to fail</span>}
                  </button>
                ))}
            </section>
          ))}
        </div>
      )}
      {selected && <CiJobLog key={selected.id} job={selected} />}
    </>
  );
}

function CiJobLog({ job }: { job: CiJob }) {
  const [log, setLog] = useState("");
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const source = new EventSource(`/api/ci_jobs/${job.id}/events`);
    let first = true;
    source.addEventListener("log", (e) => {
      const text = JSON.parse((e as MessageEvent).data) as string;
      setLog((prev) => (first ? text : prev + text));
      first = false;
    });
    source.onerror = () => {
      first = true;
    };
    return () => source.close();
  }, [job.id]);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log]);

  return (
    <section className="panel flush">
      <div className="panel-bar">
        <strong>{job.name}</strong>
        <span className="muted small">
          {job.runner && `on ${job.runner} · `}
          {job.waitingReason ?? job.error ?? ""}
        </span>
      </div>
      <pre className="log" ref={ref}>
        {log || (job.status === "pending" || job.status === "created" ? "Waiting to start…" : "No output.")}
      </pre>
    </section>
  );
}
