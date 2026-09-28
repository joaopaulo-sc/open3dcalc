import path from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { authRoutes, resolveSession, SESSION_COOKIE } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { kvRoutes } from "./kv.ts";

const LOGIN_ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Rotas acessíveis sem sessão. */
function isPublic(request: FastifyRequest): boolean {
  const url = request.url.split("?")[0]!;
  if (request.method === "GET" || request.method === "HEAD") {
    return url === "/login" || url === "/healthz" || url.startsWith("/_login/");
  }
  return request.method === "POST" && url === "/api/auth/login";
}

function wantsHtml(request: FastifyRequest): boolean {
  return (
    request.headers["sec-fetch-mode"] === "navigate" ||
    (request.headers.accept ?? "").includes("text/html")
  );
}

export async function buildApp(opts: { db: Db; config: Config; logger?: boolean }): Promise<FastifyInstance> {
  const { db, config } = opts;
  const app = Fastify({
    logger: opts.logger ?? false,
    // Confia só nos N proxies da frente (Cloudflare + Traefik); o resto do
    // X-Forwarded-For pode ser forjado pelo cliente.
    trustProxy: (_address: string, hop: number) => hop < config.trustProxyHops,
    // Histórico/orçamentos são guardados como um JSON só por chave.
    bodyLimit: 8 * 1024 * 1024,
  });

  app.decorateRequest("user", null);

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) =>
      (request.headers["cf-connecting-ip"] as string | undefined) ?? request.ip,
  });

  app.addHook("onRequest", async (request, reply) => {
    request.user = resolveSession(db, config, request.cookies[SESSION_COOKIE]);

    // CSRF: toda mutação precisa do header custom (força preflight CORS, que
    // não liberamos) e, se vier Origin, ela tem de ser a nossa.
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.origin;
      const badOrigin = config.publicOrigin && origin && origin !== config.publicOrigin;
      if (request.headers["x-calc"] !== "1" || badOrigin) {
        return reply.code(403).send({ error: "Requisição recusada (CSRF)." });
      }
    }

    if (request.user || isPublic(request)) return;
    if (request.url.startsWith("/api/")) {
      return reply.code(401).send({ error: "Não autenticado" });
    }
    if (request.method === "GET" && wantsHtml(request)) {
      return reply.redirect(`/login?next=${encodeURIComponent(request.url)}`);
    }
    return reply.code(401).send({ error: "Não autenticado" });
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
  });

  app.get("/healthz", async () => ({ ok: true }));

  await app.register(authRoutes, { db, config });
  await app.register(kvRoutes, { db });

  // Tela de login (HTML + CSS + JS próprios, sem inline — CSP estrita).
  await app.register(fastifyStatic, {
    root: LOGIN_ASSETS,
    prefix: "/_login/",
    cacheControl: false,
    setHeaders: (reply) => reply.header("Cache-Control", "no-cache"),
  });
  app.get("/login", async (request, reply) => {
    if (request.user) return reply.redirect("/");
    reply
      .header("Cache-Control", "no-store")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    return reply.sendFile("login.html", LOGIN_ASSETS);
  });

  if (config.staticDir) {
    const staticDir = config.staticDir;
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: "/",
      wildcard: false,
      index: false,
      decorateReply: false,
      cacheControl: false,
      setHeaders: (reply, filePath) => {
        // Arquivos com hash no nome podem ficar em cache para sempre;
        // index.html, sw.js e manifest precisam revalidar a cada deploy.
        const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
        reply.header("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    app.get("/", async (_request, reply) =>
      reply.header("Cache-Control", "no-cache").sendFile("index.html", staticDir),
    );
    // SPA: qualquer GET que não seja API nem arquivo existente cai no index.html.
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/") && wantsHtml(request)) {
        return reply.header("Cache-Control", "no-cache").sendFile("index.html", staticDir);
      }
      return reply.code(404).send({ error: "Não encontrado" });
    });
  }

  return app;
}
