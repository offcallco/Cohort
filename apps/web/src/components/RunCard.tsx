import { useState } from "react";
import { Link } from "react-router";
import { FileText } from "lucide-react";
import type { RunCard as Run } from "@cohort/shared";
import { api } from "../api.ts";
import { elapsed, plural } from "../format.ts";
import { useNow } from "../useNow.ts";
import { AgentName } from "./Agent.tsx";
import { StatusPill } from "./StatusPill.tsx";

// A live agent run: who, on what, doing what right now. Never a log excerpt.
export function RunCard({ run, onChange }: { run: Run; onChange: () => void }) {
  const now = useNow();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function stop() {
    setBusy(true);
    try {
      await api(`/api/jobs/${run.jobId}/cancel`, { method: "POST" });
      onChange();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <article className="run-card">
      <div className="row spread">
        <AgentName name={run.agent} />
        {run.status === "running" ? (
          <StatusPill tone="running" label={run.startedAt ? elapsed(run.startedAt, now) : "Running"} />
        ) : (
          <StatusPill tone="idle" icon="clock" label="Queued" />
        )}
      </div>
      <Link to={run.taskHref} className="run-task">
        {run.task}
      </Link>
      <p className="run-phase">{run.phase}</p>
      <div className="meta">
        <span className="mono">{run.project}</span>
        {run.filesTouched > 0 && (
          <span>
            <FileText size={12} aria-hidden /> {plural(run.filesTouched, "file")} edited
          </span>
        )}
      </div>
      <div className="row">
        <Link className="button secondary small" to={`/${run.project}/jobs/${run.jobId}`}>
          View run
        </Link>
        {confirming ? (
          <>
            <button className="danger small" disabled={busy} onClick={stop}>
              Stop it
            </button>
            <span className="muted small">Anything already pushed stays on its branch.</span>
            <button className="link small" onClick={() => setConfirming(false)}>
              Keep running
            </button>
          </>
        ) : (
          <button className="danger small" onClick={() => setConfirming(true)}>
            Stop
          </button>
        )}
      </div>
    </article>
  );
}
