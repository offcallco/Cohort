import { Link, useParams } from "react-router";
import type { CommitDetail } from "@cohort/shared";
import { shortSha, timeAgo } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { DiffViewer } from "../../components/DiffViewer.tsx";
import { useProject } from "./ProjectLayout.tsx";
import { SkeletonRows } from "../../components/Skeleton.tsx";

export function CommitView() {
  const { project, base } = useProject();
  const { sha = "" } = useParams();
  const { data, error } = useApi<{ commit: CommitDetail }>(
    `/api/projects/${project.workspace}/${project.slug}/commits/${sha}`,
  );

  if (error) return <p className="error">{error}</p>;
  if (!data) return <SkeletonRows rows={4} height={48} />;
  const c = data.commit;
  const additions = c.files.reduce((n, f) => n + f.additions, 0);
  const deletions = c.files.reduce((n, f) => n + f.deletions, 0);

  return (
    <>
      <section className="panel">
        <h2>{c.subject}</h2>
        {c.body && <pre className="plain">{c.body}</pre>}
        <div className="muted">
          {c.authorName} &lt;{c.authorEmail}&gt; committed {timeAgo(c.date)} · <code>{shortSha(c.sha)}</code>
          {c.parents.length > 0 && (
            <>
              {" · parent "}
              {c.parents.map((p) => (
                <Link key={p} className="sha" to={`${base}/commit/${p}`}>
                  {shortSha(p)}
                </Link>
              ))}
            </>
          )}
        </div>
        <div className="muted">
          {c.files.length} {c.files.length === 1 ? "file" : "files"} changed,{" "}
          <span className="add">+{additions}</span> <span className="del">−{deletions}</span> ·{" "}
          <Link to={`${base}/tree?${new URLSearchParams({ ref: c.sha, path: "" })}`}>Browse files</Link>
        </div>
      </section>
      <DiffViewer files={c.files} />
    </>
  );
}
