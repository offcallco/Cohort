import { useState } from "react";
import { useNavigate } from "react-router";
import type { MergeRequestDetail } from "@cohort/shared";
import { api } from "../../api.ts";
import { Form } from "../../components/Form.tsx";
import { MarkdownEditor } from "../../components/MarkdownEditor.tsx";
import { useProject } from "./ProjectLayout.tsx";

export function NewMergeRequestView() {
  const { project, base, branches } = useProject();
  const navigate = useNavigate();
  const others = branches.filter((b) => b.name !== project.defaultBranch);
  const [source, setSource] = useState(others[0]?.name ?? "");
  const [target, setTarget] = useState(project.defaultBranch ?? "");
  const [title, setTitle] = useState(others[0]?.subject ?? "");
  const [description, setDescription] = useState("");

  async function create() {
    const { mergeRequest } = await api<{ mergeRequest: MergeRequestDetail }>(
      `/api/projects/${project.workspace}/${project.slug}/merge_requests`,
      { body: { title, description, sourceBranch: source, targetBranch: target } },
    );
    navigate(`${base}/merge_requests/${mergeRequest.number}`);
  }

  if (branches.length < 2) {
    return (
      <section className="panel empty">
        <h2>Nothing to merge yet</h2>
        <p className="muted">Push another branch first; a merge request compares two branches.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>New merge request</h2>
      <Form onSubmit={create}>
        {(busy) => (
          <>
            <div className="grid-2">
              <label>
                Source branch
                <select
                  value={source}
                  onChange={(e) => {
                    setSource(e.target.value);
                    if (!title) setTitle(branches.find((b) => b.name === e.target.value)?.subject ?? "");
                  }}
                >
                  {branches.map((b) => (
                    <option key={b.name}>{b.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Target branch
                <select value={target} onChange={(e) => setTarget(e.target.value)}>
                  {branches.map((b) => (
                    <option key={b.name}>{b.name}</option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </label>
            <label>
              Description
              <MarkdownEditor value={description} onChange={setDescription} rows={6} />
            </label>
            <div className="row">
              <button type="submit" disabled={busy}>
                Create merge request
              </button>
              <button type="button" className="secondary" onClick={() => navigate(`${base}/merge_requests`)}>
                Cancel
              </button>
            </div>
          </>
        )}
      </Form>
    </section>
  );
}
