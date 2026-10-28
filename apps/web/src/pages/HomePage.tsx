import { Link } from "react-router";
import type { WorkspaceWithProjects } from "@cohort/shared";
import { useApi } from "../hooks.ts";

export function HomePage() {
  const { data, error } = useApi<{ workspaces: WorkspaceWithProjects[] }>("/api/workspaces");
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;

  return (
    <>
      <div className="page-head">
        <h1>Workspaces</h1>
        <Link className="button" to="/new">
          New workspace
        </Link>
      </div>
      {data.workspaces.length === 0 ? (
        <section className="panel empty">
          <h2>No workspaces yet</h2>
          <p className="muted">A workspace groups related projects. Create one to add your first repo.</p>
          <Link className="button" to="/new">
            Create a workspace
          </Link>
        </section>
      ) : (
        data.workspaces.map((w) => (
          <section className="panel" key={w.id}>
            <h2>
              <Link to={`/${w.slug}`}>{w.name}</Link>
            </h2>
            {w.description && <p className="muted">{w.description}</p>}
            {w.projects.length === 0 ? (
              <p className="muted">No projects.</p>
            ) : (
              <ul className="list">
                {w.projects.map((p) => (
                  <li key={p.id}>
                    <Link to={`/${w.slug}/${p.slug}`}>{p.name}</Link>
                    {p.description && <span className="muted"> · {p.description}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </>
  );
}
