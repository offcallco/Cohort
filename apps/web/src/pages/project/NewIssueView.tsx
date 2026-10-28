import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ISSUE_STATUSES, STATUS_LABELS, type IssueDetail, type IssueStatus } from "@cohort/shared";
import { api } from "../../api.ts";
import { Form } from "../../components/Form.tsx";
import { MarkdownEditor } from "../../components/MarkdownEditor.tsx";
import { useProject } from "./ProjectLayout.tsx";

// "#3, 5 #7" → [3, 5, 7]
export const parseNumbers = (text: string) =>
  [...text.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n > 0);

export const parseLabels = (text: string) =>
  text
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

export function NewIssueView() {
  const { project, base } = useProject();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<IssueStatus>("todo");
  const [labels, setLabels] = useState("");
  const [parent, setParent] = useState(search.get("parent") ?? "");
  const [dependsOn, setDependsOn] = useState("");

  async function create() {
    const parentNumber = parseNumbers(parent)[0] ?? null;
    const { issue } = await api<{ issue: IssueDetail }>(`/api/projects/${project.workspace}/${project.slug}/issues`, {
      body: { title, body, status, labels: parseLabels(labels), parent: parentNumber, dependsOn: parseNumbers(dependsOn) },
    });
    navigate(`${base}/issues/${issue.number}`);
  }

  return (
    <section className="panel">
      <h2>New issue</h2>
      <Form onSubmit={create}>
        {(busy) => (
          <>
            <label>
              Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required />
            </label>
            <label>
              Description
              <MarkdownEditor value={body} onChange={setBody} placeholder="What needs to happen? Markdown works." />
            </label>
            <div className="grid-2">
              <label>
                Status
                <select value={status} onChange={(e) => setStatus(e.target.value as IssueStatus)}>
                  {ISSUE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Labels <span className="muted">(comma-separated)</span>
                <input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="backend, auth" />
              </label>
              <label>
                Parent issue <span className="muted">(optional)</span>
                <input value={parent} onChange={(e) => setParent(e.target.value)} placeholder="#12" />
              </label>
              <label>
                Waits on <span className="muted">(optional)</span>
                <input value={dependsOn} onChange={(e) => setDependsOn(e.target.value)} placeholder="#3, #4" />
              </label>
            </div>
            <div className="row">
              <button type="submit" disabled={busy}>
                Create issue
              </button>
              <button type="button" className="secondary" onClick={() => navigate(`${base}/issues`)}>
                Cancel
              </button>
            </div>
          </>
        )}
      </Form>
    </section>
  );
}
