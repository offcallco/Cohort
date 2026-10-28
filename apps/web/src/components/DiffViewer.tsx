import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight, MessageSquarePlus, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { FileDiff, IssueComment } from "@cohort/shared";
import { timeAgo } from "../format.ts";
import { Actor } from "./Agent.tsx";
import { extensionOf, highlightLine, languageFor, splitRows, unifiedRows, type DiffRow, type Side } from "./diff.ts";
import { Markdown } from "./Markdown.tsx";

export interface LineTarget {
  path: string;
  line: number;
  side: "old" | "new";
}

const fileName = (f: FileDiff) => f.newPath ?? f.oldPath ?? "";
const STATUS_LETTER: Record<FileDiff["status"], string> = { added: "A", deleted: "D", modified: "M", renamed: "R" };

function useWide(min = 1200) {
  const query = `(min-width: ${min}px)`;
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return wide;
}

// Diffs with a file tree, side-by-side or unified view, syntax highlighting, line numbers,
// file-type filters, n/p to move between files, and optional comments on lines.
export function DiffViewer({
  files,
  comments = [],
  onComment,
  whitespaceHidden,
  onToggleWhitespace,
}: {
  files: FileDiff[];
  comments?: IssueComment[];
  onComment?: (target: LineTarget, body: string) => Promise<boolean>;
  whitespaceHidden?: boolean;
  onToggleWhitespace?: () => void;
}) {
  const wide = useWide();
  const [layout, setLayout] = useState<"split" | "unified" | null>(null);
  const view = layout ?? (wide ? "split" : "unified");
  const [treeOpen, setTreeOpen] = useState(true);
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState(0);
  const refs = useRef<(HTMLElement | null)[]>([]);

  const extensions = useMemo(() => [...new Set(files.map((f) => extensionOf(fileName(f)) || "other"))].sort(), [files]);
  const shown = files.filter((f) => types.size === 0 || types.has(extensionOf(fileName(f)) || "other"));

  const jump = (index: number) => {
    const next = Math.max(0, Math.min(index, shown.length - 1));
    setCurrent(next);
    refs.current[next]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n") jump(current + 1);
      else if (e.key === "p") jump(current - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (files.length === 0) return <p className="empty-line">No changes{whitespaceHidden ? " besides whitespace" : ""}.</p>;

  return (
    <div className={`diff-viewer${treeOpen ? " with-tree" : ""}`}>
      <div className="diff-toolbar">
        <button className="link small" onClick={() => setTreeOpen(!treeOpen)} aria-label={treeOpen ? "Hide file list" : "Show file list"}>
          {treeOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
        </button>
        {extensions.length > 1 &&
          extensions.map((ext) => (
            <button
              key={ext}
              className={`chip small${types.has(ext) ? " active" : ""}`}
              aria-pressed={types.has(ext)}
              onClick={() => {
                const next = new Set(types);
                if (next.has(ext)) next.delete(ext);
                else next.add(ext);
                setTypes(next);
              }}
            >
              .{ext}
            </button>
          ))}
        <div className="spacer" />
        {onToggleWhitespace && (
          <label className="checkbox small">
            <input type="checkbox" checked={!!whitespaceHidden} onChange={onToggleWhitespace} />
            Hide whitespace
          </label>
        )}
        <div className="segmented" role="group" aria-label="Diff layout">
          <button className={view === "split" ? "active" : ""} onClick={() => setLayout("split")}>
            Side by side
          </button>
          <button className={view === "unified" ? "active" : ""} onClick={() => setLayout("unified")}>
            Unified
          </button>
        </div>
        <button className="secondary small" onClick={() => jump(current - 1)} disabled={current <= 0} title="Previous file (p)">
          Prev file
        </button>
        <button className="secondary small" onClick={() => jump(current + 1)} disabled={current >= shown.length - 1} title="Next file (n)">
          Next file
        </button>
      </div>

      {treeOpen && (
        <nav className="file-tree" aria-label="Changed files">
          {shown.map((f, i) => (
            <button key={fileName(f)} className={`tree-file${i === current ? " active" : ""}`} onClick={() => jump(i)} title={fileName(f)}>
              <span className={`tree-status tree-${f.status}`}>{STATUS_LETTER[f.status]}</span>
              <span className="tree-name">{fileName(f)}</span>
              <span className="tree-counts">
                <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
              </span>
            </button>
          ))}
        </nav>
      )}

      <div className="diff-files">
        {shown.map((f, i) => {
          const name = fileName(f);
          const isCollapsed = collapsed.has(name);
          return (
            <section key={name} className="diff-file" ref={(el) => {
                refs.current[i] = el;
              }}>
              <header
                className="diff-file-head"
                onClick={() => {
                  const next = new Set(collapsed);
                  if (next.has(name)) next.delete(name);
                  else next.add(name);
                  setCollapsed(next);
                  setCurrent(i);
                }}
              >
                {isCollapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
                <span className="mono diff-file-name">{f.status === "renamed" ? `${f.oldPath} → ${f.newPath}` : name}</span>
                <span className="small">
                  <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                </span>
              </header>
              {!isCollapsed &&
                (f.binary ? (
                  <p className="muted pad small">Binary file.</p>
                ) : !f.patch ? (
                  <p className="muted pad small">No content changes.</p>
                ) : (
                  <FileRows file={f} view={view} comments={comments.filter((c) => c.path === name)} onComment={onComment} />
                ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Code({ side, language }: { side: Side | null; language: string | null }) {
  if (!side) return <td className="code-cell empty" />;
  const html = highlightLine(side.text, language);
  return (
    <td className={`code-cell ${side.type}`}>
      {html !== null ? <pre dangerouslySetInnerHTML={{ __html: html || " " }} /> : <pre>{side.text || " "}</pre>}
    </td>
  );
}

function FileRows({
  file,
  view,
  comments,
  onComment,
}: {
  file: FileDiff;
  view: "split" | "unified";
  comments: IssueComment[];
  onComment?: (target: LineTarget, body: string) => Promise<boolean>;
}) {
  const path = fileName(file);
  const language = languageFor(path);
  const rows: DiffRow[] = useMemo(() => (view === "split" ? splitRows(file.patch) : unifiedRows(file.patch)), [file.patch, view]);
  const [composing, setComposing] = useState<LineTarget | null>(null);
  const cols = view === "split" ? 4 : 3;

  const at = (side: "old" | "new", n: number) => comments.filter((c) => c.side === side && c.line === n);
  const commentButton = (side: "old" | "new", n: number) =>
    onComment ? (
      <button className="line-comment" onClick={() => setComposing({ path, line: n, side })} aria-label={`Comment on line ${n}`}>
        <MessageSquarePlus size={12} aria-hidden />
      </button>
    ) : null;

  return (
    <table className={`code diff diff-${view}`}>
      {view === "split" && (
        <colgroup>
          <col className="ln-col" />
          <col />
          <col className="ln-col" />
          <col />
        </colgroup>
      )}
      <tbody>
        {rows.map((row, r) => {
          if (row.kind === "hunk") {
            return (
              <tr key={r} className="hunk">
                <td colSpan={cols}>
                  <pre>{row.text}</pre>
                </td>
              </tr>
            );
          }
          // Comments attach to the new side when there is one, else the old side.
          const anchor = row.new ? { side: "new" as const, n: row.new.n } : { side: "old" as const, n: row.old!.n };
          const thread = [...(row.old ? at("old", row.old.n).filter(() => row.old!.type === "del") : []), ...(row.new ? at("new", row.new.n) : [])];
          const isComposing = composing && composing.line === anchor.n && composing.side === anchor.side;
          return (
            <Fragment key={r}>
              {view === "split" ? (
                <tr>
                  <td className="ln">
                    {row.old?.n}
                    {row.old && row.old.type === "del" && commentButton("old", row.old.n)}
                  </td>
                  <Code side={row.old} language={language} />
                  <td className="ln">
                    {row.new?.n}
                    {row.new && commentButton("new", row.new.n)}
                  </td>
                  <Code side={row.new} language={language} />
                </tr>
              ) : (
                <tr>
                  <td className="ln">{row.old?.n}</td>
                  <td className="ln">
                    {row.new?.n}
                    {commentButton(anchor.side, anchor.n)}
                  </td>
                  <Code side={row.new ?? row.old} language={language} />
                </tr>
              )}
              {(thread.length > 0 || isComposing) && (
                <tr className="comment-row">
                  <td colSpan={cols}>
                    {thread.map((c) => (
                      <div key={c.id} className="line-thread">
                        <div className="meta">
                          <Actor name={c.author.username} bot={c.author.kind === "bot"} />
                          <span>{timeAgo(c.createdAt)}</span>
                        </div>
                        <Markdown source={c.body} />
                      </div>
                    ))}
                    {isComposing && onComment && (
                      <LineCommentForm
                        onCancel={() => setComposing(null)}
                        onSubmit={async (body) => {
                          if (await onComment(composing, body)) setComposing(null);
                        }}
                      />
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function LineCommentForm({ onSubmit, onCancel }: { onSubmit: (body: string) => Promise<void>; onCancel: () => void }) {
  const [body, setBody] = useState("");
  return (
    <form
      className="stack line-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void onSubmit(body);
      }}
    >
      <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Comment on this line" autoFocus />
      <div className="row">
        <button type="submit" className="secondary small" disabled={!body.trim()}>
          Comment
        </button>
        <button type="button" className="link small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
