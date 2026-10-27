import { useState, type FormEvent, type ReactNode } from "react";

// Form wrapper that handles the busy state and shows the error thrown by `onSubmit`.
export function Form({
  onSubmit,
  children,
  className = "stack",
}: {
  onSubmit: () => Promise<void>;
  children: (busy: boolean) => ReactNode;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={className} onSubmit={submit}>
      {children(busy)}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
