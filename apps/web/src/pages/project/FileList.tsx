import { Link } from "react-router";
import { File, FileCode, FileText, Folder, Image as ImageIcon, Package } from "lucide-react";
import type { TreeEntryDetail } from "@cohort/shared";
import { timeAgo } from "../../format.ts";
import { treeLink } from "./PathCrumbs.tsx";
import { useProject } from "./ProjectLayout.tsx";

function iconFor(entry: TreeEntryDetail) {
  if (entry.type === "tree") return Folder;
  if (entry.type === "commit") return Package;
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return ImageIcon;
  if (["md", "txt", "rst"].includes(ext)) return FileText;
  if (["js", "ts", "tsx", "jsx", "py", "go", "rs", "rb", "java", "css", "html", "json", "yml", "yaml", "sh", "sql"].includes(ext)) return FileCode;
  return File;
}

// Name, last commit message and time. Nothing else.
export function FileList({ entries, path }: { entries: TreeEntryDetail[]; path: string }) {
  const { base, ref } = useProject();
  if (!ref) return null;
  const parent = path.split("/").slice(0, -1).join("/");
  return (
    <ul className="file-browser">
      {path && (
        <li>
          <Link to={treeLink(base, ref, parent)} className="file-name">
            <Folder size={14} aria-hidden /> ..
          </Link>
        </li>
      )}
      {entries.map((e) => {
        const Icon = iconFor(e);
        const to = e.type === "tree" ? treeLink(base, ref, e.path) : `${base}/blob?${new URLSearchParams({ ref, path: e.path })}`;
        return (
          <li key={e.path}>
            {e.type === "commit" ? (
              <span className="file-name">
                <Icon size={14} aria-hidden /> {e.name}
              </span>
            ) : (
              <Link to={to} className="file-name">
                <Icon size={14} aria-hidden className={e.type === "tree" ? "folder-icon" : undefined} /> {e.name}
              </Link>
            )}
            {e.lastCommit ? (
              <>
                <Link to={`${base}/commit/${e.lastCommit.sha}`} className="file-commit">
                  {e.lastCommit.subject}
                </Link>
                <span className="file-time">{timeAgo(e.lastCommit.date)}</span>
              </>
            ) : (
              <>
                <span />
                <span />
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
