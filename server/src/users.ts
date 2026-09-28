import type { Db } from "./db.ts";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./passwords.ts";

export interface User {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  disabled: boolean;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  disabled: number;
}

export interface UserWithHash extends User {
  passwordHash: string;
}

function toUser(row: UserRow): UserWithHash {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    disabled: row.disabled === 1,
    passwordHash: row.password_hash,
  };
}

export function publicUser(user: User): User {
  const { id, username, displayName, isAdmin, disabled } = user;
  return { id, username, displayName, isAdmin, disabled };
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/i;

export function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
}

export async function createUser(
  db: Db,
  input: { username: string; displayName?: string; password: string; isAdmin?: boolean },
): Promise<User> {
  if (!USERNAME_RE.test(input.username)) {
    throw new Error("Usuário inválido: use 2–32 letras, números, ponto, hífen ou _.");
  }
  validatePassword(input.password);
  const hash = await hashPassword(input.password);
  const result = db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, is_admin, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.username,
      input.displayName?.trim() || input.username,
      hash,
      input.isAdmin ? 1 : 0,
      Date.now(),
    );
  return publicUser(getUserById(db, Number(result.lastInsertRowid))!);
}

export function getUserById(db: Db, id: number): UserWithHash | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function getUserByUsername(db: Db, username: string): UserWithHash | null {
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
    | UserRow
    | undefined;
  return row ? toUser(row) : null;
}

export function listUsers(db: Db): User[] {
  const rows = db.prepare("SELECT * FROM users ORDER BY id").all() as unknown as UserRow[];
  return rows.map((row) => publicUser(toUser(row)));
}

export async function setPassword(db: Db, userId: number, password: string): Promise<void> {
  validatePassword(password);
  const hash = await hashPassword(password);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
  // Troca de senha derruba todas as sessões do usuário.
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function setDisabled(db: Db, userId: number, disabled: boolean): void {
  db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, userId);
  if (disabled) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}
