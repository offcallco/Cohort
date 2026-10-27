import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
  ISSUE_STATUSES,
  STATUS_LABELS,
  type IssueDetail,
  type IssueRef,
  type IssueStatus,
  type UpdateIssueBody,
  type User,
} from "@cohort/shared";
import { api } from "../../api.ts";
import { IssueLink, LabelChip, StatusBadge } from "../../components/IssueBits.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { MarkdownEditor } from "../../components/MarkdownEditor.tsx";
import { timeAgo } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { parseLabels, parseNumbers } from "./NewIssueView.tsx";
import { useProject } from "./ProjectLayout.tsx";

export function IssueView() {
  const { project, base } = useProject();
  const { number = "" } = useParams();
  const url = `/api/projects/${project.workspace}/${project.slug}/issues/${number}`;
  const { data, error: loadError, reload } = useApi<{ issue: IssueDetail }>(url);
  const users = useApi<{ users: User[] }>("/api/users").data?.users ?? [];
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current = issue && String(issue.number) === number ? issue : (data?.issue ?? null);

  async function save(changes: UpdateIssueBody) {
    try {
      const res = await api<{ issue: IssueDetail }>(url, { method: "PATCH", body: changes });
      setIssue(res.issue);
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
      return false;
    }
  }

  if (loadError) return <p className="error">{loadError}</p>;
  if (!current) return null;
  const i = current;

  return (
    <>
      <div className="crumbs">
        <Link to={`${base}/issues`}>Issues</Link> / #{i.number}
      </div>
      <TitleEditor issue={i} onSave={(title) => save({ title })} />
      <div className="muted issue-byline">
        <StatusBadge status={i.status} /> Opened {timeAgo(i.createdAt)} by {i.author.username}
      </div>
      {error && <p className="error">{error}</p>}

      <div className="issue-layout">
        <div className="issue-body">
          <BodyEditor body={i.body} onSave={(body) => save({ body })} />
          <Comments
            issue={i}
            url={url}
            onAdded={(updated) => {
              setIssue(updated);
              void reload();
            }}
          />
        </div>

        <aside className="sidebar">
          <Field title="Status">
            <select value={i.status} onChange={(e) => save({ status: e.target.value as IssueStatus })}>
              {ISSUE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field title="Assignee">
            <select value={i.assignee?.username ?? ""} onChange={(e) => save({ assignee: e.target.value || null })}>
              <option value="">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.username}>
                  {u.username}
                </option>
              ))}
            </select>
          </Field>
          <Field title="Labels">
            <div className="row wrap">
              {i.labels.map((l) => (
                <LabelChip
                  key={l.id}
                  label={l}
                  onRemove={() => save({ labels: i.labels.filter((x) => x.id !== l.id).map((x) => x.name) })}
                />
              ))}
            </div>
            <AddInput
              placeholder="Add labels"
              onAdd={(text) => save({ labels: [...i.labels.map((l) => l.name), ...parseLabels(text)] })}
            />
          </Field>
          <Field title="Parent">
            {i.parentIssue ? (
              <RefList base={base} refs={[i.parentIssue]} onRemove={() => save({ parent: null })} />
            ) : (
              <AddInput placeholder="#number" onAdd={(text) => save({ parent: parseNumbers(text)[0] ?? null })} />
            )}
          </Field>
          <Field title="Waits on">
            <RefList
              base={base}
              refs={i.dependsOn}
              onRemove={(r) => save({ dependsOn: i.dependsOn.filter((d) => d.number !== r.number).map((d) => d.number) })}
            />
            <AddInput
              placeholder="#number"
              onAdd={(text) => save({ dependsOn: [...i.dependsOn.map((d) => d.number), ...parseNumbers(text)] })}
            />
          </Field>
          {i.blocks.length > 0 && (
            <Field title="Blocks">
              <RefList base={base} refs={i.blocks} />
            </Field>
          )}
          <Field title="Sub-issues">
            <RefList base={base} refs={i.childIssues} />
            <Link className="small" to={`${base}/issues/new?parent=${i.number}`}>
              + Add sub-issue
            </Link>
          </Field>
        </aside>
      </div>
    </>
  );
}

function Field({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-title">{title}</div>
      {children}
    </div>
  );
}

function RefList({ base, refs, onRemove }: { base: string; refs: IssueRef[]; onRemove?: (r: IssueRef) => void }) {
  if (refs.length === 0) return <div className="muted small">None</div>;
  return (
    <ul className="ref-list">
      {refs.map((r) => (
        <li key={r.number}>
          <IssueLink base={base} issue={r} />
          {r.status === "done" && <span className="muted small"> ✓</span>}
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

// Small inline input that submits on Enter and clears on success.
function AddInput({ placeholder, onAdd }: { placeholder: string; onAdd: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim() && (await onAdd(text))) setText("");
  }
  return (
    <form onSubmit={submit}>
      <input className="small-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
    </form>
  );
}

function TitleEditor({ issue, onSave }: { issue: IssueDetail; onSave: (title: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(issue.title);
  if (!editing) {
    return (
      <div className="page-head">
        <h1>
          {issue.title} <span className="muted">#{issue.number}</span>
        </h1>
        <button
          className="secondary small"
          onClick={() => {
            setTitle(issue.title);
            setEditing(true);
          }}
        >
          Edit title
        </button>
      </div>
    );
  }
  return (
    <form
      className="row title-edit"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await onSave(title)) setEditing(false);
      }}
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <button type="submit">Save</button>
      <button type="button" className="secondary" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  );
}

function BodyEditor({ body, onSave }: { body: string; onSave: (body: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  if (editing) {
    return (
      <section className="panel stack">
        <MarkdownEditor value={draft} onChange={setDraft} rows={12} autoFocus />
        <div className="row">
          <button onClick={async () => (await onSave(draft)) && setEditing(false)}>Save</button>
          <button className="secondary" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="panel">
      <div className="panel-actions">
        <button
          className="secondary small"
          onClick={() => {
            setDraft(body);
            setEditing(true);
          }}
        >
          Edit
        </button>
      </div>
      {body.trim() ? <Markdown source={body} /> : <p className="muted">No description.</p>}
    </section>
  );
}

function Comments({ issue, url, onAdded }: { issue: IssueDetail; url: string; onAdded: (i: IssueDetail) => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ issue: IssueDetail }>(`${url}/comments`, { body: { body: draft } });
      setDraft("");
      setError(null);
      onAdded(res.issue);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't post the comment");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 className="section-title">
        {issue.commentList.length} {issue.commentList.length === 1 ? "comment" : "comments"}
      </h2>
      {issue.commentList.map((c) => (
        <section className="panel comment" key={c.id}>
          <div className="muted small">
            <strong>{c.author.username}</strong> commented {timeAgo(c.createdAt)}
          </div>
          <Markdown source={c.body} />
        </section>
      ))}
      <form className="stack" onSubmit={submit}>
        <MarkdownEditor value={draft} onChange={setDraft} rows={4} placeholder="Leave a comment" />
        {error && <p className="error">{error}</p>}
        <div>
          <button type="submit" disabled={busy || !draft.trim()}>
            Comment
          </button>
        </div>
      </form>
    </>
  );
}
