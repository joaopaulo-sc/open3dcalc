/** Cliente HTTP do servidor do fork ModelInk3D (mesma origem, cookie de sessão). */

export interface ServerUser {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

export interface KvItem {
  key: string;
  value: string | null;
  version: number;
  updatedAt: number;
  updatedBy: number | null;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Sessão expirada");
  }
}

export class ConflictError extends Error {
  readonly current: KvItem | null;
  constructor(current: KvItem | null) {
    super("Conflito de versão");
    this.current = current;
  }
}

async function request<T>(method: string, url: string, body?: unknown, keepalive = false): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    keepalive,
    headers: body === undefined ? { "X-Calc": "1" } : { "X-Calc": "1", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new UnauthorizedError();
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 409) throw new ConflictError((data.current as KvItem | null) ?? null);
  if (!res.ok) throw new Error(String(data.error ?? `HTTP ${res.status}`));
  return data as T;
}

export function redirectToLogin(): void {
  const next = location.pathname + location.search + location.hash;
  location.replace(`/login?next=${encodeURIComponent(next)}`);
}

export const api = {
  me: () => request<{ user: ServerUser }>("GET", "/api/auth/me").then((r) => r.user),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("POST", "/api/auth/password", { currentPassword, newPassword }),
  list: (since: number) => request<{ rev: number; items: KvItem[] }>("GET", `/api/kv?since=${since}`),
  put: (key: string, value: string | null, baseVersion: number, keepalive = false) =>
    request<{ version: number }>(
      "PUT",
      `/api/kv/${encodeURIComponent(key)}`,
      { value, baseVersion },
      keepalive,
    ),
};
