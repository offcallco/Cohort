import { Link } from "react-router";
import { useProject } from "./ProjectLayout.tsx";

export function EmptyRepo() {
  const { project } = useProject();
  const url = `${location.origin}${project.clonePath}`;
  return (
    <section className="panel">
      <h2>This repository is empty</h2>
      <p className="muted">
        Push an existing repo to it. When git asks for a password, use an{" "}
        <Link to="/settings/tokens">access token</Link>; any username works.
      </p>
      <pre className="plain">{`cd your-project
git remote add origin ${url}
git push -u origin main`}</pre>
      <p className="muted">Or start fresh:</p>
      <pre className="plain">{`git clone ${url}`}</pre>
    </section>
  );
}
