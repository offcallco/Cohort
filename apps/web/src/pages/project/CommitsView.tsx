import { Link, useSearchParams } from "react-router";
import type { Commit } from "@cohort/shared";
import { shortSha, timeAgo } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { useProject } from "./ProjectLayout.tsx";
import { RefPicker } from "./RefPicker.tsx";

export function CommitsView() {
  const { project, base, ref } = useProject();
  const [search, setSearch] = useSearchParams();
  const path = search.get("path") ?? "";
  const page = Number(search.get("page") ?? "1");
  const params = new URLSearchParams({ ref: ref ?? "", path, page: String(page) });
  const { data, error } = useApi<{ commits: Commit[]; hasMore: boolean }>(
    ref ? `/api/projects/${project.workspace}/${project.slug}/commits?${params}` : null,
  );

  const goTo = (n: number) => {
    const next = new URLSearchParams(search);
    next.set("page", String(n));
    setSearch(next);
  };

  if (error) return <p className="error">{error}</p>;
  if (!data) return null;

  return (
    <>
      <div className="toolbar">
        <RefPicker view="/commits" path={path} />
        {path && <span className="muted">History for <code>{path}</code></span>}
      </div>
      <section className="panel flush">
        <ul className="list commits">
          {data.commits.map((c) => (
            <li key={c.sha} className="list-row">
              <div>
                <Link to={`${base}/commit/${c.sha}`}>{c.subject}</Link>
                <div className="muted">
                  {c.authorName} committed {timeAgo(c.date)}
                </div>
              </div>
              <Link className="sha" to={`${base}/commit/${c.sha}`}>
                {shortSha(c.sha)}
              </Link>
            </li>
          ))}
        </ul>
      </section>
      {(page > 1 || data.hasMore) && (
        <div className="row pager">
          <button className="secondary" disabled={page <= 1} onClick={() => goTo(page - 1)}>
            Newer
          </button>
          <button className="secondary" disabled={!data.hasMore} onClick={() => goTo(page + 1)}>
            Older
          </button>
        </div>
      )}
    </>
  );
}
