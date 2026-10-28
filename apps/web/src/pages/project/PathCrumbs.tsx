import { Link } from "react-router";
import { useProject } from "./ProjectLayout.tsx";

export function treeLink(base: string, ref: string, path: string) {
  return `${base}/tree?${new URLSearchParams({ ref, path })}`;
}

export function PathCrumbs({ path }: { path: string }) {
  const { project, base, ref } = useProject();
  if (!ref) return null;
  const parts = path.split("/").filter(Boolean);
  return (
    <div className="crumbs path">
      <Link to={treeLink(base, ref, "")}>{project.slug}</Link>
      {parts.map((part, i) => {
        const sub = parts.slice(0, i + 1).join("/");
        return (
          <span key={sub}>
            {" / "}
            {i === parts.length - 1 ? <strong>{part}</strong> : <Link to={treeLink(base, ref, sub)}>{part}</Link>}
          </span>
        );
      })}
    </div>
  );
}
