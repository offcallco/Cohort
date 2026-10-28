import { useSearchParams } from "react-router";
import type { NeedKind, NeedsYouItem } from "@cohort/shared";
import { NeedsYouRow } from "../components/NeedsYou.tsx";
import { SkeletonRows } from "../components/Skeleton.tsx";
import { useApi } from "../hooks.ts";

const FILTERS: { key: string; label: string; kinds: NeedKind[] }[] = [
  { key: "", label: "All", kinds: [] },
  { key: "review", label: "Reviews", kinds: ["review", "pipeline"] },
  { key: "approve", label: "Approvals", kinds: ["plan", "split"] },
  { key: "failed", label: "Failed", kinds: ["failed_job", "failed_pipeline"] },
  { key: "questions", label: "Questions", kinds: ["workshop"] },
];

// The inbox: only what's waiting on a person. Empty is a good thing.
export function ReviewsPage() {
  const [search, setSearch] = useSearchParams();
  const { data, error, reload } = useApi<{ items: NeedsYouItem[] }>("/api/reviews", { pollMs: 5000 });
  const filter = FILTERS.find((f) => f.key === (search.get("show") ?? "")) ?? FILTERS[0]!;
  const items = data?.items.filter((i) => filter.kinds.length === 0 || filter.kinds.includes(i.kind)) ?? [];
  const count = (f: (typeof FILTERS)[number]) => data?.items.filter((i) => f.kinds.length === 0 || f.kinds.includes(i.kind)).length ?? 0;

  return (
    <>
      <h1>Reviews</h1>
      <div className="chips" role="group" aria-label="Filter">
        {FILTERS.map((f) => (
          <button key={f.key} className={`chip${f === filter ? " active" : ""}`} onClick={() => setSearch(f.key ? { show: f.key } : {})} aria-pressed={f === filter}>
            {f.label}
            <span className="chip-count">{count(f)}</span>
          </button>
        ))}
      </div>
      {error && <p className="error">Couldn't load your reviews: {error}</p>}
      {!data ? (
        <SkeletonRows rows={3} height={72} />
      ) : items.length === 0 ? (
        <section className="panel empty">
          <h2>Nothing needs you.</h2>
          <p className="muted">{filter.kinds.length ? "Nothing of this kind is waiting." : "When an agent needs a review, an approval or an answer, it shows up here."}</p>
        </section>
      ) : (
        <ul className="need-list">
          {items.map((item) => (
            <NeedsYouRow key={item.id} item={item} onDone={reload} />
          ))}
        </ul>
      )}
    </>
  );
}
