import { CSRF_HEADER } from "@tu-ban/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
/** Called when the server says the session is gone (expired, logged out elsewhere, account disabled). */
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

/** JSON request to the server with the session cookie and the CSRF header (a Blob/File body is sent as raw bytes). */
export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body instanceof Blob ? { "content-type": "application/octet-stream" } : body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { [CSRF_HEADER]: "1" } : {}),
    },
    body: body instanceof Blob ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/api/auth/")) onUnauthorized();
    throw new ApiError((data as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  }
  return data as T;
}
