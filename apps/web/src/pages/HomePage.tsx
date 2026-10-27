import { Link } from "react-router";
import { useSession } from "../session.tsx";

export function HomePage() {
  const { status } = useSession();
  return (
    <>
      <h1>Welcome, {status?.user?.username}</h1>
      <section className="panel empty">
        <h2>No projects yet</h2>
        <p className="muted">
          Repos and workspaces are coming next. In the meantime, create an{" "}
          <Link to="/settings/tokens">access token</Link> so git and the API can sign in as you.
        </p>
      </section>
    </>
  );
}
