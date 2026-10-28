import { useState } from "react";
import { Link, NavLink, Outlet, useLocation, useOutletContext, useParams, useSearchParams } from "react-router";
import { Check, Copy, GitBranch } from "lucide-react";
import type { Branch, Project } from "@cohort/shared";
import { SkeletonRows } from "../../components/Skeleton.tsx";
import { useApi } from "../../hooks.ts";

export interface ProjectContext {
  project: Project;
  branches: Branch[];
  base: string;
  // The ref being viewed: ?ref= or the default branch.
  ref: string | null;
}

export const useProject = () => useOutletContext<ProjectContext>();

// The four sections of a repo, and the routes under each.
const SECTIONS = [
  { key: "code", label: "Code", match: ["", "tree", "blob", "commits", "commit", "branches"] },
  { key: "work", label: "Work", match: ["issues", "merge_requests", "workshops"] },
  { key: "runs", label: "Runs", match: ["jobs", "pipelines"] },
  { key: "settings", label: "Settings", match: ["settings"] },
] as const;

const SUBNAV: Record<string, { to: string; label: string }[]> = {
  code: [
    { to: "", label: "Files" },
    { to: "/commits", label: "Commits" },
    { to: "/branches", label: "Branches" },
  ],
  work: [
    { to: "/issues", label: "Issues" },
    { to: "/merge_requests", label: "Merge requests" },
    { to: "/workshops", label: "Workshops" },
  ],
  runs: [
    { to: "/jobs", label: "Agent runs" },
    { to: "/pipelines", label: "Pipelines" },
  ],
};

// Detail pages (one issue, one MR, one run...) skip the repo chrome; the top bar says where you are.
const DETAIL = /^\/[^/]+\/[^/]+\/(issues\/\d+|merge_requests\/\d+|jobs\/\d+|pipelines\/\d+|workshops\/\d+|commit\/[0-9a-f]+)$/;

export function ProjectLayout() {
  const { workspace = "", project: slug = "" } = useParams();
  const [search] = useSearchParams();
  const location = useLocation();
  const { data, error } = useApi<{ project: Project; branches: Branch[] }>(`/api/projects/${workspace}/${slug}`);

  if (error) return <p className="error">Couldn't load {workspace}/{slug}: {error}</p>;
  if (!data) return <SkeletonRows rows={4} height={48} />;
  const { project, branches } = data;
  const base = `/${workspace}/${slug}`;
  const ref = search.get("ref") ?? project.defaultBranch;
  const context = { project, branches, base, ref } satisfies ProjectContext;

  if (DETAIL.test(location.pathname)) return <Outlet context={context} />;

  const segment = location.pathname.slice(base.length).split("/")[1] ?? "";
  const section = SECTIONS.find((s) => (s.match as readonly string[]).includes(segment)) ?? SECTIONS[0];
  const refQuery = ref && ref !== project.defaultBranch ? `?ref=${encodeURIComponent(ref)}` : "";

  return (
    <>
      <header className="repo-head">
        <div className="repo-title">
          <h1>
            <Link to={`/${workspace}`} className="muted">
              {workspace}
            </Link>
            <span className="muted"> / </span>
            {project.name}
          </h1>
          {project.description && <p className="muted">{project.description}</p>}
        </div>
        <div className="repo-facts">
          {project.defaultBranch && (
            <span className="meta">
              <span className="mono">
                <GitBranch size={12} aria-hidden /> {project.defaultBranch}
              </span>
              <span>{branches.length} branches</span>
            </span>
          )}
          <CloneBox path={project.clonePath} />
        </div>
      </header>
      <nav className="tabs" aria-label="Repo">
        {SECTIONS.map((s) => (
          <Link key={s.key} to={`${base}${s.key === "code" ? refQuery : SUBNAV[s.key]?.[0]?.to ?? `/${s.key}`}`} className={s === section ? "active" : ""} aria-current={s === section ? "page" : undefined}>
            {s.label}
          </Link>
        ))}
      </nav>
      {SUBNAV[section.key] && (
        <nav className="subnav" aria-label={`${section.label} views`}>
          {SUBNAV[section.key]!.map((item) => (
            <NavLink key={item.to} to={`${base}${item.to}${section.key === "code" && item.to !== "/branches" ? refQuery : ""}`} end={item.to === ""}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      )}
      <Outlet context={context} />
    </>
  );
}

function CloneBox({ path }: { path: string }) {
  const command = `git clone ${location.origin}${path}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="clone">
      <code title={command}>{command}</code>
      <button
        className="secondary small"
        aria-label="Copy the clone command"
        onClick={async () => {
          await navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
