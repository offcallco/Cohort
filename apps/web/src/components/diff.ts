import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, lang] of Object.entries({ bash, css, go, java, javascript, json, markdown, python, ruby, rust, sql, typescript, xml, yaml })) {
  hljs.registerLanguage(name, lang);
}

const BY_EXTENSION: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript",
  json: "json", css: "css", scss: "css", html: "xml", xml: "xml", svg: "xml",
  md: "markdown", markdown: "markdown", py: "python", go: "go", rs: "rust",
  rb: "ruby", java: "java", sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml",
};

export const extensionOf = (path: string) => (path.includes(".") ? path.split(".").pop()!.toLowerCase() : "");

export function languageFor(path: string) {
  return BY_EXTENSION[extensionOf(path)] ?? null;
}

// Syntax-highlighted HTML for one line (highlight.js escapes the text). Lines are highlighted
// one at a time, so multi-line strings and comments aren't always colored right.
export function highlightLine(text: string, language: string | null) {
  if (!language) return null;
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

export interface Side {
  n: number;
  text: string;
  type: "add" | "del" | "ctx";
}

export type DiffRow = { kind: "hunk"; text: string } | { kind: "line"; old: Side | null; new: Side | null };

// Unified rows: one per diff line, with old/new line numbers.
export function unifiedRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) rows.push({ kind: "line", old: null, new: { n: newLine++, text: line.slice(1), type: "add" } });
    else if (line.startsWith("-")) rows.push({ kind: "line", old: { n: oldLine++, text: line.slice(1), type: "del" }, new: null });
    else if (line.startsWith("\\")) continue;
    else {
      const text = line.slice(1);
      rows.push({ kind: "line", old: { n: oldLine++, text, type: "ctx" }, new: { n: newLine++, text, type: "ctx" } });
    }
  }
  return rows;
}

// Side-by-side rows: runs of deletions and additions are paired line by line.
export function splitRows(patch: string): DiffRow[] {
  const out: DiffRow[] = [];
  let dels: Side[] = [];
  let adds: Side[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ kind: "line", old: dels[i] ?? null, new: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const row of unifiedRows(patch)) {
    if (row.kind === "hunk") {
      flush();
      out.push(row);
    } else if (row.old?.type === "del") dels.push(row.old);
    else if (row.new?.type === "add") adds.push(row.new);
    else {
      flush();
      out.push(row);
    }
  }
  flush();
  return out;
}
