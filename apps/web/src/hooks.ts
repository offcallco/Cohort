import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";

// Fetches `path` and refetches when it changes. Pass null to skip. With `pollMs`, refetches
// on that interval while `poll` is true.
export function useApi<T>(path: string | null, options: { pollMs?: number; poll?: (data: T) => boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);

  const load = useCallback(async () => {
    if (path === null) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const { pollMs, poll } = options;
  const shouldPoll = pollMs !== undefined && data !== null && (poll ? poll(data) : true);
  useEffect(() => {
    if (!shouldPoll || path === null) return;
    const timer = setInterval(async () => {
      try {
        setData(await api<T>(path));
      } catch {
        // Keep the last good data; the next tick retries.
      }
    }, pollMs);
    return () => clearInterval(timer);
  }, [shouldPoll, path, pollMs]);

  return { data, error, loading, reload: load };
}
