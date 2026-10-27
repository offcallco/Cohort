import type { ApiError } from "@cohort/shared";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// JSON fetch against the Cohort API. Throws ApiRequestError with the server's message.
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as T | ApiError;
  if (!res.ok) {
    const message = (data as ApiError).error ?? `Request failed (${res.status})`;
    throw new ApiRequestError(message, res.status);
  }
  return data as T;
}
