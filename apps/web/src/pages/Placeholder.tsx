import type { ReactNode } from "react";

// Pages from the UI guide that later steps fill in.
export function Placeholder({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h1>{title}</h1>
      <section className="panel empty">
        <p className="muted">{children}</p>
      </section>
    </>
  );
}
