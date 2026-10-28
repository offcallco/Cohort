import { z } from "zod";
import { proposedIssue, type ProposedIssue } from "@cohort/shared";

export interface ParsedReply {
  message: string;
  // Null when the agent didn't include a plan; keep the previous one.
  plan: string | null;
  // Null when there was no <issues> section; an error when it couldn't be read.
  issues: ProposedIssue[] | null;
  issuesError: string | null;
}

function section(text: string, tag: string): string | null {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|$)`, "i"));
  return match ? match[1]!.trim() : null;
}

// Removes a surrounding ``` fence, which agents often add around JSON.
const unfence = (text: string) => text.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();

// Reads an agent reply in the workshop format: <message>, <plan> and, when finalizing, <issues>.
// Anything outside the tags is ignored when there's a <message>; otherwise the whole reply
// becomes the message.
export function parseReply(text: string): ParsedReply {
  const plan = section(text, "plan");
  const rawIssues = section(text, "issues");
  let message = section(text, "message");
  if (message === null) {
    message = text.replace(/<(plan|issues)>[\s\S]*?(<\/\1>|$)/gi, "").trim();
  }

  let issues: ProposedIssue[] | null = null;
  let issuesError: string | null = null;
  if (rawIssues !== null) {
    try {
      const parsed = z.array(proposedIssue).min(1).safeParse(JSON.parse(unfence(rawIssues)));
      if (parsed.success) issues = parsed.data;
      else issuesError = parsed.error.issues[0]?.message ?? "Invalid issue list";
    } catch {
      issuesError = "The issue list wasn't valid JSON";
    }
  }
  return { message: message || "(The agent replied without a message.)", plan, issues, issuesError };
}

// Orders issues so each comes after the ones it depends on. Throws on unknown keys or cycles.
export function orderIssues(list: ProposedIssue[]): ProposedIssue[] {
  const byKey = new Map<string, ProposedIssue>();
  for (const issue of list) {
    if (byKey.has(issue.key)) throw new Error(`Two issues use the key "${issue.key}"`);
    byKey.set(issue.key, issue);
  }
  for (const issue of list) {
    for (const dep of issue.dependsOn) {
      if (!byKey.has(dep)) throw new Error(`"${issue.title}" depends on "${dep}", which isn't in the list`);
      if (dep === issue.key) throw new Error(`"${issue.title}" can't depend on itself`);
    }
  }
  const ordered: ProposedIssue[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (issue: ProposedIssue) => {
    const s = state.get(issue.key);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`The dependencies loop back to "${issue.title}"`);
    state.set(issue.key, "visiting");
    for (const dep of issue.dependsOn) visit(byKey.get(dep)!);
    state.set(issue.key, "done");
    ordered.push(issue);
  };
  for (const issue of list) visit(issue);
  return ordered;
}

// Reads a split job's reply: the <issues> list, where an empty list (or none) means "don't
// split". Returns null when the list is missing or unreadable.
export function parseSubtasks(text: string): ProposedIssue[] | null {
  const raw = section(text, "issues");
  if (raw === null) return null;
  try {
    const parsed = z.array(proposedIssue).max(50).safeParse(JSON.parse(unfence(raw)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
