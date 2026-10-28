import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { PipelineDetail, PipelineSummary } from "@cohort/shared";
import { api } from "../../api.ts";
import { PipelineStatusPill } from "../../components/PipelineBits.tsx";
import { shortSha, timeAgo } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { useProject } from "./ProjectLayout.tsx";

const sourceLabel = { push: "push", merge_request: "merge request", web: "run by hand" } as const;

export function PipelinesView() {
  const { project, base, branches } = useProject();
  const navigate = useNavigate();
  const apiBase = `/api/projects/${project.workspace}/${project.slug}`;
  const { data, error } = useApi<{ pipelines: PipelineSummary[] }>(`${apiBase}/pipelines`, {
    pollMs: 3000,
    poll: (d) => d.pipelines.some((p) => p.status === "pending" || p.status === "running"),
  });
  const [ref, setRef] = useState("");
  const [runError, setRunError] = useState<string | null>(null);
  const chosen = ref || project.defaultBranch || "";

  async function runPipeline() {
    try {
      const res = await api<{ pipeline: PipelineDetail }>(`${apiBase}/pipelines`, { body: { ref: chosen } });
      navigate(`${base}/pipelines/${res.pipeline.id}`);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Couldn't start the pipeline");
    }
  }

  return (
    <>
      <div className="toolbar spread">
        <p className="muted">
          Pipelines run the jobs in <code>.cohort-ci.yml</code> on every push, and on merge requests.
        </p>
        {branches.length > 0 && (
          <div className="row">
            <select value={chosen} onChange={(e) => setRef(e.target.value)}>
              {branches.map((b) => (
                <option key={b.name}>{b.name}</option>
              ))}
            </select>
            <button onClick={runPipeline}>Run pipeline</button>
          </div>
        )}
      </div>
      {runError && <p className="error">{runError}</p>}
      {error && <p className="error">{error}</p>}
      {data &&
        (data.pipelines.length === 0 ? (
          <section className="panel empty">
            <h2>No pipelines yet</h2>
            <p className="muted">Add a .cohort-ci.yml to the repo, in the same format as GitLab's .gitlab-ci.yml:</p>
            <pre className="plain left">{`stages: [build, test]

build:
  stage: build
  script:
    - npm ci

test:
  stage: test
  script:
    - npm test`}</pre>
          </section>
        ) : (
          <section className="panel flush">
            <ul className="list">
              {data.pipelines.map((p) => (
                <li key={p.id} className="list-row">
                  <div>
                    <Link to={`${base}/pipelines/${p.id}`}>Pipeline #{p.id}</Link>
                    <div className="muted small">
                      <code>{p.ref}</code> at {shortSha(p.sha)} · {sourceLabel[p.source]} by {p.triggeredBy} · {timeAgo(p.createdAt)}
                      {p.mergeRequest && (
                        <>
                          {" · "}
                          <Link to={`${base}/merge_requests/${p.mergeRequest}`}>!{p.mergeRequest}</Link>
                        </>
                      )}
                      {p.error && <span className="error"> · {p.error}</span>}
                    </div>
                  </div>
                  <PipelineStatusPill status={p.status} />
                </li>
              ))}
            </ul>
          </section>
        ))}
    </>
  );
}
