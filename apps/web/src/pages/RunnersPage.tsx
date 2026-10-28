import { useState } from "react";
import type { Bot, Runner } from "@cohort/shared";
import { api } from "../api.ts";
import { Form } from "../components/Form.tsx";
import { timeAgo } from "../format.ts";
import { useApi } from "../hooks.ts";

export function RunnersPage() {
  const { data, error, reload } = useApi<{ runners: Runner[] }>("/api/runners", { pollMs: 5000 });
  const bots = useApi<{ bots: Bot[] }>("/api/bots", { pollMs: 5000 }).data?.bots ?? [];
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);

  async function create() {
    const res = await api<{ runner: Runner; token: string }>("/api/runners", { body: { name } });
    setCreated({ name: res.runner.name, token: res.token });
    setName("");
    await reload();
  }

  async function remove(id: number) {
    await api(`/api/runners/${id}`, { method: "DELETE" });
    setConfirming(null);
    await reload();
  }

  const config = created
    ? `url = "${location.origin}"
token = "${created.token}"
concurrent = 2

[[agents]]
name = "claude"
type = "claude-code"
limit = 2

[[agents]]
name = "codex"
type = "codex"
limit = 2`
    : "";

  return (
    <>
      <h1>Runners</h1>
      <p className="muted">
        Runners run agent jobs. Cohort starts one on this machine automatically; add more to run agents elsewhere.
      </p>

      <section className="panel">
        <div className="panel-title">Agents</div>
        <ul className="list">
          {bots.map((b) => (
            <li key={b.id} className="row wrap">
              <strong>{b.username}</strong>
              <span className="muted small">{b.agentType}</span>
              <span className={`status status-${b.available ? "done" : "todo"}`}>{b.available ? "Available" : "No runner online"}</span>
            </li>
          ))}
        </ul>
      </section>

      {error && <p className="error">{error}</p>}
      <section className="panel flush">
        {data && data.runners.length === 0 ? (
          <p className="muted pad">No runners yet.</p>
        ) : (
          <ul className="list">
            {data?.runners.map((r) => (
              <li key={r.id} className="list-row">
                <div>
                  <strong>{r.name}</strong> <span className={`status status-${r.online ? "done" : "todo"}`}>{r.online ? "Online" : "Offline"}</span>
                  <div className="muted small">
                    {r.online
                      ? `${r.agents.map((a) => `${a.name} (${a.type}, ${a.limit} at once)`).join(", ") || "No agents"} · ${r.runningJobs} of ${r.concurrent} slots busy`
                      : r.lastSeenAt
                        ? `Last seen ${timeAgo(r.lastSeenAt)}`
                        : "Never connected"}
                    {" · "}
                    <code>{r.prefix}…</code>
                  </div>
                </div>
                {confirming === r.id ? (
                  <div className="row">
                    <button className="danger" onClick={() => remove(r.id)}>
                      Delete
                    </button>
                    <button className="secondary small" onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                  </div>
                ) : (
                  <button className="danger" onClick={() => setConfirming(r.id)}>
                    Delete…
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Add a runner</h2>
        <Form onSubmit={create} className="row wrap">
          {(busy) => (
            <>
              <input placeholder="Runner name, e.g. build-box" value={name} onChange={(e) => setName(e.target.value)} required />
              <button type="submit" disabled={busy}>
                Create runner
              </button>
            </>
          )}
        </Form>
      </section>

      {created && (
        <section className="panel notice">
          <strong>Runner "{created.name}" created. Copy its token now; it won't be shown again.</strong>
          <p className="muted">
            On the machine that will run agents, save this as <code>config.toml</code> in a clone of Cohort, then run{" "}
            <code>pnpm runner run --config config.toml</code>.
          </p>
          <pre className="plain">{config}</pre>
          <div>
            <button onClick={() => navigator.clipboard.writeText(config)}>Copy config</button>
          </div>
        </section>
      )}
    </>
  );
}
