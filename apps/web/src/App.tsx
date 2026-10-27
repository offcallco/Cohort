import { Navigate, NavLink, Outlet, Route, Routes, useNavigate } from "react-router";
import { api } from "./api.ts";
import { useSession } from "./session.tsx";
import { AuthPage } from "./pages/AuthPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { TokensPage } from "./pages/TokensPage.tsx";

export function App() {
  const { status, error } = useSession();

  if (error) {
    return (
      <main className="centered">
        <div className="card">
          <h1>Can't reach Cohort</h1>
          <p className="muted">{error}. Check that the server is running.</p>
        </div>
      </main>
    );
  }
  if (!status) return null;

  if (status.setupRequired) {
    return (
      <Routes>
        <Route path="/setup" element={<AuthPage mode="setup" />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }
  if (!status.user) {
    return (
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<HomePage />} />
        <Route path="settings/tokens" element={<TokensPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function Shell() {
  const { status, refresh } = useSession();
  const navigate = useNavigate();

  async function logout() {
    await api("/api/logout", { method: "POST" });
    await refresh();
    navigate("/login");
  }

  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" className="brand">
          Cohort
        </NavLink>
        <nav>
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/settings/tokens">Access tokens</NavLink>
        </nav>
        <div className="spacer" />
        <span className="muted">{status?.user?.username}</span>
        <button className="link" onClick={logout}>
          Sign out
        </button>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
