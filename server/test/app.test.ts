import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { resetLoginFailuresForTests } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db.ts";
import { createUser } from "../src/users.ts";

const PASSWORD = "senha-forte-123";
const CSRF = { "x-calc": "1" };

let app: FastifyInstance;
let db: Db;
let staticDir: string;

async function login(username: string, password = PASSWORD): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: CSRF,
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  const cookie = res.cookies.find((c) => c.name === "calc_sid");
  assert.ok(cookie?.httpOnly);
  return `calc_sid=${cookie.value}`;
}

function put(cookie: string, key: string, value: string | null, baseVersion: number) {
  return app.inject({
    method: "PUT",
    url: `/api/kv/${key}`,
    headers: { ...CSRF, cookie },
    payload: { value, baseVersion },
  });
}

function list(cookie: string, since = 0) {
  return app.inject({ method: "GET", url: `/api/kv?since=${since}`, headers: { cookie } });
}

before(async () => {
  staticDir = mkdtempSync(path.join(tmpdir(), "calc-static-"));
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>app</title>");
  mkdirSync(path.join(staticDir, "assets"));
  writeFileSync(path.join(staticDir, "assets", "main-abc123.js"), "console.log(1)");

  db = openDb(":memory:");
  const config = { ...loadConfig({}), staticDir, publicOrigin: "https://calc.example", cookieSecure: false, loginRatePerMinute: 1000 };
  await createUser(db, { username: "ana", password: PASSWORD, isAdmin: true });
  await createUser(db, { username: "bia", password: PASSWORD });
  app = await buildApp({ db, config });
});

after(async () => {
  await app.close();
  db.close();
});

describe("acesso sem sessão", () => {
  test("API responde 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/kv" });
    assert.equal(res.statusCode, 401);
  });

  test("navegação redireciona para /login com next", async () => {
    const res = await app.inject({ method: "GET", url: "/orcamentos?x=1", headers: { accept: "text/html" } });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, "/login?next=%2Forcamentos%3Fx%3D1");
  });

  test("assets do app exigem sessão", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/main-abc123.js" });
    assert.equal(res.statusCode, 401);
  });

  test("tela de login e healthz são públicas", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/login" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/_login/login.js" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/healthz" })).statusCode, 200);
  });
});

describe("login", () => {
  test("senha errada e usuário inexistente dão a mesma resposta", async () => {
    resetLoginFailuresForTests();
    const wrong = await app.inject({
      method: "POST", url: "/api/auth/login", headers: CSRF,
      payload: { username: "ana", password: "errada-errada" },
    });
    const missing = await app.inject({
      method: "POST", url: "/api/auth/login", headers: CSRF,
      payload: { username: "zeca", password: "errada-errada" },
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(missing.statusCode, 401);
    assert.equal(wrong.body, missing.body);
  });

  test("sem header X-Calc é recusado (CSRF)", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "ana", password: PASSWORD },
    });
    assert.equal(res.statusCode, 403);
  });

  test("Origin de outro site é recusado", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/auth/login",
      headers: { ...CSRF, origin: "https://evil.example" },
      payload: { username: "ana", password: PASSWORD },
    });
    assert.equal(res.statusCode, 403);
  });

  test("login ok → /me, app servido, logout invalida", async () => {
    const cookie = await login("ana");
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    assert.equal(me.json().user.username, "ana");
    assert.equal(me.json().user.passwordHash, undefined);

    const asset = await app.inject({ method: "GET", url: "/assets/main-abc123.js", headers: { cookie } });
    assert.equal(asset.statusCode, 200);
    assert.match(String(asset.headers["cache-control"]), /immutable/);

    const spa = await app.inject({ method: "GET", url: "/qualquer/rota", headers: { cookie, accept: "text/html" } });
    assert.equal(spa.statusCode, 200);
    assert.match(spa.body, /<title>app<\/title>/);

    const loginPage = await app.inject({ method: "GET", url: "/login", headers: { cookie } });
    assert.equal(loginPage.statusCode, 302);

    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...CSRF, cookie } });
    const after = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    assert.equal(after.statusCode, 401);
  });

  test("trocar senha derruba outras sessões e mantém a atual", async () => {
    const other = await login("bia");
    const current = await login("bia");
    const res = await app.inject({
      method: "POST", url: "/api/auth/password", headers: { ...CSRF, cookie: current },
      payload: { currentPassword: PASSWORD, newPassword: "outra-senha-forte" },
    });
    assert.equal(res.statusCode, 200, res.body);
    const fresh = `calc_sid=${res.cookies.find((c) => c.name === "calc_sid")!.value}`;
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: other } })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: fresh } })).statusCode, 200);

    // devolve a senha original para os outros testes
    await app.inject({
      method: "POST", url: "/api/auth/password", headers: { ...CSRF, cookie: fresh },
      payload: { currentPassword: "outra-senha-forte", newPassword: PASSWORD },
    });
  });
});

describe("kv", () => {
  test("dado compartilhado aparece para todos; preferência é por usuário", async () => {
    const ana = await login("ana");
    const bia = await login("bia");

    const quotes = JSON.stringify({ state: { quotes: [{ id: "q1" }] }, version: 0 });
    assert.equal((await put(ana, "open3dcalc_quotes_v1", quotes, 0)).statusCode, 200);
    assert.equal((await put(ana, "open3dcalc_theme", '"dark"', 0)).statusCode, 200);

    const biaItems = (await list(bia)).json().items as { key: string; value: string }[];
    assert.deepEqual(biaItems.map((i) => i.key), ["open3dcalc_quotes_v1"]);
    assert.equal(biaItems[0]!.value, quotes);

    // bia grava o próprio tema sem conflitar com o da ana
    assert.equal((await put(bia, "open3dcalc_theme", '"light"', 0)).statusCode, 200);
  });

  test("versão desatualizada → 409 com o valor atual", async () => {
    const ana = await login("ana");
    const bia = await login("bia");
    const v1 = (await put(ana, "open3dcalc_customers_v1", '{"a":1}', 0)).json().version as number;
    assert.equal((await put(bia, "open3dcalc_customers_v1", '{"a":2}', v1)).statusCode, 200);

    const stale = await put(ana, "open3dcalc_customers_v1", '{"a":3}', v1);
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().current.value, '{"a":2}');
  });

  test("pull incremental e tombstone de exclusão", async () => {
    const ana = await login("ana");
    const { rev } = (await list(ana)).json() as { rev: number };
    const v = (await put(ana, "open3dcalc_filaments", "[1]", 0)).json().version as number;
    const del = await put(ana, "open3dcalc_filaments", null, v);
    assert.equal(del.statusCode, 200);

    const delta = (await list(ana, rev)).json();
    assert.deepEqual(delta.items.map((i: { value: string | null }) => i.value), [null]);
    assert.equal(delta.rev, del.json().version);

    // recriar depois de apagar usa a versão do tombstone
    assert.equal((await put(ana, "open3dcalc_filaments", "[2]", del.json().version)).statusCode, 200);
  });

  test("chave desconhecida e JSON inválido são recusados", async () => {
    const ana = await login("ana");
    assert.equal((await put(ana, "open3dcalc_erasure_journal", "{}", 0)).statusCode, 400);
    assert.equal((await put(ana, "open3dcalc_catalog_v1", "{nao-json", 0)).statusCode, 400);
  });
});
