import { useState } from "react";
import { Link, NavLink, Outlet, useOutletContext, useParams, useSearchParams } from "react-router";
import type { Branch, Project } from "@cohort/shared";
import { useApi } from "../../hooks.ts";

export interface ProjectContext {
  project: Project;
  branches: Branch[];
  base: string;
  // The ref being viewed: ?ref= or the default branch.
  ref: string | null;
}

export const useProject = () => useOutletContext<ProjectContext>();

export function ProjectLayout() {
  const { workspace = "", project: slug = "" } = useParams();
  const [search] = useSearchParams();
  const { data, error } = useApi<{ project: Project; branches: Branch[] }>(
    `/api/projects/${workspace}/${slug}`,
  );

  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  const { project, branches } = data;
  const base = `/${workspace}/${slug}`;
  const ref = search.get("ref") ?? project.defaultBranch;
  const refQuery = ref && ref !== project.defaultBranch ? `?ref=${encodeURIComponent(ref)}` : "";

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">
            <Link to={`/${workspace}`}>{workspace}</Link> /
          </div>
          <h1>{project.name}</h1>
          {project.description && <p className="muted">{project.description}</p>}
        </div>
        <CloneBox path={project.clonePath} />
      </div>
      <nav className="tabs">
        <NavLink to={`${base}${refQuery}`} end>
          Files
        </NavLink>
        <NavLink to={`${base}/issues`}>Issues</NavLink>
        {project.defaultBranch && (
          <>
            <NavLink to={`${base}/commits${refQuery}`}>Commits</NavLink>
            <NavLink to={`${base}/branches`}>Branches ({branches.length})</NavLink>
          </>
        )}
      </nav>
      <Outlet context={{ project, branches, base, ref } satisfies ProjectContext} />
    </>
  );
}

function CloneBox({ path }: { path: string }) {
  const url = `${location.origin}${path}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="clone">
      <code>{url}</code>
      <button
        className="secondary"
        onClick={async () => {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
