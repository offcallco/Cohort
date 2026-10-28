import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { GitBranch, HelpCircle } from "lucide-react";
import type { MergeRequestDetail } from "@cohort/shared";
import { api } from "../../api.ts";
import { Actor } from "../../components/Agent.tsx";
import { ChecksPanel } from "../../components/ChecksPanel.tsx";
import { DiffViewer, type LineTarget } from "../../components/DiffViewer.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { MarkdownEditor } from "../../components/MarkdownEditor.tsx";
import { MergeRequestPill } from "../../components/Pills.tsx";
import { SkeletonRows } from "../../components/Skeleton.tsx";
import { plural, shortSha, timeAgo } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { useProject } from "./ProjectLayout.tsx";

// Sentences where the agent says it isn't sure, so they can't hide in the summary.
function uncertainties(text: string) {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/[*_#>-]+/g, " ").trim())
    .filter((s) => /\b(unsure|not sure|wasn't sure|uncertain|please check|couldn't (run|verify|test))\b/i.test(s));
}

// The review page: agent summary first, then the diff with checks beside it, then the gate.
export function MergeRequestView() {
  const { project, base } = useProject();
  const { number = "" } = useParams();
  const [hideWhitespace, setHideWhitespace] = useState(false);
  const url = `/api/projects/${project.workspace}/${project.slug}/merge_requests/${number}`;
  const { data, error: loadError, reload } = useApi<{ mergeRequest: MergeRequestDetail }>(`${url}${hideWhitespace ? "?whitespace=hide" : ""}`, {
    pollMs: 4000,
    poll: (d) => d.mergeRequest.status === "open",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteSource, setDeleteSource] = useState(true);
  const [confirmClose, setConfirmClose] = useState(false);

  async function act(path: string, body?: object) {
    setBusy(true);
    try {
      await api(path.startsWith("/") ? path : `${url}/${path}`, { method: "POST", body: body ?? {} });
      setError(null);
      await reload();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="panel">
        <p className="error">Couldn't load !{number}: {loadError}</p>
        <button className="secondary" onClick={reload}>
          Try again
        </button>
      </div>
    );
  }
  if (!data) return <SkeletonRows rows={5} height={56} />;
  const m = data.mergeRequest;
  const additions = m.files.reduce((n, f) => n + f.additions, 0);
  const deletions = m.files.reduce((n, f) => n + f.deletions, 0);
  const unsure = uncertainties(m.description);
  const lineComments = m.comments.filter((c) => c.path);
  const discussion = m.comments.filter((c) => !c.path);
  const issueBase = m.issue ? `${base}/issues/${m.issue.number}` : null;

  const blocked =
    m.status !== "open"
      ? null
      : m.mergeable === false
        ? `The branches conflict. Resolve them on ${m.sourceBranch} and push again.`
        : m.mergeable === null
          ? "One of the branches is missing."
          : m.commits.length === 0
            ? "There's nothing to merge."
            : m.pipelinesMustSucceed && m.pipeline?.status !== "success"
              ? m.pipeline?.status === "manual"
                ? "This project needs a passing pipeline. Start it first."
                : `This project needs a passing pipeline (it's ${m.pipeline ? m.pipeline.status : "missing"}).`
              : null;

  return (
    <>
      <header className="work-header">
        <h1>
          {m.title} <span className="muted">!{m.number}</span>
        </h1>
        <div className="meta">
          <MergeRequestPill status={m.status} />
          <Actor name={m.author.username} bot={m.author.kind === "bot"} />
          <span className="mono">
            <GitBranch size={12} aria-hidden /> {m.sourceBranch} → {m.targetBranch}
          </span>
          <span>
            {plural(m.files.length, "file")} · <span className="add">+{additions}</span> <span className="del">−{deletions}</span>
          </span>
          <span>opened {timeAgo(m.createdAt)}</span>
          {m.issue && issueBase && (
            <span>
              for <Link to={issueBase}>#{m.issue.number} {m.issue.title}</Link>
            </span>
          )}
        </div>
      </header>

      <section className="section">
        <h2>{m.author.kind === "bot" ? "What the agent says it did" : "Description"}</h2>
        {unsure.length > 0 && (
          <div className="unsure">
            <HelpCircle size={16} aria-hidden />
            <div>
              <strong>The agent is unsure about:</strong>
              <ul>
                {unsure.map((u, n) => (
                  <li key={n}>{u}</li>
                ))}
              </ul>
              {issueBase && m.status === "open" && (
                <Link className="small" to={`${issueBase}#gate`}>
                  Answer it with Request changes on the issue
                </Link>
              )}
            </div>
          </div>
        )}
        <div className="prose-block">{m.description.trim() ? <Markdown source={m.description} /> : <p className="muted">No description.</p>}</div>
      </section>

      <section className={`gate gate-${m.status === "open" ? (blocked ? "idle" : "waiting") : m.status === "merged" ? "passed" : "idle"}`} id="gate">
        {m.status === "merged" ? (
          <div className="gate-headline">
            Merged {m.mergedAt && timeAgo(m.mergedAt)}
            {m.mergeSha && (
              <>
                {" as "}
                <Link className="sha" to={`${base}/commit/${m.mergeSha}`}>
                  {shortSha(m.mergeSha)}
                </Link>
              </>
            )}
            .
          </div>
        ) : m.status === "closed" ? (
          <div className="row spread">
            <div className="gate-headline">Closed without merging.</div>
            <button className="secondary" disabled={busy} onClick={() => act("reopen")}>
              Reopen
            </button>
          </div>
        ) : (
          <>
            <div className="gate-headline">{blocked ? "Not ready to merge." : `Ready to merge into ${m.targetBranch}.`}</div>
            <div className="row wrap">
              <button disabled={busy || blocked !== null} onClick={() => act("merge", { deleteSourceBranch: deleteSource })}>
                Approve & merge
              </button>
              <label className="checkbox small">
                <input type="checkbox" checked={deleteSource} onChange={(e) => setDeleteSource(e.target.checked)} />
                Delete {m.sourceBranch} after merging
              </label>
              <div className="spacer" />
              {issueBase && m.author.kind === "bot" && (
                <Link className="button secondary" to={`${issueBase}#gate`}>
                  Request changes
                </Link>
              )}
              {confirmClose ? (
                <>
                  <span className="muted small">Close without merging? The branch stays.</span>
                  <button className="danger" disabled={busy} onClick={() => act("close").then(() => setConfirmClose(false))}>
                    Close it
                  </button>
                  <button className="link" onClick={() => setConfirmClose(false)}>
                    Keep open
                  </button>
                </>
              ) : (
                <button className="danger" onClick={() => setConfirmClose(true)}>
                  Close
                </button>
              )}
            </div>
            {blocked && <p className="muted small gate-reason">Can't merge yet: {blocked}</p>}
          </>
        )}
        {error && <p className="error small">{error}</p>}
      </section>

      <div className="review-layout">
        <section className="section review-diff" aria-label="Changes">
          <div className="row spread">
            <h2>Changes</h2>
            {m.commits.length > 0 && (
              <details className="commits-inline">
                <summary className="small">{plural(m.commits.length, "commit")}</summary>
                <ul className="check-list">
                  {m.commits.map((c) => (
                    <li key={c.sha}>
                      <Link className="sha" to={`${base}/commit/${c.sha}`}>
                        {shortSha(c.sha)}
                      </Link>
                      <span>{c.subject}</span>
                      <span className="muted small">
                        {c.authorName} · {timeAgo(c.date)}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          <DiffViewer
            files={m.files}
            comments={lineComments}
            whitespaceHidden={hideWhitespace}
            onToggleWhitespace={() => setHideWhitespace(!hideWhitespace)}
            onComment={m.status === "open" ? (target: LineTarget, body: string) => act("comments", { body, ...target }) : undefined}
          />
        </section>
        <ChecksPanel project={`${project.workspace}/${project.slug}`} pipeline={m.pipeline} onRun={m.pipeline ? () => act(`/api/projects/${project.workspace}/${project.slug}/pipelines/${m.pipeline!.id}/run`) : undefined} />
      </div>

      <Discussion comments={discussion} onPost={(body) => act("comments", { body })} />
    </>
  );
}

function Discussion({ comments, onPost }: { comments: MergeRequestDetail["comments"]; onPost: (body: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await onPost(draft)) setDraft("");
  }
  return (
    <section className="section">
      <h2>Discussion</h2>
      {comments.length === 0 && <p className="muted small">No comments yet. Comment on a line from the diff, or on the whole change here.</p>}
      {comments.map((c) => (
        <div className="line-thread" key={c.id}>
          <div className="meta">
            <Actor name={c.author.username} bot={c.author.kind === "bot"} />
            <span>{timeAgo(c.createdAt)}</span>
          </div>
          <Markdown source={c.body} />
        </div>
      ))}
      <form className="stack" onSubmit={submit}>
        <MarkdownEditor value={draft} onChange={setDraft} rows={3} placeholder="Comment on the whole change" />
        <div>
          <button type="submit" className="secondary" disabled={!draft.trim()}>
            Comment
          </button>
        </div>
      </form>
    </section>
  );
}
