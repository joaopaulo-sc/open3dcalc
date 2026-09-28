import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { getDummyHash, verifyPassword } from "./passwords.ts";
import {
  getUserById,
  getUserByUsername,
  publicUser,
  setPassword,
  type User,
} from "./users.ts";

export const SESSION_COOKIE = "calc_sid";
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createSession(db: Db, config: Config, userId: number, userAgent?: string): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sha256(token), userId, now, now + config.sessionDays * 86_400_000, now, userAgent?.slice(0, 200) ?? null);
  return token;
}

interface SessionRow {
  token_hash: string;
  user_id: number;
  expires_at: number;
  last_seen_at: number;
}

/** Resolve o token do cookie; renova a validade (sliding) no máximo 1×/hora. */
export function resolveSession(db: Db, config: Config, token: string | undefined): User | null {
  if (!token) return null;
  const tokenHash = sha256(token);
  const row = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as
    | SessionRow
    | undefined;
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at <= now) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }
  const user = getUserById(db, row.user_id);
  if (!user || user.disabled) return null;
  if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
    db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").run(
      now,
      now + config.sessionDays * 86_400_000,
      tokenHash,
    );
  }
  return publicUser(user);
}

function setSessionCookie(reply: FastifyReply, config: Config, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    maxAge: config.sessionDays * 86_400,
  });
}

/**
 * Bloqueio por usuário além do rate limit por IP: 10 falhas seguidas travam o
 * login daquele usuário por 15 minutos. Em memória — reinício zera, aceitável.
 */
const failures = new Map<string, { count: number; lockedUntil: number }>();
const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60 * 1000;

function isLocked(username: string): boolean {
  const entry = failures.get(username.toLowerCase());
  return !!entry && entry.lockedUntil > Date.now();
}

function registerFailure(username: string): void {
  const key = username.toLowerCase();
  const entry = failures.get(key) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILURES) {
    entry.count = 0;
    entry.lockedUntil = Date.now() + LOCK_MS;
  }
  failures.set(key, entry);
}

export function resetLoginFailuresForTests(): void {
  failures.clear();
}

const credentialsSchema = {
  type: "object",
  required: ["username", "password"],
  additionalProperties: false,
  properties: {
    username: { type: "string", minLength: 1, maxLength: 64 },
    password: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const;

export function requireUser(request: FastifyRequest): User {
  if (!request.user) throw Object.assign(new Error("Não autenticado"), { statusCode: 401 });
  return request.user;
}

export async function authRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts;

  app.post<{ Body: { username: string; password: string } }>(
    "/api/auth/login",
    {
      schema: { body: credentialsSchema },
      config: { rateLimit: { max: config.loginRatePerMinute, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { username, password } = request.body;
      const generic = { error: "Usuário ou senha incorretos." };
      if (isLocked(username)) {
        return reply.code(429).send({ error: "Muitas tentativas. Tente novamente em 15 minutos." });
      }
      const user = getUserByUsername(db, username.trim());
      const ok = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
      if (!user || !ok || user.disabled) {
        registerFailure(username);
        request.log.warn({ username }, "login falhou");
        return reply.code(401).send(generic);
      }
      failures.delete(username.toLowerCase());
      const token = createSession(db, config, user.id, request.headers["user-agent"]);
      setSessionCookie(reply, config, token);
      request.log.info({ userId: user.id }, "login ok");
      return { user: publicUser(user) };
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => ({ user: requireUser(request) }));

  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    "/api/auth/password",
    {
      schema: {
        body: {
          type: "object",
          required: ["currentPassword", "newPassword"],
          additionalProperties: false,
          properties: {
            currentPassword: { type: "string", maxLength: 256 },
            newPassword: { type: "string", maxLength: 256 },
          },
        },
      },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const me = requireUser(request);
      const full = getUserById(db, me.id)!;
      if (!(await verifyPassword(request.body.currentPassword, full.passwordHash))) {
        return reply.code(400).send({ error: "Senha atual incorreta." });
      }
      try {
        await setPassword(db, me.id, request.body.newPassword);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
      // setPassword derrubou todas as sessões; abre uma nova para este navegador.
      setSessionCookie(reply, config, createSession(db, config, me.id, request.headers["user-agent"]));
      return { ok: true };
    },
  );
}
