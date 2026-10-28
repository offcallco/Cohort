import { Link, useLocation, useSearchParams } from "react-router";
import type { Blob, IssueSummary, Job, MergeRequestSummary, TreeEntryDetail } from "@cohort/shared";
import { AgentName } from "../../components/Agent.tsx";
import { StatusBadge } from "../../components/IssueBits.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { JobStatusPill, JOB_KIND_LABELS, MergeRequestPill } from "../../components/Pills.tsx";
import { SkeletonRows } from "../../components/Skeleton.tsx";
import { timeAgo } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { CodeSearch } from "./CodeSearch.tsx";
import { EmptyRepo } from "./EmptyRepo.tsx";
import { FileList } from "./FileList.tsx";
import { PathCrumbs } from "./PathCrumbs.tsx";
import { useProject } from "./ProjectLayout.tsx";
import { RefPicker } from "./RefPicker.tsx";

interface TreeResponse {
  ref: string;
  sha: string;
  path: string;
  entries: TreeEntryDetail[];
  readme: Blob | null;
}

function Readme({ readme }: { readme: Blob }) {
  if (!readme.content) return null;
  return (
    <section className="section">
      <div className="readme">
        <div className="readme-name mono small">{readme.path.split("/").pop()}</div>
        {/\.(md|markdown)$/i.test(readme.path) ? <Markdown source={readme.content} /> : <pre className="plain">{readme.content}</pre>}
      </div>
    </section>
  );
}

// Repo home (no path): README, recent work and runs, then files. A folder: its files and README.
export function TreeView() {
  const { project, ref } = useProject();
  const [search] = useSearchParams();
  const location = useLocation();
  const path = search.get("path") ?? "";
  const isHome = !location.pathname.endsWith("/tree");
  const params = new URLSearchParams({ ref: ref ?? "", path, details: "1" });
  const { data, error } = useApi<TreeResponse>(ref ? `/api/projects/${project.workspace}/${project.slug}/tree?${params}` : null);

  if (!project.defaultBranch) return <EmptyRepo />;
  if (error) return <p className="error">Couldn't load the files: {error}</p>;

  const toolbar = (
    <div className="toolbar code-toolbar">
      <RefPicker view="" path={path} />
      {path && <PathCrumbs path={path} />}
      <div className="spacer" />
      <CodeSearch />
    </div>
  );

  if (isHome && !path) {
    return (
      <>
        {toolbar}
        {data?.readme ? <Readme readme={data.readme} /> : !data ? <SkeletonRows rows={2} height={120} /> : null}
        <RecentWork />
        <section className="section">
          <h2>Files</h2>
          {data ? <FileList entries={data.entries} path="" /> : <SkeletonRows rows={4} height={36} />}
        </section>
      </>
    );
  }

  return (
    <>
      {toolbar}
      {data ? <FileList entries={data.entries} path={path} /> : <SkeletonRows rows={5} height={36} />}
      {data?.readme && <Readme readme={data.readme} />}
    </>
  );
}

// Open issues and merge requests, and the latest agent runs, for this repo.
function RecentWork() {
  const { project, base } = useProject();
  const api = `/api/projects/${project.workspace}/${project.slug}`;
  const issues = useApi<{ issues: IssueSummary[] }>(`${api}/issues?status=open`).data?.issues;
  const mrs = useApi<{ mergeRequests: MergeRequestSummary[] }>(`${api}/merge_requests?status=open`).data?.mergeRequests;
  const runs = useApi<{ jobs: Job[] }>(`${api}/jobs`).data?.jobs;

  return (
    <div className="recent-grid section">
      <section>
        <div className="row spread">
          <h2>Open work</h2>
          <Link to={`${base}/issues`} className="small">
            All work
          </Link>
        </div>
        {!issues || !mrs ? (
          <SkeletonRows rows={3} height={36} />
        ) : issues.length + mrs.length === 0 ? (
          <p className="empty-line">
            Nothing open. <Link to={`${base}/issues/new`}>Create an issue</Link> or <Link to={`${base}/workshops/new`}>start a workshop</Link>.
          </p>
        ) : (
          <ul className="check-list">
            {mrs.slice(0, 3).map((m) => (
              <li key={`mr-${m.id}`}>
                <MergeRequestPill status={m.status} />
                <Link to={`${base}/merge_requests/${m.number}`}>{m.title}</Link>
                <span className="muted small">!{m.number}</span>
              </li>
            ))}
            {issues.slice(0, 5).map((i) => (
              <li key={`issue-${i.id}`}>
                <StatusBadge status={i.status} />
                <Link to={`${base}/issues/${i.number}`}>{i.title}</Link>
                <span className="muted small">#{i.number}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <div className="row spread">
          <h2>Recent runs</h2>
          <Link to={`${base}/jobs`} className="small">
            All runs
          </Link>
        </div>
        {!runs ? (
          <SkeletonRows rows={3} height={36} />
        ) : runs.length === 0 ? (
          <p className="empty-line">No agent runs yet. Assign an issue to an agent to start one.</p>
        ) : (
          <ul className="check-list">
            {runs.slice(0, 5).map((j) => (
              <li key={j.id}>
                <JobStatusPill status={j.status} />
                <Link to={`${base}/jobs/${j.id}`}>{j.issue?.title ?? `Run #${j.id}`}</Link>
                <span className="muted small">
                  {JOB_KIND_LABELS[j.kind]} · <AgentName name={j.bot} /> · {timeAgo(j.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
