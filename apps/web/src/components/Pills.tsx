import type { JobKind, JobStatus, MergeRequestStatus } from "@cohort/shared";

export const JOB_KIND_LABELS: Record<JobKind, string> = {
  implement: "Implement",
  split: "Plan the split",
  resolve: "Resolve conflict",
  workshop: "Workshop turn",
};

// Reuses the issue status colors for jobs and merge requests.
const jobTone: Record<JobStatus, string> = {
  queued: "todo",
  running: "in_progress",
  succeeded: "done",
  failed: "blocked",
  canceled: "todo",
};
const jobLabel: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
};

export function JobStatusPill({ status }: { status: JobStatus }) {
  return <span className={`status status-${jobTone[status]}`}>{jobLabel[status]}</span>;
}

const mrTone: Record<MergeRequestStatus, string> = { open: "in_progress", merged: "review", closed: "blocked" };
const mrLabel: Record<MergeRequestStatus, string> = { open: "Open", merged: "Merged", closed: "Closed" };

export function MergeRequestPill({ status }: { status: MergeRequestStatus }) {
  return <span className={`status status-${mrTone[status]}`}>{mrLabel[status]}</span>;
}
