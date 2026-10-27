import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Project, WorkspaceWithProjects } from "@cohort/shared";
import { api } from "../api.ts";
import { Form } from "../components/Form.tsx";
import { NameFields, useNameFields } from "../components/NameFields.tsx";
import { useApi } from "../hooks.ts";
import { timeAgo } from "../format.ts";

export function WorkspacePage() {
  const { workspace = "" } = useParams();
  const { data, error } = useApi<{ workspace: WorkspaceWithProjects }>(`/api/workspaces/${workspace}`);
  const [creating, setCreating] = useState(false);

  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  const w = data.workspace;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{w.name}</h1>
          {w.description && <p className="muted">{w.description}</p>}
        </div>
        {!creating && <button onClick={() => setCreating(true)}>New project</button>}
      </div>
      {creating && <NewProject workspace={w.slug} onCancel={() => setCreating(false)} />}
      {w.projects.length === 0 && !creating ? (
        <section className="panel empty">
          <h2>No projects yet</h2>
          <p className="muted">Each project is a git repo you can clone, push to and browse here.</p>
          <button onClick={() => setCreating(true)}>Create a project</button>
        </section>
      ) : (
        <section className="panel">
          <ul className="list">
            {w.projects.map((p) => (
              <li key={p.id} className="list-row">
                <div>
                  <Link to={`/${w.slug}/${p.slug}`}>
                    <strong>{p.name}</strong>
                  </Link>
                  {p.description && <div className="muted">{p.description}</div>}
                </div>
                <span className="muted">
                  {p.defaultBranch ? `Created ${timeAgo(p.createdAt)}` : "Empty"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function NewProject({ workspace, onCancel }: { workspace: string; onCancel: () => void }) {
  const navigate = useNavigate();
  const fields = useNameFields();
  const [description, setDescription] = useState("");
  const [initReadme, setInitReadme] = useState(true);

  async function create() {
    const { project } = await api<{ project: Project }>(`/api/workspaces/${workspace}/projects`, {
      body: { name: fields.name, slug: fields.slug, description, initReadme },
    });
    navigate(`/${workspace}/${project.slug}`);
  }

  return (
    <section className="panel">
      <h2>New project</h2>
      <Form onSubmit={create}>
        {(busy) => (
          <>
            <NameFields fields={fields} prefix={`${location.host}/${workspace}/`} />
            <label>
              Description <span className="muted">(optional)</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={initReadme} onChange={(e) => setInitReadme(e.target.checked)} />
              Start with a README
            </label>
            <div className="row">
              <button type="submit" disabled={busy}>
                Create project
              </button>
              <button type="button" className="secondary" onClick={onCancel}>
                Cancel
              </button>
            </div>
          </>
        )}
      </Form>
    </section>
  );
}
