import type { JobKind, JobStatus, MergeRequestStatus } from "@cohort/shared";
import { StatusPill, type Tone } from "./StatusPill.tsx";

export const JOB_KIND_LABELS: Record<JobKind, string> = {
  implement: "Implement",
  split: "Plan the split",
  resolve: "Resolve conflict",
  workshop: "Workshop turn",
};

const jobTone: Record<JobStatus, Tone> = {
  queued: "idle",
  running: "running",
  succeeded: "passed",
  failed: "failed",
  canceled: "idle",
};
const jobLabel: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
};

export function JobStatusPill({ status }: { status: JobStatus }) {
  return <StatusPill tone={jobTone[status]} label={jobLabel[status]} icon={status === "queued" ? "clock" : undefined} />;
}

// An open merge request is waiting on a person to review it.
const mrTone: Record<MergeRequestStatus, Tone> = { open: "waiting", merged: "passed", closed: "idle" };
const mrLabel: Record<MergeRequestStatus, string> = { open: "Needs review", merged: "Merged", closed: "Closed" };

export function MergeRequestPill({ status }: { status: MergeRequestStatus }) {
  return <StatusPill tone={mrTone[status]} label={mrLabel[status]} />;
}
