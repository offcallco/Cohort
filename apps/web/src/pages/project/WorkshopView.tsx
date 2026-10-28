import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Job, ProposedIssue, WorkshopDetail } from "@cohort/shared";
import { api } from "../../api.ts";
import { IssueLink } from "../../components/IssueBits.tsx";
import { AgentName } from "../../components/Agent.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { useApi } from "../../hooks.ts";
import { useProject } from "./ProjectLayout.tsx";
import { SkeletonRows } from "../../components/Skeleton.tsx";

export function WorkshopView() {
  const { project, base } = useProject();
  const { id = "" } = useParams();
  const url = `/api/projects/${project.workspace}/${project.slug}/workshops/${id}`;
  const { data, error: loadError, reload } = useApi<{ workshop: WorkshopDetail }>(url, {
    pollMs: 1500,
    poll: (d) => d.workshop.waiting,
  });
  const [override, setOverride] = useState<WorkshopDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Responses from actions win until the next poll brings something newer.
  const w = override && data && override.updatedAt > data.workshop.updatedAt ? override : (data?.workshop ?? override);

  async function act(path: string, body?: object) {
    setBusy(true);
    try {
      const res = await api<{ workshop: WorkshopDetail }>(`${url}/${path}`, { method: "POST", body: body ?? {} });
      setOverride(res.workshop);
      setError(null);
      await reload();
      return res;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <p className="error">{loadError}</p>;
  if (!w) return <SkeletonRows rows={4} height={64} />;
  const failed = !w.waiting && w.job && (w.job.status === "failed" || w.job.status === "canceled");

  return (
    <>
      <div className="crumbs">
        <Link to={`${base}/workshops`}>Workshops</Link> / #{w.id}
      </div>
      <div className="page-head">
        <div>
          <h1>{w.title}</h1>
          <div className="muted small">
            With {w.bot}, reading <code>{w.baseBranch}</code>
            {w.status === "closed" && " · closed"}
          </div>
        </div>
        {w.status === "active" && (
          <button className="secondary" disabled={busy} onClick={() => act("close")}>
            Close workshop
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}

      <div className="workshop-layout">
        <section className="chat">
          {w.messageList.map((m) => (
            <div key={m.id} className={`bubble bubble-${m.role}`}>
              {m.role === "agent" && (
                <div className="bubble-who">
                  <AgentName name={w.bot} />
                </div>
              )}
              {m.role === "system" ? <p>{m.body}</p> : <Markdown source={m.body} />}
            </div>
          ))}
          {w.waiting && w.job && <Thinking job={w.job} bot={w.bot} />}
          {failed && (
            <div className="row">
              <button
                className="secondary small"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(`/api/jobs/${w.job!.id}/retry`, { method: "POST" });
                    await reload();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Couldn't retry");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Try that turn again
              </button>
              <Link className="small" to={`${base}/jobs/${w.job!.id}`}>
                See the log
              </Link>
            </div>
          )}
          {w.status === "active" && <Composer disabled={w.waiting || busy} onSend={(body) => act("messages", { body })} />}
        </section>

        <aside className="plan-panel">
          {w.status === "done" ? (
            <Created workshop={w} />
          ) : w.proposal && !w.waiting ? (
            <ProposalEditor
              key={w.updatedAt}
              proposal={w.proposal}
              busy={busy}
              onCreate={async (issues, parentIssue) => {
                await act("issues", { issues, parentIssue });
              }}
              onBack={() => setOverride({ ...w, proposal: null })}
            />
          ) : (
            <>
              <div className="row spread">
                <div className="panel-title">Plan</div>
                {w.status === "active" && (
                  <button className="small" disabled={w.waiting || busy || w.messageList.length < 2} onClick={() => act("propose")}>
                    Propose issues
                  </button>
                )}
              </div>
              {w.plan.trim() ? <Markdown source={w.plan} /> : <p className="muted">The agent writes the plan here as you talk.</p>}
            </>
          )}
        </aside>
      </div>
    </>
  );
}

// Shows the agent's live activity (files it reads, searches) while it works on a reply.
function Thinking({ job, bot }: { job: Job; bot: string }) {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    if (job.status !== "running") return;
    const source = new EventSource(`/api/jobs/${job.id}/events`);
    let text = "";
    let first = true;
    source.addEventListener("log", (e) => {
      const chunk = JSON.parse((e as MessageEvent).data) as string;
      text = first ? chunk : text + chunk;
      first = false;
      setLines(
        text
          .split("\n")
          .filter((l) => l.startsWith("→"))
          .slice(-4),
      );
    });
    return () => source.close();
  }, [job.id, job.status]);

  return (
    <div className="bubble bubble-agent thinking">
      <div className="bubble-who">{bot}</div>
      {job.status === "queued" ? (
        <p className="muted">{job.waitingReason ?? "Waiting for a runner"}. Your message will be answered when one is free.</p>
      ) : (
        <>
          <p className="muted">
            <span className="dots" /> Thinking
          </p>
          {lines.map((l, i) => (
            <div key={i} className="activity">
              {l.replace(/^→ /, "").replace(/\/.*\/worktrees\/[^/]+\//, "").replace(/\/.*\/workshops\/w-\d+\//, "")}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Composer({ disabled, onSend }: { disabled: boolean; onSend: (body: string) => Promise<unknown> }) {
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  async function send() {
    if (!draft.trim() || disabled) return;
    const res = await onSend(draft);
    if (res) setDraft("");
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  }

  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);

  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        placeholder={disabled ? "Waiting for the agent…" : "Answer the question, or push back. ⌘↵ to send"}
      />
      <button disabled={disabled || !draft.trim()} onClick={send}>
        Send
      </button>
    </div>
  );
}

// Edit the agent's proposed issues before creating them.
function ProposalEditor({
  proposal,
  busy,
  onCreate,
  onBack,
}: {
  proposal: ProposedIssue[];
  busy: boolean;
  onCreate: (issues: ProposedIssue[], parentIssue: boolean) => Promise<void>;
  onBack: () => void;
}) {
  const [issues, setIssues] = useState(proposal);
  const [parentIssue, setParentIssue] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const titleOf = (key: string) => issues.find((i) => i.key === key)?.title ?? key;

  const update = (key: string, change: Partial<ProposedIssue>) =>
    setIssues((list) => list.map((i) => (i.key === key ? { ...i, ...change } : i)));
  const remove = (key: string) =>
    setIssues((list) => list.filter((i) => i.key !== key).map((i) => ({ ...i, dependsOn: i.dependsOn.filter((d) => d !== key) })));

  return (
    <div className="stack">
      <div className="row spread">
        <div className="panel-title">Proposed issues ({issues.length})</div>
        <button className="link small" onClick={onBack}>
          Back to plan
        </button>
      </div>
      <p className="muted small">Edit or remove issues, then create them. Nothing is created until you do.</p>
      {issues.map((issue, index) => (
        <div key={issue.key} className="proposal">
          <div className="row spread">
            <span className="muted small">{index + 1}.</span>
            <input value={issue.title} onChange={(e) => update(issue.key, { title: e.target.value })} />
            <button className="label-x" onClick={() => remove(issue.key)} aria-label={`Remove ${issue.title}`}>
              ×
            </button>
          </div>
          {issue.dependsOn.length > 0 && (
            <div className="muted small">After: {issue.dependsOn.map(titleOf).join(", ")}</div>
          )}
          {open === issue.key ? (
            <>
              <textarea rows={6} value={issue.body} onChange={(e) => update(issue.key, { body: e.target.value })} />
              <input
                className="small-input"
                value={issue.labels.join(", ")}
                placeholder="Labels, comma-separated"
                onChange={(e) =>
                  update(issue.key, {
                    labels: e.target.value
                      .split(",")
                      .map((l) => l.trim())
                      .filter(Boolean),
                  })
                }
              />
              <button className="link small" onClick={() => setOpen(null)}>
                Done editing
              </button>
            </>
          ) : (
            <button className="link small" onClick={() => setOpen(issue.key)}>
              Edit description{issue.labels.length ? ` · ${issue.labels.join(", ")}` : ""}
            </button>
          )}
        </div>
      ))}
      <label className="checkbox small">
        <input type="checkbox" checked={parentIssue} onChange={(e) => setParentIssue(e.target.checked)} />
        Also create a "Plan" issue holding the plan, with these as its sub-issues
      </label>
      <button disabled={busy || issues.length === 0 || issues.some((i) => !i.title.trim())} onClick={() => onCreate(issues, parentIssue)}>
        Create {issues.length} {issues.length === 1 ? "issue" : "issues"}
      </button>
    </div>
  );
}

function Created({ workshop }: { workshop: WorkshopDetail }) {
  const { base } = useProject();
  const navigate = useNavigate();
  return (
    <div className="stack">
      <div className="panel-title">Issues created</div>
      {workshop.parentIssue && (
        <p>
          <IssueLink base={base} issue={workshop.parentIssue} />
        </p>
      )}
      <ul className="ref-list">
        {workshop.createdIssues.map((i) => (
          <li key={i.number}>
            <IssueLink base={base} issue={i} />
          </li>
        ))}
      </ul>
      <p className="muted small">Assign them to claude-bot or codex-bot to start the work.</p>
      <div>
        <button className="secondary small" onClick={() => navigate(`${base}/issues`)}>
          Go to issues
        </button>
      </div>
      <details>
        <summary className="muted small">Final plan</summary>
        <Markdown source={workshop.plan} />
      </details>
    </div>
  );
}
