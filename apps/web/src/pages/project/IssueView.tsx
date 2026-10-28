import { useCallback, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { Check, Circle, CircleDot, Clock, Eye, GitBranch, Minus, X } from "lucide-react";
import {
  ISSUE_STATUSES,
  STATUS_LABELS,
  type Bot,
  type IssueDetail,
  type IssueRef,
  type IssueStatus,
  type LoopStep,
  type UpdateIssueBody,
  type User,
  type WorkItemStory,
} from "@cohort/shared";
import { api } from "../../api.ts";
import { AgentName, Actor } from "../../components/Agent.tsx";
import { IssueLink, LabelChip, StatusBadge } from "../../components/IssueBits.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { MarkdownEditor } from "../../components/MarkdownEditor.tsx";
import { PipelineStatusPill } from "../../components/PipelineBits.tsx";
import { SkeletonRows } from "../../components/Skeleton.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { elapsed, plural, timeAgo } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { useNow } from "../../useNow.ts";
import { parseLabels, parseNumbers } from "./NewIssueView.tsx";
import { useProject } from "./ProjectLayout.tsx";

// The work item page: the whole story of one task, gated by a person.
export function IssueView() {
  const { project, base } = useProject();
  const { number = "" } = useParams();
  const url = `/api/projects/${project.workspace}/${project.slug}/issues/${number}`;
  const { data, error, reload } = useApi<{ story: WorkItemStory }>(`${url}/story`, {
    pollMs: 2500,
    poll: (d) => d.story.run !== null || d.story.pipeline?.status === "running" || d.story.pipeline?.status === "pending",
  });
  const [actionError, setActionError] = useState<string | null>(null);

  // Runs a gate action against the issue, then refreshes the story.
  const act = useCallback(
    async (path: string, body?: object, method: "POST" | "PATCH" = "POST") => {
      try {
        await api(path.startsWith("/") ? path : `${url}/${path}`, { method, body: body ?? {} });
        setActionError(null);
        await reload();
        return true;
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "That didn't work");
        return false;
      }
    },
    [url, reload],
  );

  if (error) {
    return (
      <div className="panel">
        <p className="error">Couldn't load issue #{number}: {error}</p>
        <button className="secondary" onClick={reload}>
          Try again
        </button>
      </div>
    );
  }
  if (!data) return <SkeletonRows rows={4} height={64} />;
  const story = data.story;
  const i = story.issue;

  return (
    <>
      <Header story={story} onRename={(title) => act(url, { title }, "PATCH")} />
      <Tracker steps={story.steps} />
      <Gate story={story} url={url} act={act} error={actionError} />

      {i.plan && (
        <section id="plan" className="section">
          <h2>
            Plan{" "}
            {i.planStatus === "pending" ? (
              <StatusPill tone="waiting" label="Waiting for your approval" />
            ) : i.planStatus === "approved" ? (
              <StatusPill tone="passed" label="Approved" />
            ) : i.planStatus === "rejected" ? (
              <StatusPill tone="failed" label="Rejected" />
            ) : null}
          </h2>
          <div className="prose-block">
            <Markdown source={i.plan} />
          </div>
          {i.splitProposal && <ProposedParts proposal={i.splitProposal} />}
        </section>
      )}

      {(story.mergeRequest || story.summary) && <WhatChanged story={story} base={base} />}
      {story.mergeRequest && <Checks story={story} base={base} act={act} />}
      {i.childIssues.length > 0 && (
        <section className="section">
          <h2>
            Parts <span className="muted small">{i.childIssues.filter((c) => c.status === "done").length} of {i.childIssues.length} done</span>
          </h2>
          <ul className="check-list">
            {i.childIssues.map((c) => (
              <li key={c.number}>
                <StatusBadge status={c.status} />
                <IssueLink base={base} issue={c} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <Details issue={i} url={url} onSave={(changes) => act(url, changes, "PATCH")} />
      <Timeline story={story} />
      <CommentBox url={url} onPosted={reload} />
    </>
  );
}

// --- Header and tracker --------------------------------------------------------------------

function Header({ story, onRename }: { story: WorkItemStory; onRename: (title: string) => Promise<boolean> }) {
  const i = story.issue;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(i.title);
  const agents = [...new Set(story.jobs.map((j) => j.bot))];

  return (
    <header className="work-header">
      {editing ? (
        <form
          className="row title-edit"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await onRename(title)) setEditing(false);
          }}
        >
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus aria-label="Title" />
          <button type="submit">Save</button>
          <button type="button" className="secondary" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="row spread">
          <h1>
            {i.title} <span className="muted">#{i.number}</span>
          </h1>
          <button
            className="link small"
            onClick={() => {
              setTitle(i.title);
              setEditing(true);
            }}
          >
            Rename
          </button>
        </div>
      )}
      <div className="meta">
        <StatusBadge status={i.status} />
        <span className="mono">{i.project}</span>
        {i.branch && (
          <span className="mono">
            <GitBranch size={12} aria-hidden /> {i.branch}
          </span>
        )}
        {(agents.length ? agents : i.assignee?.kind === "bot" ? [i.assignee.username] : []).map((a) => (
          <AgentName key={a} name={a} />
        ))}
        <span>
          Opened {timeAgo(i.createdAt)} by <Actor name={i.author.username} bot={i.author.kind === "bot"} />
        </span>
        {i.parentIssue && (
          <span>
            Part of <IssueLink base={`/${i.project}`} issue={i.parentIssue} />
          </span>
        )}
      </div>
    </header>
  );
}

const STEP_ANCHORS: Record<LoopStep["key"], string> = {
  spec: "details",
  plan: "plan",
  code: "changes",
  test: "checks",
  review: "gate",
  merge: "gate",
};

function StepIcon({ state }: { state: LoopStep["state"] }) {
  const size = 14;
  if (state === "done") return <Check size={size} aria-hidden />;
  if (state === "current") return <CircleDot size={size} aria-hidden />;
  if (state === "waiting") return <Eye size={size} aria-hidden />;
  if (state === "failed") return <X size={size} aria-hidden />;
  if (state === "skipped") return <Minus size={size} aria-hidden />;
  return <Circle size={size} aria-hidden />;
}

// Spec → Plan → Code → Test → Review → Merge, always visible. Each step jumps to its evidence.
function Tracker({ steps }: { steps: LoopStep[] }) {
  return (
    <ol className="tracker" aria-label="Progress">
      {steps.map((s) => (
        <li key={s.key} className={`step step-${s.state}`}>
          <a href={`#${STEP_ANCHORS[s.key]}`} title={s.detail}>
            <StepIcon state={s.state} />
            <span className="step-label">{s.label}</span>
            <span className="step-detail">{s.detail}</span>
          </a>
        </li>
      ))}
    </ol>
  );
}

// --- Human gate ----------------------------------------------------------------------------

type Act = (path: string, body?: object, method?: "POST" | "PATCH") => Promise<boolean>;

// What the person can do right now, never more than one click away.
function Gate({ story, url, act, error }: { story: WorkItemStory; url: string; act: Act; error: string | null }) {
  const i = story.issue;
  const mr = story.mergeRequest;
  const run = story.run;
  const lastJob = story.jobs[0];
  const bots = useApi<{ bots: Bot[] }>("/api/bots").data?.bots ?? [];
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<null | "changes" | "redirect" | "reject" | "stop">(null);
  const [busy, setBusy] = useState(false);
  const now = useNow();

  const run_ = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    if (ok) {
      setMode(null);
      setNote("");
    }
  };

  const noteBox = (label: string, placeholder: string, submit: string, path: string, extra?: object) => (
    <form
      className="stack gate-note"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void run_(() => act(path, { note, ...extra }));
      }}
    >
      <label>
        {label}
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={placeholder} autoFocus />
      </label>
      <div className="row">
        <button type="submit" disabled={busy || !note.trim()}>
          {submit}
        </button>
        <button type="button" className="link" onClick={() => setMode(null)}>
          Cancel
        </button>
      </div>
    </form>
  );

  let tone: "waiting" | "running" | "failed" | "passed" | "idle" = "idle";
  let headline: ReactNode;
  let actions: ReactNode = null;

  if (i.planStatus === "pending") {
    tone = "waiting";
    headline = (
      <>
        Waiting for your review: the plan is ready
        {i.splitProposal ? `, splitting the work into ${i.splitProposal.issues.length} parts` : ""}.
      </>
    );
    actions =
      mode === "changes" ? (
        noteBox("What should change?", "e.g. Store attempts in Redis, not in memory.", "Ask for a new plan", "plan", { decision: "changes" })
      ) : mode === "reject" ? (
        <div className="row wrap">
          <span className="muted">Reject the plan? The agent stops and is unassigned.</span>
          <button className="danger" disabled={busy} onClick={() => run_(() => act("plan", { decision: "reject" }))}>
            Reject plan
          </button>
          <button className="link" onClick={() => setMode(null)}>
            Keep it
          </button>
        </div>
      ) : (
        <div className="row wrap">
          <button disabled={busy} onClick={() => run_(() => act("plan", { decision: "approve" }))}>
            Approve plan
          </button>
          <button className="secondary" onClick={() => setMode("changes")}>
            Request changes
          </button>
          <button className="danger" onClick={() => setMode("reject")}>
            Reject
          </button>
        </div>
      );
  } else if (run) {
    tone = "running";
    headline = (
      <>
        <AgentName name={run.agent} /> {run.status === "queued" ? run.phase : `${run.phase}`}
        {run.startedAt && run.status === "running" && <span className="muted"> · {elapsed(run.startedAt, now)}</span>}
      </>
    );
    actions =
      mode === "redirect" ? (
        noteBox("New instruction", "e.g. Use the existing rate limiter in src/lib instead.", "Stop and redirect", "redirect")
      ) : mode === "stop" ? (
        <div className="row wrap">
          <span className="muted">Stop the agent? Anything already pushed stays on {i.branch ?? "its branch"}.</span>
          <button className="danger" disabled={busy} onClick={() => run_(() => act(`/api/jobs/${run.jobId}/cancel`))}>
            Stop it
          </button>
          <button className="link" onClick={() => setMode(null)}>
            Keep running
          </button>
        </div>
      ) : (
        <div className="row wrap">
          <Link className="button secondary" to={`/${i.project}/jobs/${run.jobId}`}>
            View run
          </Link>
          <button className="secondary" onClick={() => setMode("redirect")}>
            Redirect
          </button>
          <button className="danger" onClick={() => setMode("stop")}>
            Stop
          </button>
        </div>
      );
  } else if (i.splitProposal) {
    tone = "waiting";
    headline = <>The agent wants to split this into {i.splitProposal.issues.length} parts, over the runner's limit of {i.splitProposal.limit}.</>;
    actions = (
      <div className="row wrap">
        <button disabled={busy} onClick={() => run_(() => act("split", { approve: true }))}>
          Split into {i.splitProposal.issues.length}
        </button>
        <button className="secondary" disabled={busy} onClick={() => run_(() => act("split", { approve: false }))}>
          Do it as one job
        </button>
      </div>
    );
  } else if (mr?.status === "open") {
    const blocked =
      mr.mergeable === false
        ? `The branches conflict. Resolve them on ${mr.sourceBranch}.`
        : mr.mergeable === null
          ? "A branch is missing."
          : mr.commits === 0
            ? "There's nothing to merge."
            : mr.pipelinesMustSucceed && story.pipeline?.status !== "success"
              ? story.pipeline?.status === "manual"
                ? "This project needs a passing pipeline. Start it first."
                : `This project needs a passing pipeline (it's ${story.pipeline ? story.pipeline.status : "missing"}).`
              : null;
    tone = "waiting";
    headline = (
      <>
        Waiting for your review: {plural(mr.files.length, "file")} changed in !{mr.number}
        {story.pipeline
          ? story.pipeline.status === "success"
            ? ", checks passed."
            : story.pipeline.status === "failed"
              ? ", checks failed."
              : story.pipeline.status === "manual"
                ? ". Its checks are waiting for you to start them."
                : ", checks are running."
          : "."}
      </>
    );
    actions =
      mode === "changes" ? (
        noteBox("What should the agent change?", "e.g. Rename rateLimit() to limitLogins() and add a test for the reset.", "Send to the agent", "request-changes")
      ) : (
        <div className="stack">
          <div className="row wrap">
            <button disabled={busy || blocked !== null} onClick={() => run_(() => act(`/api/projects/${i.project}/merge_requests/${mr.number}/merge`, { deleteSourceBranch: true }))}>
              Approve & merge
            </button>
            {i.assignee?.kind === "bot" && (
              <button className="secondary" onClick={() => setMode("changes")}>
                Request changes
              </button>
            )}
            <Link className="button secondary" to={`/${i.project}/merge_requests/${mr.number}?tab=changes`}>
              View diff
            </Link>
          </div>
          {blocked && <p className="muted small gate-reason">Can't merge yet: {blocked}</p>}
        </div>
      );
  } else if (lastJob?.status === "failed" && i.status === "blocked") {
    tone = "failed";
    headline = <>Failed: {lastJob.error ?? "the agent stopped"}.</>;
    actions =
      mode === "redirect" ? (
        noteBox("Instruction for the next try", "e.g. The test fixture is in tests/fixtures; use it.", "Try again with this", "redirect")
      ) : (
        <div className="row wrap">
          <button disabled={busy} onClick={() => run_(() => act(`/api/jobs/${lastJob.id}/retry`))}>
            Retry
          </button>
          <button className="secondary" onClick={() => setMode("redirect")}>
            Retry with an instruction
          </button>
          <Link className="button secondary" to={`/${i.project}/jobs/${lastJob.id}`}>
            View log
          </Link>
        </div>
      );
  } else if (i.status === "done") {
    tone = "passed";
    headline = mr?.status === "merged" ? <>Merged !{mr.number} into {mr.targetBranch}.</> : <>Done.</>;
  } else if (i.assignee?.kind !== "bot") {
    headline = <>Nobody's working on this. Assign an agent to plan and build it.</>;
    actions = (
      <div className="row wrap">
        {bots.map((b, n) => (
          <button key={b.id} className={n === 0 ? "" : "secondary"} disabled={busy} onClick={() => run_(() => act(url, { assignee: b.username }, "PATCH"))}>
            Assign {b.username}
            {b.available ? "" : " (no runner online)"}
          </button>
        ))}
      </div>
    );
  } else {
    headline = <>Assigned to <AgentName name={i.assignee.username} />, waiting to start.</>;
  }

  return (
    <section id="gate" className={`gate gate-${tone}`}>
      <div className="gate-headline">{headline}</div>
      {actions}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

// --- Evidence ------------------------------------------------------------------------------

function ProposedParts({ proposal }: { proposal: NonNullable<IssueDetail["splitProposal"]> }) {
  const titleOf = (key: string) => proposal.issues.find((p) => p.key === key)?.title ?? key;
  return (
    <div className="parts">
      <div className="muted small">Proposed parts, each done by its own agent and merged into one branch:</div>
      <ol>
        {proposal.issues.map((p) => (
          <li key={p.key}>
            {p.title}
            {p.dependsOn.length > 0 && <span className="muted small"> · after {p.dependsOn.map(titleOf).join(", ")}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function WhatChanged({ story, base }: { story: WorkItemStory; base: string }) {
  const mr = story.mergeRequest;
  const [all, setAll] = useState(false);
  const files = mr?.files ?? [];
  const shown = all ? files : files.slice(0, 8);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <section id="changes" className="section">
      <h2>What changed</h2>
      {mr && (
        <div className="meta changed-meta">
          <span>{plural(files.length, "file")}</span>
          <span>
            <span className="add">+{additions}</span> <span className="del">−{deletions}</span>
          </span>
          <span>
            <Link to={`${base}/merge_requests/${mr.number}`}>!{mr.number}</Link> {mr.sourceBranch} → {mr.targetBranch}
          </span>
        </div>
      )}
      {story.summary && (
        <div className="prose-block agent-summary">
          <div className="muted small">
            <AgentName name={story.jobs.find((j) => j.summary === story.summary)?.bot ?? "agent"} /> says:
          </div>
          <Markdown source={story.summary} />
        </div>
      )}
      {shown.length > 0 && (
        <ul className="file-list">
          {shown.map((f) => (
            <li key={f.path}>
              <Link className="mono" to={`${base}/merge_requests/${mr!.number}?tab=changes`}>
                {f.path}
              </Link>
              <span className="muted small">{f.status === "modified" ? "" : f.status}</span>
              <span className="small">
                <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
              </span>
            </li>
          ))}
          {files.length > shown.length && (
            <li>
              <button className="link small" onClick={() => setAll(true)}>
                Show {files.length - shown.length} more
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function Checks({ story, base, act }: { story: WorkItemStory; base: string; act: Act }) {
  const p = story.pipeline;
  return (
    <section id="checks" className="section">
      <h2>Checks</h2>
      {!p ? (
        <p className="empty-line">No pipeline ran. Add a .cohort-ci.yml to run tests on every change.</p>
      ) : (
        <>
          <div className="row wrap check-head">
            <PipelineStatusPill status={p.status} />
            <Link to={`${base}/pipelines/${p.id}`}>Pipeline #{p.id}</Link>
            {p.status === "manual" && (
              <button className="secondary small" onClick={() => act(`/api/projects/${story.issue.project}/pipelines/${p.id}/run`)}>
                Run pipeline
              </button>
            )}
          </div>
          {p.status === "manual" && (
            <p className="muted small">It runs commands from the agent's changes on your runner, so it waits for you.</p>
          )}
          <ul className="check-list">
            {p.jobs.map((j) => (
              <li key={j.id}>
                <PipelineStatusPill status={j.status} />
                <Link className="mono" to={`${base}/pipelines/${p.id}?job=${j.id}`}>
                  {j.name}
                </Link>
                {p.stages.length > 1 && <span className="muted small">{j.stage}</span>}
                {j.startedAt && j.finishedAt && (
                  <span className="muted small">
                    <Clock size={12} aria-hidden /> {Math.max(1, Math.round((new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()) / 1000))}s
                  </span>
                )}
                {j.status === "failed" && j.error && <span className="error small check-error">{j.error}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// --- Details, timeline, comments ----------------------------------------------------------

function Details({ issue: i, url, onSave }: { issue: IssueDetail; url: string; onSave: (changes: UpdateIssueBody) => Promise<boolean> }) {
  const users = useApi<{ users: User[] }>("/api/users").data?.users ?? [];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(i.body);
  const base = `/${i.project}`;
  void url;

  return (
    <details id="details" className="section details-block">
      <summary>
        <h2>Details</h2>
        <span className="muted small">
          Description, status, assignee, labels and links
        </span>
      </summary>
      <div className="details-grid">
        <div className="details-body">
          {editing ? (
            <div className="stack">
              <MarkdownEditor value={draft} onChange={setDraft} rows={10} autoFocus />
              <div className="row">
                <button onClick={async () => (await onSave({ body: draft })) && setEditing(false)}>Save</button>
                <button className="link" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {i.body.trim() ? <Markdown source={i.body} /> : <p className="muted">No description.</p>}
              <button
                className="link small"
                onClick={() => {
                  setDraft(i.body);
                  setEditing(true);
                }}
              >
                Edit description
              </button>
            </>
          )}
        </div>
        <dl className="fields">
          <dt>Status</dt>
          <dd>
            <select value={i.status} onChange={(e) => onSave({ status: e.target.value as IssueStatus })} aria-label="Status">
              {ISSUE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </dd>
          <dt>Assignee</dt>
          <dd>
            <select value={i.assignee?.username ?? ""} onChange={(e) => onSave({ assignee: e.target.value || null })} aria-label="Assignee">
              <option value="">Unassigned</option>
              <optgroup label="People">
                {users.filter((u) => u.kind === "human").map((u) => (
                  <option key={u.id} value={u.username}>
                    {u.username}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Agents (starts work)">
                {users.filter((u) => u.kind === "bot").map((u) => (
                  <option key={u.id} value={u.username}>
                    {u.username}
                  </option>
                ))}
              </optgroup>
            </select>
          </dd>
          <dt>Labels</dt>
          <dd>
            <div className="row wrap">
              {i.labels.map((l) => (
                <LabelChip key={l.id} label={l} onRemove={() => onSave({ labels: i.labels.filter((x) => x.id !== l.id).map((x) => x.name) })} />
              ))}
            </div>
            <AddInput placeholder="Add labels" onAdd={(text) => onSave({ labels: [...i.labels.map((l) => l.name), ...parseLabels(text)] })} />
          </dd>
          <dt>Waits on</dt>
          <dd>
            <RefList base={base} refs={i.dependsOn} onRemove={(r) => onSave({ dependsOn: i.dependsOn.filter((d) => d.number !== r.number).map((d) => d.number) })} />
            <AddInput placeholder="#number" onAdd={(text) => onSave({ dependsOn: [...i.dependsOn.map((d) => d.number), ...parseNumbers(text)] })} />
          </dd>
          {i.blocks.length > 0 && (
            <>
              <dt>Blocks</dt>
              <dd>
                <RefList base={base} refs={i.blocks} />
              </dd>
            </>
          )}
          <dt>Parent</dt>
          <dd>
            {i.parentIssue ? (
              <RefList base={base} refs={[i.parentIssue]} onRemove={() => onSave({ parent: null })} />
            ) : (
              <AddInput placeholder="#number" onAdd={(text) => onSave({ parent: parseNumbers(text)[0] ?? null })} />
            )}
          </dd>
          <dt>Sub-issues</dt>
          <dd>
            <RefList base={base} refs={i.childIssues} />
            <Link className="small" to={`${base}/issues/new?parent=${i.number}`}>
              Add a sub-issue
            </Link>
          </dd>
        </dl>
      </div>
    </details>
  );
}

function RefList({ base, refs, onRemove }: { base: string; refs: IssueRef[]; onRemove?: (r: IssueRef) => void }) {
  if (refs.length === 0) return <div className="muted small">None</div>;
  return (
    <ul className="ref-list">
      {refs.map((r) => (
        <li key={r.number}>
          <IssueLink base={base} issue={r} />
          {onRemove && (
            <button className="label-x" onClick={() => onRemove(r)} aria-label={`Remove #${r.number}`}>
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function AddInput({ placeholder, onAdd }: { placeholder: string; onAdd: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim() && (await onAdd(text))) setText("");
  }
  return (
    <form onSubmit={submit}>
      <input className="small-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </form>
  );
}

function Timeline({ story }: { story: WorkItemStory }) {
  return (
    <details className="section details-block">
      <summary>
        <h2>Timeline</h2>
        <span className="muted small">{plural(story.timeline.length, "event")}</span>
      </summary>
      <ol className="timeline">
        {story.timeline.map((t, n) => (
          <li key={n}>
            <span className="muted small timeline-time">{timeAgo(t.at)}</span>
            <div>
              <div className="small">
                <Actor name={t.actor} bot={t.bot} />
              </div>
              <div className="timeline-text">
                {t.href ? <Link to={t.href}>{t.text}</Link> : <Markdown source={t.text} />}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

function CommentBox({ url, onPosted }: { url: string; onPosted: () => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`${url}/comments`, { body: { body: draft } });
      setDraft("");
      setError(null);
      onPosted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't post the comment");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="stack section" onSubmit={submit}>
      <MarkdownEditor value={draft} onChange={setDraft} rows={3} placeholder="Leave a comment for the record. To tell the agent what to do, use Request changes or Redirect above." />
      {error && <p className="error">{error}</p>}
      <div>
        <button type="submit" className="secondary" disabled={busy || !draft.trim()}>
          Comment
        </button>
      </div>
    </form>
  );
}
