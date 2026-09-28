import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Servidor KV falso, com as mesmas regras de versão do server/src/kv.ts. */
function fakeServer() {
  let rev = 0;
  const rows = new Map<string, { value: string | null; version: number }>();
  const puts: { key: string; value: string | null; baseVersion: number }[] = [];

  const set = (key: string, value: string | null) => {
    rev += 1;
    rows.set(key, { value, version: rev });
    return rev;
  };

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const method = init?.method ?? "GET";
    if (url === "/api/auth/me") {
      return json(200, { user: { id: 7, username: "ana", displayName: "Ana Lima", isAdmin: false } });
    }
    if (url.startsWith("/api/kv?since=")) {
      const since = Number(url.split("=")[1]);
      const items = [...rows]
        .filter(([, r]) => r.version > since)
        .map(([key, r]) => ({ key, ...r, updatedAt: 0, updatedBy: 1 }));
      return json(200, { rev, items });
    }
    if (url.startsWith("/api/kv/") && method === "PUT") {
      const key = decodeURIComponent(url.slice("/api/kv/".length));
      const body = JSON.parse(String(init!.body)) as { value: string | null; baseVersion: number };
      puts.push({ key, ...body });
      const row = rows.get(key);
      if ((row?.version ?? 0) !== body.baseVersion) {
        return json(409, { error: "conflict", current: row ? { key, ...row, updatedAt: 0, updatedBy: 2 } : null });
      }
      return json(200, { version: set(key, body.value) });
    }
    return json(404, {});
  });

  return { rows, puts, set, fetchMock };
}

type Server = ReturnType<typeof fakeServer>;
const quotes = (...ids: string[]) =>
  JSON.stringify({ state: { quotes: ids.map((id) => ({ id })), nextNumber: ids.length + 1 }, version: 0 });

async function loadEngine() {
  const engine = await import("../engine");
  const { guardedStorage } = await import("@/shared/lib/manifestStorage");
  return { engine, guardedStorage };
}

async function settle() {
  await vi.advanceTimersByTimeAsync(700);
  await vi.runOnlyPendingTimersAsync();
}

describe("sync engine", () => {
  let server: Server;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    localStorage.clear();
    server = fakeServer();
    vi.stubGlobal("fetch", server.fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("boot copies server data into localStorage before the app starts", async () => {
    server.set("open3dcalc_quotes_v1", quotes("q1"));
    localStorage.setItem("calc_sync_user", "7");
    localStorage.setItem("open3dcalc_quotes_v1", quotes("velho"));
    const { engine } = await loadEngine();

    const user = await engine.bootSync();

    expect(user.displayName).toBe("Ana Lima");
    expect(localStorage.getItem("open3dcalc_quotes_v1")).toBe(quotes("q1"));
    expect(engine.useSyncStatus.getState().user?.id).toBe(7);
  });

  it("switching user on the same browser drops the previous user's data", async () => {
    localStorage.setItem("calc_sync_user", "99");
    localStorage.setItem("open3dcalc_theme", '"dark"');
    const { engine } = await loadEngine();

    await engine.bootSync();

    expect(localStorage.getItem("open3dcalc_theme")).toBeNull();
    expect(server.puts).toHaveLength(0);
  });

  it("leftovers written after logout are not uploaded as the next user's data", async () => {
    localStorage.setItem("calc_sync_user", "logged-out");
    localStorage.setItem("open3dcalc_settings_v2", '{"productName":"rascunho de outra pessoa"}');
    const { engine } = await loadEngine();

    await engine.bootSync();
    engine.startSync(() => true);
    await settle();

    expect(localStorage.getItem("open3dcalc_settings_v2")).toBeNull();
    expect(server.puts).toHaveLength(0);
  });

  it("a browser used before the server uploads its local data on first sync", async () => {
    localStorage.setItem("open3dcalc_customers_v1", '{"state":{"customers":[{"id":"c1"}]},"version":0}');
    const { engine } = await loadEngine();

    await engine.bootSync();
    engine.startSync(() => true);
    await settle();

    expect(server.rows.get("open3dcalc_customers_v1")?.value).toContain('"c1"');
  });

  it("pushes store writes after the debounce", async () => {
    localStorage.setItem("calc_sync_user", "7");
    const { engine, guardedStorage } = await loadEngine();
    await engine.bootSync();
    engine.startSync(() => true);

    guardedStorage.setItem("open3dcalc_quotes_v1", quotes("a"));
    guardedStorage.setItem("open3dcalc_quotes_v1", quotes("a", "b"));
    await settle();

    expect(server.puts).toHaveLength(1);
    expect(server.rows.get("open3dcalc_quotes_v1")?.value).toBe(quotes("a", "b"));
    expect(engine.useSyncStatus.getState().state).toBe("synced");
  });

  it("on conflict merges with the other user's write instead of overwriting it", async () => {
    server.set("open3dcalc_quotes_v1", quotes("1"));
    localStorage.setItem("calc_sync_user", "7");
    const { engine, guardedStorage } = await loadEngine();
    await engine.bootSync();
    const rehydrate = vi.fn(() => true);
    engine.startSync(rehydrate);

    // Outro usuário cria "R" enquanto este cria "L".
    server.set("open3dcalc_quotes_v1", quotes("1", "R"));
    guardedStorage.setItem("open3dcalc_quotes_v1", quotes("1", "L"));
    await settle();

    const saved = JSON.parse(server.rows.get("open3dcalc_quotes_v1")!.value!);
    expect(saved.state.quotes.map((x: { id: string }) => x.id)).toEqual(["1", "R", "L"]);
    expect(saved.state.nextNumber).toBe(4);
    expect(localStorage.getItem("open3dcalc_quotes_v1")).toBe(server.rows.get("open3dcalc_quotes_v1")!.value);
    expect(rehydrate).toHaveBeenCalledWith("open3dcalc_quotes_v1");
  });

  it("wiping localStorage directly (erase data / logout) never deletes server data", async () => {
    server.set("open3dcalc_customers_v1", '{"state":{"customers":[{"id":"c1"}]},"version":0}');
    localStorage.setItem("calc_sync_user", "7");
    const { engine } = await loadEngine();
    await engine.bootSync();
    engine.startSync(() => true);

    localStorage.removeItem("open3dcalc_customers_v1");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    await settle();

    expect(server.puts).toHaveLength(0);
    expect(server.rows.get("open3dcalc_customers_v1")?.value).toContain("c1");
  });

  it("pull applies other users' changes and rehydrates the store", async () => {
    localStorage.setItem("calc_sync_user", "7");
    const { engine } = await loadEngine();
    await engine.bootSync();
    const rehydrate = vi.fn(() => true);
    engine.startSync(rehydrate);

    server.set("open3dcalc_filaments", '[{"id":"s1"}]');
    await engine.pull();

    expect(localStorage.getItem("open3dcalc_filaments")).toBe('[{"id":"s1"}]');
    expect(rehydrate).toHaveBeenCalledWith("open3dcalc_filaments");
    expect(server.puts).toHaveLength(0);
  });
});
