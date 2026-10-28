import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { FolderGit2, type LucideIcon } from "lucide-react";
import type { WorkspaceWithProjects } from "@cohort/shared";
import { useApi } from "../hooks.ts";
import { NAV } from "./nav.ts";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  to: string;
}

// ⌘K: jump to any page or repo. Arrow keys move, Enter opens, Esc closes.
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const workspaces = useApi<{ workspaces: WorkspaceWithProjects[] }>("/api/workspaces").data?.workspaces ?? [];

  const commands = useMemo<Command[]>(
    () => [
      ...NAV.map((n) => ({ id: n.to, label: n.label, hint: n.shortcut, icon: n.icon, to: n.to })),
      ...workspaces.flatMap((w) =>
        w.projects.map((p) => ({
          id: `${w.slug}/${p.slug}`,
          label: `${w.slug}/${p.slug}`,
          hint: p.description || undefined,
          icon: FolderGit2,
          to: `/${w.slug}/${p.slug}`,
        })),
      ),
    ],
    [workspaces],
  );
  const q = query.trim().toLowerCase();
  const matches = q ? commands.filter((c) => c.label.toLowerCase().includes(q) || c.hint?.toLowerCase().includes(q)) : commands;

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);

  function open(command: Command | undefined) {
    if (!command) return;
    navigate(command.to);
    onClose();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") open(matches[index]);
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Go to a page or repo…" aria-label="Search" />
        <ul role="listbox">
          {matches.length === 0 && <li className="muted pad small">Nothing matches "{query}".</li>}
          {matches.map((c, i) => {
            const Icon = c.icon;
            return (
              <li key={c.id}>
                <button className={i === index ? "selected" : ""} onMouseEnter={() => setIndex(i)} onClick={() => open(c)} role="option" aria-selected={i === index}>
                  <Icon size={16} aria-hidden />
                  {c.label}
                  {c.hint && <span className="palette-hint">{c.hint}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="palette-footer">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
        <div className="palette-footer shortcuts" aria-label="Keyboard shortcuts">
          <span>
            <kbd>⌘K</kbd> search
          </span>
          <span>
            <kbd>g</kbd> <kbd>m</kbd> Mission Control
          </span>
          <span>
            <kbd>g</kbd> <kbd>r</kbd> Reviews
          </span>
          <span>
            <kbd>g</kbd> <kbd>w</kbd> Work
          </span>
          <span>
            <kbd>j</kbd> <kbd>k</kbd> move in lists
          </span>
          <span>
            <kbd>/</kbd> search a repo
          </span>
          <span>
            <kbd>n</kbd> <kbd>p</kbd> next / previous file in a diff
          </span>
        </div>
      </div>
    </div>
  );
}
