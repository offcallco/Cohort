import { Link } from "react-router";
import { shortSha, timeAgo } from "../../format.ts";
import { treeLink } from "./PathCrumbs.tsx";
import { useProject } from "./ProjectLayout.tsx";

export function BranchesView() {
  const { project, branches, base } = useProject();
  return (
    <section className="panel flush">
      <ul className="list">
        {branches.map((b) => (
          <li key={b.name} className="list-row">
            <div>
              <Link to={treeLink(base, b.name, "")}>
                <strong>{b.name}</strong>
              </Link>
              {b.name === project.defaultBranch && <span className="badge">default</span>}
              <div className="muted">
                {b.subject} · updated {timeAgo(b.date)}
              </div>
            </div>
            <Link className="sha" to={`${base}/commit/${b.sha}`}>
              {shortSha(b.sha)}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
