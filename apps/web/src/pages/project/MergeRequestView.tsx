import { useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { MergeRequestDetail } from "@cohort/shared";
import { api } from "../../api.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { MarkdownEditor } from "../../components/MarkdownEditor.tsx";
import { JobStatusPill, MergeRequestPill } from "../../components/Pills.tsx";
import { shortSha, timeAgo } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { FileDiffView } from "./CommitView.tsx";
import { PipelineLink } from "../../components/PipelineBits.tsx";
import { useProject } from "./ProjectLayout.tsx";

export function MergeRequestView() {
  const { project, base } = useProject();
  const { number = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const tab = search.get("tab") ?? "overview";
  const url = `/api/projects/${project.workspace}/${project.slug}/merge_requests/${number}`;
  const { data, error: loadError } = useApi<{ mergeRequest: MergeRequestDetail }>(url);
  const [mr, setMr] = useState<MergeRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteSource, setDeleteSource] = useState(true);

  const current = mr && String(mr.number) === number ? mr : (data?.mergeRequest ?? null);

  async function runPipeline(id: number) {
    try {
      await api(`/api/projects/${project.workspace}/${project.slug}/pipelines/${id}/run`, { method: "POST" });
      const res = await api<{ mergeRequest: MergeRequestDetail }>(url);
      setMr(res.mergeRequest);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the pipeline");
    }
  }

  async function act(path: string, body?: object) {
    setBusy(true);
    try {
      const res = await api<{ mergeRequest: MergeRequestDetail }>(`${url}/${path}`, { method: "POST", body: body ?? {} });
      setMr(res.mergeRequest);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <p className="error">{loadError}</p>;
  if (!current) return null;
  const m = current;
  const pipelineBlocks = m.status === "open" && m.pipelinesMustSucceed && m.pipeline?.status !== "success";
  const additions = m.files.reduce((n, f) => n + f.additions, 0);
  const deletions = m.files.reduce((n, f) => n + f.deletions, 0);

  return (
    <>
      <div className="crumbs">
        <Link to={`${base}/merge_requests`}>Merge requests</Link> / !{m.number}
      </div>
      <h1>
        {m.title} <span className="muted">!{m.number}</span>
      </h1>
      <div className="muted issue-byline">
        <MergeRequestPill status={m.status} />
        <span>
          {m.author.username} wants to merge <code>{m.sourceBranch}</code> into <code>{m.targetBranch}</code> · opened{" "}
          {timeAgo(m.createdAt)}
          {m.issue && (
            <>
              {" · resolves "}
              <Link to={`${base}/issues/${m.issue.number}`}>
                #{m.issue.number} {m.issue.title}
              </Link>
            </>
          )}
        </span>
      </div>

      <nav className="tabs">
        {[
          ["overview", "Overview"],
          ["commits", `Commits (${m.commits.length})`],
          ["changes", `Changes (${m.files.length})`],
        ].map(([key, label]) => (
          <button key={key} className={`tab${tab === key ? " active" : ""}`} onClick={() => setSearch(key === "overview" ? {} : { tab: key! })}>
            {label}
          </button>
        ))}
      </nav>
      {error && <p className="error">{error}</p>}

      {tab === "overview" && (
        <>
          <section className="panel">
            {m.description.trim() ? <Markdown source={m.description} /> : <p className="muted">No description.</p>}
          </section>

          {m.jobs.length > 0 && (
            <section className="panel">
              <div className="panel-title">Agent jobs</div>
              <ul className="list">
                {m.jobs.map((j) => (
                  <li key={j.id} className="row wrap">
                    <Link to={`${base}/jobs/${j.id}`}>Job #{j.id}</Link>
                    <JobStatusPill status={j.status} />
                    <span className="muted small">
                      {j.bot} · {timeAgo(j.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {m.pipeline && (
            <section className="panel row spread">
              <PipelineLink base={base} pipeline={m.pipeline} />
              {m.pipeline.status === "manual" && (
                <button className="small" disabled={busy} onClick={() => runPipeline(m.pipeline!.id)}>
                  Run pipeline
                </button>
              )}
            </section>
          )}

          <section className={`panel merge-box merge-${m.status}`}>
            {m.status === "merged" && (
              <p>
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
              </p>
            )}
            {m.status === "closed" && (
              <div className="row spread">
                <p>This merge request is closed.</p>
                <button className="secondary" disabled={busy} onClick={() => act("reopen")}>
                  Reopen
                </button>
              </div>
            )}
            {m.status === "open" && (
              <div className="stack">
                {m.mergeable === null && <p className="muted">One of the branches is missing, so this can't be merged.</p>}
                {m.mergeable === false && (
                  <p className="error">
                    These branches have conflicts. Resolve them on <code>{m.sourceBranch}</code> and push again.
                  </p>
                )}
                {m.mergeable && m.commits.length === 0 && <p className="muted">There's nothing to merge.</p>}
                {m.mergeable && m.commits.length > 0 && !pipelineBlocks && <p>Ready to merge.</p>}
                {pipelineBlocks && (
                  <p className="muted">
                    This project requires a passing pipeline before merging
                    {m.pipeline ? ` (the pipeline is ${m.pipeline.status === "manual" ? "waiting to run" : m.pipeline.status}).` : ", and this branch has none."}
                  </p>
                )}
                <div className="row wrap">
                  <button disabled={busy || !m.mergeable || m.commits.length === 0 || pipelineBlocks} onClick={() => act("merge", { deleteSourceBranch: deleteSource })}>
                    Merge
                  </button>
                  <label className="checkbox">
                    <input type="checkbox" checked={deleteSource} onChange={(e) => setDeleteSource(e.target.checked)} />
                    Delete source branch
                  </label>
                  <div className="spacer" />
                  <button className="secondary" disabled={busy} onClick={() => act("close")}>
                    Close
                  </button>
                </div>
              </div>
            )}
          </section>

          <MergeRequestComments mr={m} onPost={(body) => act("comments", { body })} />
        </>
      )}

      {tab === "commits" && (
        <section className="panel flush">
          {m.commits.length === 0 ? (
            <p className="muted pad">No commits.</p>
          ) : (
            <ul className="list">
              {m.commits.map((c) => (
                <li key={c.sha} className="list-row">
                  <div>
                    <Link to={`${base}/commit/${c.sha}`}>{c.subject}</Link>
                    <div className="muted small">
                      {c.authorName} committed {timeAgo(c.date)}
                    </div>
                  </div>
                  <Link className="sha" to={`${base}/commit/${c.sha}`}>
                    {shortSha(c.sha)}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "changes" && (
        <>
          <p className="muted">
            {m.files.length} {m.files.length === 1 ? "file" : "files"} changed, <span className="add">+{additions}</span>{" "}
            <span className="del">−{deletions}</span>
          </p>
          {m.files.map((f, i) => (
            <FileDiffView key={i} file={f} />
          ))}
        </>
      )}
    </>
  );
}

function MergeRequestComments({ mr, onPost }: { mr: MergeRequestDetail; onPost: (body: string) => Promise<void> }) {
  const [draft, setDraft] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    await onPost(draft);
    setDraft("");
  }
  return (
    <>
      <h2 className="section-title">
        {mr.comments.length} {mr.comments.length === 1 ? "comment" : "comments"}
      </h2>
      {mr.comments.map((c) => (
        <section className="panel comment" key={c.id}>
          <div className="muted small">
            <strong>{c.author.username}</strong> commented {timeAgo(c.createdAt)}
          </div>
          <Markdown source={c.body} />
        </section>
      ))}
      <form className="stack" onSubmit={submit}>
        <MarkdownEditor value={draft} onChange={setDraft} rows={4} placeholder="Leave a comment" />
        <div>
          <button type="submit" disabled={!draft.trim()}>
            Comment
          </button>
        </div>
      </form>
    </>
  );
}
