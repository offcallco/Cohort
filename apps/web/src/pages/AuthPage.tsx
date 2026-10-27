import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../api.ts";
import { useSession } from "../session.tsx";

// First-run account creation and sign-in share one form.
export function AuthPage({ mode }: { mode: "setup" | "login" }) {
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(mode === "setup" ? "/api/setup" : "/api/login", { body: { username, password } });
      await refresh();
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="centered">
      <form className="card" onSubmit={submit}>
        <h1>{mode === "setup" ? "Set up Cohort" : "Sign in to Cohort"}</h1>
        {mode === "setup" && (
          <p className="muted">Create the account for this install. You'll use it to sign in.</p>
        )}
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "setup" ? "new-password" : "current-password"}
            minLength={mode === "setup" ? 8 : undefined}
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {mode === "setup" ? "Create account" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
