import { Activity, Bot, FolderGit2, Inbox, LayoutDashboard, ListTodo, Settings, type LucideIcon } from "lucide-react";

// The left nav, in the guide's order. Same on every page.
export const NAV: { to: string; label: string; icon: LucideIcon; shortcut?: string }[] = [
  { to: "/", label: "Mission Control", icon: LayoutDashboard, shortcut: "g m" },
  { to: "/repos", label: "Repos", icon: FolderGit2, shortcut: "g p" },
  { to: "/work", label: "Work", icon: ListTodo, shortcut: "g w" },
  { to: "/reviews", label: "Reviews", icon: Inbox, shortcut: "g r" },
  { to: "/agents", label: "Agents", icon: Bot, shortcut: "g a" },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/settings", label: "Settings", icon: Settings, shortcut: "g s" },
];
