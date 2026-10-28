import { Link } from "react-router";
import type { CiJobStatus, PipelineStatus, PipelineSummary } from "@cohort/shared";
import { StatusPill, type Tone } from "./StatusPill.tsx";

const tone: Record<PipelineStatus | CiJobStatus, Tone> = {
  manual: "waiting",
  pending: "idle",
  created: "idle",
  running: "running",
  success: "passed",
  failed: "failed",
  canceled: "idle",
  skipped: "idle",
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
  const icon = status === "pending" || status === "created" ? "clock" : status === "manual" ? "clock" : undefined;
  return <StatusPill tone={tone[status]} label={label[status]} icon={icon} />;
}

export function PipelineLink({ base, pipeline }: { base: string; pipeline: PipelineSummary }) {
  return (
    <span className="row wrap">
      <PipelineStatusPill status={pipeline.status} />
      <Link to={`${base}/pipelines/${pipeline.id}`}>Pipeline #{pipeline.id}</Link>
    </span>
  );
}
