import { useState } from "react";
import type { Project } from "@cohort/shared";
import { api } from "../../api.ts";
import { Form } from "../../components/Form.tsx";
import { useProject } from "./ProjectLayout.tsx";

export function SettingsView() {
  const { project } = useProject();
  const [description, setDescription] = useState(project.description);
  const [context, setContext] = useState(project.runnerContext);
  const [saved, setSaved] = useState(false);

  async function save() {
    await api<{ project: Project }>(`/api/projects/${project.workspace}/${project.slug}`, {
      method: "PATCH",
      body: { description, runnerContext: context },
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <section className="panel">
      <h2>Project settings</h2>
      <Form onSubmit={save}>
        {(busy) => (
          <>
            <label>
              Description
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <label>
              Runner context
              <span className="muted small">
                Instructions sent to every agent job in this project, e.g. "Run pnpm test before finishing" or "Never edit
                generated files". Added to anything in the repo's CLAUDE.md or AGENTS.md.
              </span>
              <textarea rows={8} value={context} onChange={(e) => setContext(e.target.value)} />
            </label>
            <div className="row">
              <button type="submit" disabled={busy}>
                Save
              </button>
              {saved && <span className="muted">Saved</span>}
            </div>
          </>
        )}
      </Form>
    </section>
  );
}
