import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Status } from "@cohort/shared";
import { api } from "./api.ts";

interface SessionContext {
  status: Status | null;
  error: string | null;
  refresh: () => Promise<void>;
}

const Context = createContext<SessionContext | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<Status>("/api/status"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Can't reach the Cohort server");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <Context.Provider value={{ status, error, refresh }}>{children}</Context.Provider>;
}

export function useSession() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
