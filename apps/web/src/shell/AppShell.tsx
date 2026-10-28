import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { LogOut, Search, Settings } from "lucide-react";
import { RESERVED_SLUGS } from "@cohort/shared";
import { api } from "../api.ts";
import { useSession } from "../session.tsx";
import { useApi } from "../hooks.ts";
import { CommandPalette } from "./CommandPalette.tsx";
import { NAV } from "./nav.ts";

// Left nav + contextual top bar. Pages render in the content area.
export function AppShell() {
  const { status, refresh } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [palette, setPalette] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  useShortcuts(() => setPalette(true));

  // Close the user menu after navigating.
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [location.pathname]);

  async function logout() {
    await api("/api/logout", { method: "POST" });
    await refresh();
    navigate("/login");
  }

  const username = status?.user?.username ?? "";
  const waiting = useApi<{ items: unknown[] }>("/api/reviews", { pollMs: 10_000 }).data?.items.length ?? 0;
  // Code and diff pages use the full width; lists stay readable.
  const wide = /\/(blob|commit|merge_requests\/\d+)/.test(location.pathname);

  return (
    <div className="app">
      <nav className="nav" aria-label="Main">
        <Link to="/" className="nav-brand">
          <span className="nav-logo" aria-hidden>
            C
          </span>
          <span>Cohort</span>
        </Link>
        {NAV.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink key={item.to} to={item.to} end={item.to === "/"} className="nav-item" title={item.label}>
              <Icon size={16} aria-hidden />
              <span>{item.label}</span>
              {item.to === "/reviews" && waiting > 0 && (
                <span className="nav-count" aria-label={`${waiting} waiting on you`}>
                  {waiting}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="main">
        <header className="topbar">
          <Context path={location.pathname} />
          <div className="spacer" />
          <button className="search-trigger" onClick={() => setPalette(true)} aria-label="Search (⌘K)">
            <Search size={14} aria-hidden />
            <span>Search</span>
            <kbd>⌘K</kbd>
          </button>
          <details className="user-menu" ref={menu}>
            <summary className="avatar" aria-label={`Account: ${username}`}>
              {username.slice(0, 1)}
            </summary>
            <div className="menu">
              <div className="menu-header">Signed in as {username}</div>
              <Link to="/settings">
                <Settings size={14} aria-hidden /> Settings
              </Link>
              <button onClick={logout}>
                <LogOut size={14} aria-hidden /> Sign out
              </button>
            </div>
          </details>
        </header>
        <main className={`content${wide ? " wide" : ""}`}>
          <Outlet />
        </main>
      </div>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}

const SECTION_NAMES: Record<string, string> = {
  issues: "Work",
  merge_requests: "Merge requests",
  workshops: "Workshops",
  pipelines: "Pipelines",
  jobs: "Agent runs",
  commits: "Commits",
  commit: "Commit",
  branches: "Branches",
  tree: "Code",
  blob: "Code",
  settings: "Settings",
};

// Breadcrumb for where you are: a page name, or workspace / repo / section.
function Context({ path }: { path: string }) {
  const parts = path.split("/").filter(Boolean);
  const top = NAV.find((n) => n.to !== "/" && path.startsWith(n.to));
  if (parts.length === 0) return <div className="context"><strong>Mission Control</strong></div>;
  if (top || (RESERVED_SLUGS as readonly string[]).includes(parts[0]!)) {
    return (
      <div className="context">
        <strong>{top?.label ?? parts[0]}</strong>
      </div>
    );
  }
  const [workspace, project, section, id] = parts;
  return (
    <div className="context">
      <Link to={`/${workspace}`}>{workspace}</Link>
      {project && (
        <>
          <span aria-hidden>/</span>
          {section ? <Link to={`/${workspace}/${project}`}>{project}</Link> : <strong>{project}</strong>}
        </>
      )}
      {section && (
        <>
          <span aria-hidden>/</span>
          <strong>
            {SECTION_NAMES[section] ?? section}
            {id && /^\d+$/.test(id) ? ` ${section === "merge_requests" ? "!" : "#"}${id}` : ""}
          </strong>
        </>
      )}
    </div>
  );
}

// ⌘K / Ctrl+K opens the palette; "g" then a letter jumps to a section. Ignored while typing.
function useShortcuts(openPalette: () => void) {
  const navigate = useNavigate();
  useEffect(() => {
    let pendingG = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openPalette();
        return;
      }
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "g") {
        pendingG = Date.now();
        return;
      }
      if (Date.now() - pendingG < 1000) {
        const item = NAV.find((n) => n.shortcut === `g ${e.key}`);
        if (item) navigate(item.to);
        pendingG = 0;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, openPalette]);
}
