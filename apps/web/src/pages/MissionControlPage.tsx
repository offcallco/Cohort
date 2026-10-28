import { Link } from "react-router";
import type { MissionControl } from "@cohort/shared";
import { NeedsYouRow } from "../components/NeedsYou.tsx";
import { OutcomeRow } from "../components/OutcomeRow.tsx";
import { RunCard } from "../components/RunCard.tsx";
import { SkeletonRows } from "../components/Skeleton.tsx";
import { useApi } from "../hooks.ts";

// Home: what needs me right now, what's running, what just finished.
export function MissionControlPage() {
  const { data, error, reload } = useApi<MissionControl>("/api/mission", { pollMs: 3000 });

  return (
    <>
      <div className="page-head">
        <h1>Mission Control</h1>
        {data && (
          <dl className="stats">
            <div>
              <dt>Running</dt>
              <dd>{data.counts.running}</dd>
            </div>
            <div className={data.counts.needsYou ? "stat-waiting" : ""}>
              <dt>Needs you</dt>
              <dd>{data.counts.needsYou}</dd>
            </div>
            <div className={data.counts.failed24h ? "stat-failed" : ""}>
              <dt>Failed, last 24h</dt>
              <dd>{data.counts.failed24h}</dd>
            </div>
          </dl>
        )}
      </div>
      {error && (
        <div className="panel">
          <p className="error">Couldn't load Mission Control: {error}</p>
          <button className="secondary" onClick={reload}>
            Try again
          </button>
        </div>
      )}

      <section className="section">
        <h2>Needs you</h2>
        {!data ? (
          <SkeletonRows rows={2} height={72} />
        ) : data.needsYou.length === 0 ? (
          <p className="empty-line">Nothing needs you. Agents are running clean.</p>
        ) : (
          <>
            <ul className="need-list">
              {data.needsYou.map((item) => (
                <NeedsYouRow key={item.id} item={item} onDone={reload} />
              ))}
            </ul>
            {data.counts.needsYou > data.needsYou.length && (
              <Link to="/reviews" className="small">
                See all {data.counts.needsYou} in Reviews
              </Link>
            )}
          </>
        )}
      </section>

      <section className="section">
        <h2>Running now</h2>
        {!data ? (
          <SkeletonRows rows={1} height={140} />
        ) : data.running.length === 0 ? (
          <p className="empty-line">No agents are running. Assign an issue to claude-bot or codex-bot to start one.</p>
        ) : (
          <div className="run-grid">
            {data.running.map((run) => (
              <RunCard key={run.jobId} run={run} onChange={reload} />
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <h2>Recent outcomes</h2>
        {!data ? (
          <SkeletonRows rows={3} height={48} />
        ) : data.recent.length === 0 ? (
          <p className="empty-line">Nothing has finished yet. Merged and failed work shows up here.</p>
        ) : (
          <ul className="outcome-list">
            {data.recent.map((o) => (
              <OutcomeRow key={o.id} outcome={o} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
