import { Link, useSearchParams } from "react-router";
import type { Blob, TreeEntry } from "@cohort/shared";
import { Markdown } from "../../components/Markdown.tsx";
import { formatBytes } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { EmptyRepo } from "./EmptyRepo.tsx";
import { PathCrumbs, treeLink } from "./PathCrumbs.tsx";
import { useProject } from "./ProjectLayout.tsx";
import { RefPicker } from "./RefPicker.tsx";

interface TreeResponse {
  ref: string;
  sha: string;
  path: string;
  entries: TreeEntry[];
  readme: Blob | null;
}

export function TreeView() {
  const { project, base, ref } = useProject();
  const [search] = useSearchParams();
  const path = search.get("path") ?? "";
  const params = new URLSearchParams({ ref: ref ?? "", path });
  const { data, error } = useApi<TreeResponse>(
    ref ? `/api/projects/${project.workspace}/${project.slug}/tree?${params}` : null,
  );

  if (!project.defaultBranch) return <EmptyRepo />;
  if (error) return <p className="error">{error}</p>;
  if (!data || !ref) return null;

  const parent = path.split("/").slice(0, -1).join("/");
  return (
    <>
      <div className="toolbar">
        <RefPicker view="" path={path} />
        <PathCrumbs path={path} />
      </div>
      <section className="panel flush">
        <table className="files">
          <tbody>
            {path && (
              <tr>
                <td>
                  <Link to={treeLink(base, ref, parent)}>..</Link>
                </td>
                <td />
              </tr>
            )}
            {data.entries.map((e) => (
              <tr key={e.path}>
                <td>
                  <span className="icon">{e.type === "tree" ? "▸" : e.type === "commit" ? "◇" : "·"}</span>
                  {e.type === "tree" ? (
                    <Link to={treeLink(base, ref, e.path)}>{e.name}</Link>
                  ) : e.type === "blob" ? (
                    <Link to={`${base}/blob?${new URLSearchParams({ ref, path: e.path })}`}>{e.name}</Link>
                  ) : (
                    <span>{e.name}</span>
                  )}
                </td>
                <td className="muted right">{e.size !== null ? formatBytes(e.size) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {data.readme?.content && (
        <section className="panel">
          <div className="panel-title">{data.readme.path.split("/").pop()}</div>
          {/\.(md|markdown)$/i.test(data.readme.path) ? (
            <Markdown source={data.readme.content} />
          ) : (
            <pre className="plain">{data.readme.content}</pre>
          )}
        </section>
      )}
    </>
  );
}
