import { Link, useParams } from "react-router";
import type { CommitDetail, FileDiff } from "@cohort/shared";
import { shortSha, timeAgo } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { useProject } from "./ProjectLayout.tsx";

export function CommitView() {
  const { project, base } = useProject();
  const { sha = "" } = useParams();
  const { data, error } = useApi<{ commit: CommitDetail }>(
    `/api/projects/${project.workspace}/${project.slug}/commits/${sha}`,
  );

  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  const c = data.commit;
  const additions = c.files.reduce((n, f) => n + f.additions, 0);
  const deletions = c.files.reduce((n, f) => n + f.deletions, 0);

  return (
    <>
      <section className="panel">
        <h2>{c.subject}</h2>
        {c.body && <pre className="plain">{c.body}</pre>}
        <div className="muted">
          {c.authorName} &lt;{c.authorEmail}&gt; committed {timeAgo(c.date)} · <code>{shortSha(c.sha)}</code>
          {c.parents.length > 0 && (
            <>
              {" · parent "}
              {c.parents.map((p) => (
                <Link key={p} className="sha" to={`${base}/commit/${p}`}>
                  {shortSha(p)}
                </Link>
              ))}
            </>
          )}
        </div>
        <div className="muted">
          {c.files.length} {c.files.length === 1 ? "file" : "files"} changed,{" "}
          <span className="add">+{additions}</span> <span className="del">−{deletions}</span> ·{" "}
          <Link to={`${base}/tree?${new URLSearchParams({ ref: c.sha, path: "" })}`}>Browse files</Link>
        </div>
      </section>
      {c.files.map((f, i) => (
        <FileDiffView key={i} file={f} />
      ))}
    </>
  );
}

const statusLabel: Record<FileDiff["status"], string> = {
  added: "Added",
  deleted: "Deleted",
  modified: "Modified",
  renamed: "Renamed",
};

export function FileDiffView({ file }: { file: FileDiff }) {
  const name =
    file.status === "renamed" ? `${file.oldPath} → ${file.newPath}` : (file.newPath ?? file.oldPath);
  return (
    <section className="panel flush">
      <div className="panel-bar">
        <code>{name}</code>
        <span className="muted">
          {statusLabel[file.status]} · <span className="add">+{file.additions}</span>{" "}
          <span className="del">−{file.deletions}</span>
        </span>
      </div>
      {file.binary ? (
        <p className="muted pad">Binary file.</p>
      ) : !file.patch ? (
        <p className="muted pad">No content changes.</p>
      ) : (
        <table className="code diff">
          <tbody>
            {diffRows(file.patch).map((row, i) => (
              <tr key={i} className={row.kind}>
                <td className="ln">{row.old ?? ""}</td>
                <td className="ln">{row.new ?? ""}</td>
                <td>
                  <pre>{row.text}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface DiffRow {
  kind: "hunk" | "add" | "del" | "ctx";
  old: number | null;
  new: number | null;
  text: string;
}

// Turns unified diff hunks into rows with old/new line numbers.
function diffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", old: null, new: null, text: line });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", old: null, new: newLine++, text: line });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", old: oldLine++, new: null, text: line });
    } else if (line.startsWith("\\")) {
      rows.push({ kind: "ctx", old: null, new: null, text: line });
    } else {
      rows.push({ kind: "ctx", old: oldLine++, new: newLine++, text: line });
    }
  }
  return rows;
}
