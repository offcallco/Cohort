import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { FileText, Search } from "lucide-react";
import type { SearchResult } from "@cohort/shared";
import { api } from "../../api.ts";
import { useProject } from "./ProjectLayout.tsx";

// Search the repo's files and contents. Press / to focus.
export function CodeSearch() {
  const { project, base, ref } = useProject();
  const [q, setQ] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || (e.target as HTMLElement).closest("input, textarea, select")) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResult(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: term, ref: ref ?? "" });
        setResult(await api<SearchResult>(`/api/projects/${project.workspace}/${project.slug}/search?${params}`));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Search failed");
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, ref, project.workspace, project.slug]);

  const blob = (path: string, line?: number) => `${base}/blob?${new URLSearchParams({ ref: ref ?? "", path })}${line ? `#L${line}` : ""}`;

  return (
    <div className="code-search">
      <label className="search-box">
        <Search size={14} aria-hidden />
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQ("")}
          placeholder="Search this repo"
          aria-label="Search this repo"
        />
        <kbd>/</kbd>
      </label>
      {error && <p className="error small">{error}</p>}
      {result && (
        <div className="search-results" role="region" aria-label="Search results">
          {result.files.length === 0 && result.lines.length === 0 && <p className="muted small pad">Nothing matches "{q.trim()}".</p>}
          {result.files.map((f) => (
            <Link key={f} to={blob(f)} className="search-hit">
              <FileText size={12} aria-hidden /> <span className="mono">{f}</span>
            </Link>
          ))}
          {result.lines.map((l) => (
            <Link key={`${l.path}:${l.line}`} to={blob(l.path, l.line)} className="search-hit">
              <span className="mono muted">
                {l.path}:{l.line}
              </span>
              <code>{l.text.trim()}</code>
            </Link>
          ))}
          {result.truncated && <p className="muted small pad">Showing the first 200 matching lines.</p>}
        </div>
      )}
    </div>
  );
}
