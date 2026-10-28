import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Blob } from "@cohort/shared";
import { Markdown } from "../../components/Markdown.tsx";
import { formatBytes } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { PathCrumbs } from "./PathCrumbs.tsx";
import { useProject } from "./ProjectLayout.tsx";
import { RefPicker } from "./RefPicker.tsx";

export function BlobView() {
  const { project, base, ref } = useProject();
  const [search] = useSearchParams();
  const path = search.get("path") ?? "";
  const params = new URLSearchParams({ ref: ref ?? "", path });
  const { data, error } = useApi<{ blob: Blob }>(
    ref ? `/api/projects/${project.workspace}/${project.slug}/blob?${params}` : null,
  );
  const isMarkdown = /\.(md|markdown)$/i.test(path);
  const [rendered, setRendered] = useState(true);

  if (error) return <p className="error">{error}</p>;
  if (!data || !ref) return null;
  const { blob } = data;
  const lines = blob.content?.replace(/\n$/, "").split("\n") ?? [];

  return (
    <>
      <div className="toolbar">
        <RefPicker view="/blob" path={path} />
        <PathCrumbs path={path} />
      </div>
      <section className="panel flush">
        <div className="panel-bar">
          <span className="muted">
            {blob.content !== null && `${lines.length} lines · `}
            {formatBytes(blob.size)}
          </span>
          <div className="row">
            {isMarkdown && blob.content !== null && (
              <button className="secondary small" onClick={() => setRendered(!rendered)}>
                {rendered ? "Show source" : "Show rendered"}
              </button>
            )}
            <Link className="button secondary small" to={`${base}/commits?${params}`}>
              History
            </Link>
          </div>
        </div>
        {blob.content === null ? (
          <p className="muted pad">
            {blob.binary ? "Binary file, not shown." : "This file is too large to show (over 1 MB)."}
          </p>
        ) : isMarkdown && rendered ? (
          <div className="pad">
            <Markdown source={blob.content} />
          </div>
        ) : (
          <table className="code">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td className="ln">{i + 1}</td>
                  <td>
                    <pre>{line}</pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
