import type { FastifyInstance } from "fastify";
import { requireUser } from "./auth.ts";
import { transaction, type Db } from "./db.ts";

/**
 * Chaves do localStorage do open3dcalc que o servidor aceita, e onde cada uma
 * mora. Espelha `src/platform/web/sync/keys.ts` no front — manter os dois iguais.
 * Chave fora desta tabela é recusada (400): fica só no navegador.
 */
export const KEY_SCOPES = {
  // Dados da farm — iguais para todos os usuários.
  open3dcalc_settings_v2: "shared",
  open3dcalc_history_v2: "shared",
  open3dcalc_customers_v1: "shared",
  open3dcalc_quotes_v1: "shared",
  open3dcalc_catalog_v1: "shared",
  open3dcalc_filaments: "shared",
  open3dcalc_color_palette_v1: "shared",
  open3dcalc_products: "shared",
  open3dcalc_dashboard_v1: "shared",
  open3dcalc_dashboard_goal: "shared",
  // Preferências — cada usuário tem as suas.
  open3dcalc_theme: "user",
  open3dcalc_sections: "user",
  open3dcalc_layout_v1: "user",
  open3dcalc_consent_v1: "user",
  open3dcalc_tutorial_v1: "user",
  open3dcalc_onboarded: "user",
  open3dcalc_quickstart_dismissed: "user",
  open3dcalc_share_prefs_v1: "user",
  open3dcalc_model_comparison: "user",
  open3dcalc_marketplace_comparison_v1: "user",
  i18nextLng: "user",
} as const satisfies Record<string, "shared" | "user">;

export type SyncedKey = keyof typeof KEY_SCOPES;

export function isSyncedKey(key: string): key is SyncedKey {
  return Object.hasOwn(KEY_SCOPES, key);
}

function scopeFor(key: SyncedKey, userId: number): string {
  return KEY_SCOPES[key] === "shared" ? "shared" : `u:${userId}`;
}

export interface KvItem {
  key: string;
  /** JSON cru, exatamente como estava no localStorage. `null` = apagada. */
  value: string | null;
  version: number;
  updatedAt: number;
  updatedBy: number | null;
}

interface KvRow {
  key: string;
  value: string | null;
  version: number;
  updated_at: number;
  updated_by: number | null;
}

const toItem = (row: KvRow): KvItem => ({
  key: row.key,
  value: row.value,
  version: row.version,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
});

/** Itens visíveis ao usuário (compartilhados + os dele) com version > since. */
export function listItems(db: Db, userId: number, since: number): { rev: number; items: KvItem[] } {
  return transaction(db, () => {
    const rows = db
      .prepare(
        `SELECT key, value, version, updated_at, updated_by FROM kv
         WHERE scope IN ('shared', ?) AND version > ?
         ORDER BY version`,
      )
      .all(`u:${userId}`, since) as unknown as KvRow[];
    const { value: rev } = db.prepare("SELECT value FROM counters WHERE name = 'kv_rev'").get() as {
      value: number;
    };
    return { rev, items: rows.map(toItem) };
  });
}

export type PutResult =
  | { ok: true; version: number }
  | { ok: false; current: KvItem | null };

/**
 * Grava com controle otimista: só aplica se a versão atual da chave for
 * `baseVersion` (0 = "espero que ainda não exista"). Apagar grava tombstone
 * com versão nova, que o cliente recebe no pull como qualquer outra.
 */
export function putItem(
  db: Db,
  userId: number,
  key: SyncedKey,
  value: string | null,
  baseVersion: number,
): PutResult {
  const scope = scopeFor(key, userId);
  return transaction(db, () => {
    const row = db
      .prepare("SELECT key, value, version, updated_at, updated_by FROM kv WHERE scope = ? AND key = ?")
      .get(scope, key) as KvRow | undefined;
    if ((row?.version ?? 0) !== baseVersion) {
      return { ok: false, current: row ? toItem(row) : null };
    }
    if (row && row.value === value) return { ok: true, version: row.version };

    db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'kv_rev'").run();
    const { value: version } = db
      .prepare("SELECT value FROM counters WHERE name = 'kv_rev'")
      .get() as { value: number };
    db.prepare(
      `INSERT INTO kv (scope, key, value, version, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET
         value = excluded.value, version = excluded.version,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(scope, key, value, version, Date.now(), userId);
    return { ok: true, version };
  });
}

export async function kvRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.get<{ Querystring: { since?: number } }>(
    "/api/kv",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { since: { type: "integer", minimum: 0 } },
        },
      },
    },
    async (request) => {
      const user = requireUser(request);
      return listItems(db, user.id, request.query.since ?? 0);
    },
  );

  app.put<{ Params: { key: string }; Body: { value: string | null; baseVersion: number } }>(
    "/api/kv/:key",
    {
      schema: {
        body: {
          type: "object",
          required: ["value", "baseVersion"],
          additionalProperties: false,
          properties: {
            value: { type: ["string", "null"] },
            baseVersion: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { key } = request.params;
      if (!isSyncedKey(key)) {
        return reply.code(400).send({ error: `Chave não sincronizável: ${key}` });
      }
      const { value, baseVersion } = request.body;
      if (value !== null) {
        try {
          JSON.parse(value);
        } catch {
          return reply.code(400).send({ error: "value precisa ser JSON válido." });
        }
      }
      const result = putItem(db, user.id, key, value, baseVersion);
      if (!result.ok) return reply.code(409).send({ error: "conflict", current: result.current });
      return { version: result.version };
    },
  );
}
