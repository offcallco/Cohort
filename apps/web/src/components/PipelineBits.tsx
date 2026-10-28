import { Link } from "react-router";
import type { CiJobStatus, PipelineStatus, PipelineSummary } from "@cohort/shared";

const tone: Record<PipelineStatus | CiJobStatus, string> = {
  manual: "review",
  pending: "todo",
  created: "todo",
  running: "in_progress",
  success: "done",
  failed: "blocked",
  canceled: "todo",
  skipped: "todo",
};
const label: Record<PipelineStatus | CiJobStatus, string> = {
  manual: "Waiting to run",
  pending: "Pending",
  created: "Created",
  running: "Running",
  success: "Passed",
  failed: "Failed",
  canceled: "Canceled",
  skipped: "Skipped",
};

export function PipelineStatusPill({ status }: { status: PipelineStatus | CiJobStatus }) {
  return <span className={`status status-${tone[status]}`}>{label[status]}</span>;
}

export function PipelineLink({ base, pipeline }: { base: string; pipeline: PipelineSummary }) {
  return (
    <span className="row wrap">
      <PipelineStatusPill status={pipeline.status} />
      <Link to={`${base}/pipelines/${pipeline.id}`}>Pipeline #{pipeline.id}</Link>
    </span>
  );
}
