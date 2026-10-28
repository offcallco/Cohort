import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Check, CircleDot, Download, GitBranch, Pause, Play, X } from "lucide-react";
import type { RunSummary } from "@cohort/shared";
import { api } from "../../api.ts";
import { AgentName } from "../../components/Agent.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { JOB_KIND_LABELS, JobStatusPill, MergeRequestPill } from "../../components/Pills.tsx";
import { PipelineStatusPill } from "../../components/PipelineBits.tsx";
import { SkeletonRows } from "../../components/Skeleton.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { elapsed, formatCost, timeAgo } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { useNow } from "../../useNow.ts";
import { useProject } from "./ProjectLayout.tsx";

// An agent run: summary first, logs one click away.
export function JobView() {
  const { base } = useProject();
  const { id = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const tab = search.get("tab") === "log" ? "log" : "summary";
  const { data, error, reload } = useApi<{ run: RunSummary }>(`/api/jobs/${id}/summary`, {
    pollMs: 2000,
    poll: (d) => d.run.job.status === "queued" || d.run.job.status === "running",
  });
  const now = useNow();

  if (error) {
    return (
      <div className="panel">
        <p className="error">Couldn't load run #{id}: {error}</p>
        <button className="secondary" onClick={reload}>
          Try again
        </button>
      </div>
    );
  }
  if (!data) return <SkeletonRows rows={4} height={56} />;
  const { run } = data;
  const job = run.job;
  const active = job.status === "queued" || job.status === "running";
  const took = job.startedAt ? elapsed(job.startedAt, job.finishedAt ? new Date(job.finishedAt).getTime() : now) : null;
  const task = job.issue ? `#${job.issue.number} ${job.issue.title}` : job.workshop ? `Workshop #${job.workshop}` : `Run #${job.id}`;

  return (
    <>
      <header className="work-header">
        <h1>
          {JOB_KIND_LABELS[job.kind]}: {job.issue?.title ?? task}
        </h1>
        <div className="meta">
          {job.pausedAt ? <StatusPill tone="idle" icon="pause" label="Paused" /> : <JobStatusPill status={job.status} />}
          <AgentName name={job.bot} />
          {job.issue && <Link to={`${base}/issues/${job.issue.number}`}>#{job.issue.number}</Link>}
          {job.workshop && <Link to={`${base}/workshops/${job.workshop}`}>Workshop #{job.workshop}</Link>}
          {took && <span>{active ? `running for ${took}` : `took ${took}`}</span>}
          {job.costUsd !== null && <span>{formatCost(job.costUsd)}</span>}
          {job.branch && (
            <span className="mono">
              <GitBranch size={12} aria-hidden /> {job.branch}
            </span>
          )}
          {job.runner && <span>on {job.runner}</span>}
        </div>
      </header>

      <Controls run={run} onChange={reload} />

      <nav className="tabs" aria-label="Run">
        <button className={`tab${tab === "summary" ? " active" : ""}`} onClick={() => setSearch({})}>
          Summary
        </button>
        <button className={`tab${tab === "log" ? " active" : ""}`} onClick={() => setSearch({ tab: "log" })}>
          Log
        </button>
      </nav>

      {tab === "summary" ? <Summary run={run} base={base} /> : <LogView jobId={job.id} active={active} />}
    </>
  );
}

function Controls({ run, onChange }: { run: RunSummary; onChange: () => void }) {
  const job = run.job;
  const { project } = useProject();
  const [mode, setMode] = useState<null | "stop" | "redirect">(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = job.status === "queued" || job.status === "running";

  async function act(path: string, body?: object) {
    setBusy(true);
    try {
      await api(path, { method: "POST", body: body ?? {} });
      setError(null);
      setMode(null);
      setNote("");
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  }

  const tone = job.pausedAt ? "idle" : active ? "running" : job.status === "failed" ? "failed" : job.status === "succeeded" ? "passed" : "idle";
  const issueUrl = job.issue ? `/api/projects/${project.workspace}/${project.slug}/issues/${job.issue.number}` : null;

  return (
    <section className={`gate gate-${tone}`}>
      <div className="gate-headline">
        {active && !job.pausedAt && job.status === "running" && <span className="pulse" aria-hidden />}
        {run.phase}
      </div>
      {job.pausedAt && <p className="muted small gate-reason">Paused {timeAgo(job.pausedAt)}. A long pause can make the agent's connection to its model time out.</p>}
      {mode === "stop" ? (
        <div className="row wrap">
          <span className="muted">
            Stop the run? Changes it hasn't pushed yet are discarded
            {job.branch ? `; anything already on ${job.branch} stays` : ""}.
          </span>
          <button className="danger" disabled={busy} onClick={() => act(`/api/jobs/${job.id}/cancel`)}>
            Stop it
          </button>
          <button className="link" onClick={() => setMode(null)}>
            Keep running
          </button>
        </div>
      ) : mode === "redirect" && issueUrl ? (
        <form
          className="stack gate-note"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void act(`${issueUrl}/redirect`, { note });
          }}
        >
          <label>
            New instruction
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder="e.g. Don't touch the migrations; add a new one instead." />
          </label>
          <div className="row">
            <button type="submit" disabled={busy || !note.trim()}>
              Stop and redirect
            </button>
            <button type="button" className="link" onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : active ? (
        <div className="row wrap">
          {job.status === "running" &&
            (job.pausedAt ? (
              <button disabled={busy} onClick={() => act(`/api/jobs/${job.id}/resume`)}>
                <Play size={14} aria-hidden /> Resume
              </button>
            ) : (
              <button className="secondary" disabled={busy} onClick={() => act(`/api/jobs/${job.id}/pause`)}>
                <Pause size={14} aria-hidden /> Pause
              </button>
            ))}
          {issueUrl && job.kind !== "workshop" && (
            <button className="secondary" onClick={() => setMode("redirect")}>
              Redirect
            </button>
          )}
          <button className="danger" onClick={() => setMode("stop")}>
            Stop
          </button>
        </div>
      ) : job.status === "failed" || job.status === "canceled" ? (
        <div className="row wrap">
          <button disabled={busy} onClick={() => act(`/api/jobs/${job.id}/retry`)}>
            Retry
          </button>
        </div>
      ) : null}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

function Summary({ run, base }: { run: RunSummary; base: string }) {
  const { artifacts: a } = run;
  const hasArtifacts = a.plan || a.mergeRequest || a.pipeline || a.summary;
  return (
    <>
      <section className="section">
        <h2>Steps</h2>
        {run.steps.length === 0 ? (
          <p className="empty-line">{run.job.status === "queued" ? "Waiting for a runner to start." : "No steps yet."}</p>
        ) : (
          <ol className="steps-list">
            {run.steps.map((s, n) => (
              <li key={n} className={`run-step run-step-${s.state}`}>
                {s.state === "done" ? <Check size={14} aria-hidden /> : s.state === "current" ? <CircleDot size={14} aria-hidden /> : <X size={14} aria-hidden />}
                <span className="run-step-label">{s.label}</span>
                {s.detail && <span className="muted small mono">{s.detail}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="section">
        <h2>Artifacts</h2>
        {!hasArtifacts ? (
          <p className="empty-line">Nothing yet. The plan, changes, checks and the agent's summary show up here.</p>
        ) : (
          <div className="artifacts">
            {a.mergeRequest && (
              <Link to={`${base}/merge_requests/${a.mergeRequest.number}`} className="artifact">
                <div className="artifact-kind">Changes</div>
                <div className="artifact-title">
                  !{a.mergeRequest.number} {a.mergeRequest.title}
                </div>
                <MergeRequestPill status={a.mergeRequest.status} />
              </Link>
            )}
            {a.pipeline && (
              <Link to={`${base}/pipelines/${a.pipeline.id}`} className="artifact">
                <div className="artifact-kind">Checks</div>
                <div className="artifact-title">Pipeline #{a.pipeline.id}</div>
                <PipelineStatusPill status={a.pipeline.status} />
              </Link>
            )}
            {a.summary && (
              <div className="artifact artifact-wide">
                <div className="artifact-kind">The agent's summary</div>
                <Markdown source={a.summary} />
              </div>
            )}
            {a.plan && (
              <details className="artifact artifact-wide">
                <summary className="artifact-kind">Plan</summary>
                <Markdown source={a.plan} />
              </details>
            )}
          </div>
        )}
      </section>
    </>
  );
}

type Level = "all" | "agent" | "tools" | "errors";

const isSystem = (l: string) => /^(Queued|Assigned to runner|Runner started|Fetching|Checked out|Checking out|Pushing|Cost: |Job (succeeded|failed|canceled)|Back in the queue|Cancel requested|Paused by|Resumed|Claude Code (started|resumed))/.test(l);
const isTool = (l: string) => l.startsWith("→ ") || l.startsWith("$ ");
const isError = (l: string) => l.trimStart().startsWith("✗") || /\b(error|failed|exception)\b/i.test(l);

// The raw log: searchable, filterable, copyable, and it only follows new output while you're
// at the bottom.
function LogView({ jobId, active }: { jobId: number; active: boolean }) {
  const [log, setLog] = useState("");
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<Level>("all");
  const [copied, setCopied] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    const source = new EventSource(`/api/jobs/${jobId}/events`);
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
  }, [jobId]);

  const lines = useMemo(() => {
    const q = query.trim().toLowerCase();
    return log
      .split("\n")
      .map((text, n) => ({ text, n }))
      .filter(({ text }) => {
        if (!text.trim()) return false;
        if (q && !text.toLowerCase().includes(q)) return false;
        if (level === "tools") return isTool(text);
        if (level === "errors") return isError(text);
        if (level === "agent") return !isTool(text) && !isSystem(text);
        return true;
      });
  }, [log, query, level]);

  useEffect(() => {
    if (atBottom.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  return (
    <section className="section">
      <div className="toolbar">
        <input className="search" placeholder="Search the log" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the log" />
        <div className="chips" role="group" aria-label="Show">
          {(
            [
              ["all", "All"],
              ["agent", "Agent messages"],
              ["tools", "Tool calls"],
              ["errors", "Errors"],
            ] as const
          ).map(([key, label]) => (
            <button key={key} className={`chip small${level === key ? " active" : ""}`} aria-pressed={level === key} onClick={() => setLevel(key)}>
              {label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <a className="button ghost small" href={`/api/jobs/${jobId}/log`} download={`job-${jobId}.log`}>
          <Download size={12} aria-hidden /> Download
        </a>
      </div>
      <div
        className="log-lines"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {lines.length === 0 ? (
          <p className="muted small pad">{log ? "No lines match." : active ? "Waiting for output…" : "No output."}</p>
        ) : (
          lines.map(({ text, n }) => (
            <button
              key={n}
              className={`log-line${isError(text) ? " log-error" : isTool(text) ? " log-tool" : isSystem(text) ? " log-system" : ""}`}
              title="Click to copy"
              onClick={async () => {
                await navigator.clipboard.writeText(text);
                setCopied(n);
                setTimeout(() => setCopied(null), 1200);
              }}
            >
              <span className="log-n">{n + 1}</span>
              <span className="log-text">{text}</span>
              {copied === n && <span className="log-copied">Copied</span>}
            </button>
          ))
        )}
      </div>
    </section>
  );
}
