import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * Migrações em ordem. `PRAGMA user_version` guarda quantas já rodaram.
 * Nunca edite uma migração publicada — acrescente outra.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash   TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent   TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- scope = 'shared' (dados da farm) ou 'u:<user_id>' (preferências pessoais).
  -- value NULL = chave apagada (tombstone, para o pull incremental enxergar).
  -- version = revisão global monotônica (counters.kv_rev) da última escrita.
  CREATE TABLE kv (
    scope      TEXT    NOT NULL,
    key        TEXT    NOT NULL,
    value      TEXT,
    version    INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (scope, key)
  );
  CREATE INDEX kv_version ON kv(version);

  CREATE TABLE counters (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  INSERT INTO counters(name, value) VALUES ('kv_rev', 0);
  `,
];

export function openDb(dataDir: string | ":memory:"): Db {
  let file = ":memory:";
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, "calc.sqlite");
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let i = row.user_version; i < MIGRATIONS.length; i++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}

/** Executa `fn` numa transação IMMEDIATE (trava de escrita desde o início). */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
