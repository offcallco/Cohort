import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import type { Job } from "@cohort/shared";
import { api } from "../../api.ts";
import { JOB_KIND_LABELS, JobStatusPill } from "../../components/Pills.tsx";
import { shortSha, timeAgo } from "../../format.ts";
import { useProject } from "./ProjectLayout.tsx";

// Job details with the log streamed live over server-sent events.
export function JobView() {
  const { base } = useProject();
  const { id = "" } = useParams();
  const [job, setJob] = useState<Job | null>(null);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setLog("");
    setJob(null);
    const source = new EventSource(`/api/jobs/${id}/events`);
    let first = true;
    source.addEventListener("log", (e) => {
      const text = JSON.parse((e as MessageEvent).data) as string;
      setLog((prev) => (first ? text : prev + text));
      first = false;
    });
    source.addEventListener("status", (e) => setJob(JSON.parse((e as MessageEvent).data) as Job));
    source.onerror = () => {
      // Reconnects on its own; the first "log" event resends the whole log.
      first = true;
    };
    return () => source.close();
  }, [id]);

  useEffect(() => {
    if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log, follow]);

  async function act(action: "cancel" | "retry") {
    try {
      const res = await api<{ job: Job }>(`/api/jobs/${id}/${action}`, { method: "POST" });
      if (action === "cancel") setJob(res.job);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  if (!job) return null;
  const active = job.status === "queued" || job.status === "running";

  return (
    <>
      <div className="crumbs">
        <Link to={`${base}/jobs`}>Jobs</Link> / #{job.id}
      </div>
      <div className="page-head">
        <div>
          <h1>
            Job #{job.id} <JobStatusPill status={job.status} />
          </h1>
          <div className="muted">
            {JOB_KIND_LABELS[job.kind]} by {job.bot} ({job.agentType})
            {job.issue && (
              <>
                {" for "}
                <Link to={`${base}/issues/${job.issue.number}`}>
                  #{job.issue.number} {job.issue.title}
                </Link>
              </>
            )}
            {job.kind === "resolve" ? (
              <>
                {" · merging "}
                <code>{job.baseBranch}</code> into <code>{job.branch}</code>
              </>
            ) : (
              job.branch && (
                <>
                  {" · "}
                  <code>{job.branch}</code> from <code>{job.baseBranch}</code>
                </>
              )
            )}
            {job.runner && <> · on {job.runner}</>}
            {job.startedAt && <> · started {timeAgo(job.startedAt)}</>}
            {job.commitSha && (
              <>
                {" · "}
                <Link className="sha" to={`${base}/commit/${job.commitSha}`}>
                  {shortSha(job.commitSha)}
                </Link>
              </>
            )}
            {job.mergeRequest && (
              <>
                {" · "}
                <Link to={`${base}/merge_requests/${job.mergeRequest}`}>!{job.mergeRequest}</Link>
              </>
            )}
          </div>
        </div>
        <div className="row">
          {active && (
            <button className="secondary" onClick={() => act("cancel")}>
              Cancel
            </button>
          )}
          {(job.status === "failed" || job.status === "canceled") && (
            <button className="secondary" onClick={() => act("retry")}>
              Retry
            </button>
          )}
        </div>
      </div>
      {job.status === "queued" && job.waitingReason && <div className="panel notice">{job.waitingReason}</div>}
      {job.error && <p className="error">{job.error}</p>}
      {error && <p className="error">{error}</p>}
      <section className="panel flush">
        <div className="panel-bar">
          <span className="muted small">Log</span>
          <label className="checkbox small">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Follow
          </label>
        </div>
        <pre className="log" ref={logRef}>
          {log || (active ? "Waiting for output…" : "No output.")}
        </pre>
      </section>
    </>
  );
}
