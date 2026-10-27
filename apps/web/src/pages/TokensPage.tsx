import { useEffect, useState, type FormEvent } from "react";
import type { AccessToken, CreatedAccessToken } from "@cohort/shared";
import { api } from "../api.ts";

const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "Never");

export function TokensPage() {
  const [tokens, setTokens] = useState<AccessToken[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedAccessToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await api<{ tokens: AccessToken[] }>("/api/tokens");
    setTokens(res.tokens);
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ token: CreatedAccessToken }>("/api/tokens", { body: { name } });
      setCreated(res.token);
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the token");
    }
  }

  async function revoke(token: AccessToken) {
    await api(`/api/tokens/${token.id}`, { method: "DELETE" });
    if (created?.id === token.id) setCreated(null);
    await load();
  }

  return (
    <>
      <h1>Access tokens</h1>
      <p className="muted">
        Tokens let git and scripts sign in as you. Use one as the password when git asks, or send it
        as <code>Authorization: Bearer &lt;token&gt;</code>.
      </p>

      <form className="panel row" onSubmit={create}>
        <input
          placeholder="Token name, e.g. laptop git"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button type="submit">Create token</button>
      </form>
      {error && <p className="error">{error}</p>}

      {created && (
        <div className="panel notice">
          <strong>Copy your new token now. It won't be shown again.</strong>
          <div className="row">
            <code className="secret">{created.token}</code>
            <button onClick={() => navigator.clipboard.writeText(created.token)}>Copy</button>
          </div>
        </div>
      )}

      <section className="panel">
        {tokens === null ? null : tokens.length === 0 ? (
          <p className="muted">No tokens yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Token</th>
                <th>Created</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>
                    <code>{t.prefix}…</code>
                  </td>
                  <td>{formatDate(t.createdAt)}</td>
                  <td>{formatDate(t.lastUsedAt)}</td>
                  <td className="actions">
                    <button className="danger" onClick={() => revoke(t)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
