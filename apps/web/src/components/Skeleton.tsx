// Placeholder rows shaped like the content that's loading, so nothing jumps when it arrives.
export function SkeletonRows({ rows = 3, height = 56 }: { rows?: number; height?: number }) {
  return (
    <div className="skeleton-list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}
