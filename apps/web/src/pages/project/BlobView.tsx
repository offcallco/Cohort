import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { Check, Copy, History } from "lucide-react";
import type { Blob } from "@cohort/shared";
import { highlightLine, languageFor } from "../../components/diff.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { SkeletonRows } from "../../components/Skeleton.tsx";
import { formatBytes } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { CodeSearch } from "./CodeSearch.tsx";
import { PathCrumbs } from "./PathCrumbs.tsx";
import { useProject } from "./ProjectLayout.tsx";
import { RefPicker } from "./RefPicker.tsx";

export function BlobView() {
  const { project, base, ref } = useProject();
  const [search] = useSearchParams();
  const location = useLocation();
  const path = search.get("path") ?? "";
  const params = new URLSearchParams({ ref: ref ?? "", path });
  const { data, error } = useApi<{ blob: Blob }>(ref ? `/api/projects/${project.workspace}/${project.slug}/blob?${params}` : null);
  const isMarkdown = /\.(md|markdown)$/i.test(path);
  const [rendered, setRendered] = useState(true);
  const [copied, setCopied] = useState(false);
  const target = Number(location.hash.match(/^#L(\d+)$/)?.[1] ?? 0);

  const lines = useMemo(() => data?.blob.content?.replace(/\n$/, "").split("\n") ?? [], [data]);
  const language = languageFor(path);
  const highlighted = useMemo(() => lines.map((l) => highlightLine(l, language)), [lines, language]);

  useEffect(() => {
    if (target) document.getElementById(`L${target}`)?.scrollIntoView({ block: "center" });
  }, [target, data]);

  const toolbar = (
    <div className="toolbar code-toolbar">
      <RefPicker view="/blob" path={path} />
      <PathCrumbs path={path} />
      <div className="spacer" />
      <CodeSearch />
    </div>
  );

  if (error) return (<>{toolbar}<p className="error">Couldn't open {path}: {error}</p></>);
  if (!data || !ref) return (<>{toolbar}<SkeletonRows rows={8} height={20} /></>);
  const { blob } = data;

  return (
    <>
      {toolbar}
      <section className="diff-file">
        <header className="diff-file-head static">
          <span className="mono diff-file-name">{path}</span>
          <span className="muted small">
            {blob.content !== null && `${lines.length} lines · `}
            {formatBytes(blob.size)}
          </span>
          <button
            className="link small"
            onClick={async () => {
              await navigator.clipboard.writeText(path);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />} {copied ? "Copied" : "Copy path"}
          </button>
          {isMarkdown && blob.content !== null && (
            <button className="link small" onClick={() => setRendered(!rendered)}>
              {rendered ? "Source" : "Rendered"}
            </button>
          )}
          <Link className="button ghost small" to={`${base}/commits?${params}`}>
            <History size={12} aria-hidden /> History
          </Link>
        </header>
        {blob.content === null ? (
          <p className="muted pad">{blob.binary ? "Binary file, not shown." : "This file is too large to show (over 1 MB)."}</p>
        ) : isMarkdown && rendered ? (
          <div className="pad markdown-file">
            <Markdown source={blob.content} />
          </div>
        ) : (
          <table className="code diff-unified">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} id={`L${i + 1}`} className={target === i + 1 ? "line-target" : undefined}>
                  <td className="ln">
                    <a href={`#L${i + 1}`}>{i + 1}</a>
                  </td>
                  <td className="code-cell ctx">
                    {highlighted[i] !== null ? <pre dangerouslySetInnerHTML={{ __html: highlighted[i] || " " }} /> : <pre>{line || " "}</pre>}
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
