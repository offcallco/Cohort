import { useState } from "react";
import { useNavigate } from "react-router";
import type { Bot, WorkshopDetail } from "@cohort/shared";
import { api } from "../../api.ts";
import { Form } from "../../components/Form.tsx";
import { MarkdownEditor } from "../../components/MarkdownEditor.tsx";
import { useApi } from "../../hooks.ts";
import { useProject } from "./ProjectLayout.tsx";

export function NewWorkshopView() {
  const { project, base } = useProject();
  const navigate = useNavigate();
  const bots = useApi<{ bots: Bot[] }>("/api/bots").data?.bots ?? [];
  const [idea, setIdea] = useState("");
  const [bot, setBot] = useState("");
  const chosen = bot || bots.find((b) => b.available)?.username || bots[0]?.username || "";
  const chosenBot = bots.find((b) => b.username === chosen);

  async function start() {
    const { workshop } = await api<{ workshop: WorkshopDetail }>(`/api/projects/${project.workspace}/${project.slug}/workshops`, {
      body: { idea, bot: chosen },
    });
    navigate(`${base}/workshops/${workshop.id}`);
  }

  return (
    <section className="panel narrow-wide">
      <h2>New workshop</h2>
      <p className="muted">
        Describe what you want to build. The agent reads <code>{project.defaultBranch}</code>, then asks one question at a time and
        keeps a plan as you go. It can't change any code.
      </p>
      <Form onSubmit={start}>
        {(busy) => (
          <>
            <label>
              Your idea
              <MarkdownEditor
                value={idea}
                onChange={setIdea}
                rows={8}
                autoFocus
                placeholder="e.g. Let workspace admins invite people by email, with invites that expire after a week."
              />
            </label>
            <label>
              Agent
              <select value={chosen} onChange={(e) => setBot(e.target.value)}>
                {bots.map((b) => (
                  <option key={b.id} value={b.username}>
                    {b.username}
                    {b.available ? "" : " (no runner online)"}
                  </option>
                ))}
              </select>
              {chosenBot && !chosenBot.available && (
                <span className="muted small">No runner can run {chosenBot.agentType} right now. The workshop will wait for one.</span>
              )}
            </label>
            <div className="row">
              <button type="submit" disabled={busy || !idea.trim() || !chosen}>
                Start workshop
              </button>
              <button type="button" className="secondary" onClick={() => navigate(`${base}/workshops`)}>
                Cancel
              </button>
            </div>
          </>
        )}
      </Form>
    </section>
  );
}
