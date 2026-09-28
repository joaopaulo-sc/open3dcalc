/**
 * Merge 3-way de valores JSON (fork ModelInk3D).
 *
 * base   = último valor que este navegador sincronizou com o servidor
 * local  = valor atual neste navegador
 * remote = valor atual no servidor (gravado por outro usuário/aba)
 *
 * Regras:
 * - Só um lado mudou em relação à base → fica a mudança.
 * - Objetos → merge campo a campo (campo removido de um lado e intocado do
 *   outro = removido).
 * - Listas de objetos com `id` (orçamentos, clientes, histórico…) → merge
 *   item a item: inclusões dos dois lados entram, exclusões são respeitadas,
 *   o mesmo item editados dos dois lados é mesclado campo a campo.
 * - Contadores `next*` (ex.: `nextNumber` dos orçamentos) somam os
 *   incrementos dos dois lados, para não repetir numeração.
 * - Conflito real no mesmo campo primitivo → vence o local (quem está salvando).
 */

type Json = unknown;
type Id = string | number;

function isPlainObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOf(value: Json): Id | undefined {
  if (!isPlainObject(value)) return undefined;
  const id = value.id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

function isIdList(value: Json): value is Record<string, Json>[] {
  return Array.isArray(value) && value.every((item) => idOf(item) !== undefined);
}

export function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function isCounterField(field: string | undefined): boolean {
  return !!field && /^next[A-Z0-9]/.test(field);
}

export function merge3(base: Json, local: Json, remote: Json, field?: string): Json {
  // Antes do atalho local === remoto: 5→6 dos dois lados são DOIS incrementos.
  if (
    isCounterField(field) &&
    Number.isInteger(base) &&
    Number.isInteger(local) &&
    Number.isInteger(remote)
  ) {
    const b = base as number;
    return b + Math.max(0, (local as number) - b) + Math.max(0, (remote as number) - b);
  }

  if (deepEqual(local, remote)) return local;
  if (deepEqual(base, local)) return remote;
  if (deepEqual(base, remote)) return local;

  if (isPlainObject(local) && isPlainObject(remote)) {
    return mergeObjects(isPlainObject(base) ? base : {}, local, remote);
  }

  if (isIdList(local) && isIdList(remote)) {
    return mergeIdLists(isIdList(base) ? base : [], local, remote);
  }

  return local;
}

function mergeObjects(
  base: Record<string, Json>,
  local: Record<string, Json>,
  remote: Record<string, Json>,
): Record<string, Json> {
  const out: Record<string, Json> = {};
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    const inLocal = Object.hasOwn(local, key);
    const inRemote = Object.hasOwn(remote, key);
    const inBase = Object.hasOwn(base, key);
    if (inLocal && inRemote) {
      out[key] = merge3(base[key], local[key], remote[key], key);
    } else if (inLocal) {
      // Sumiu do remoto: se o local não mexeu desde a base, foi apagado lá.
      if (!(inBase && deepEqual(base[key], local[key]))) out[key] = local[key];
    } else if (!(inBase && deepEqual(base[key], remote[key]))) {
      out[key] = remote[key];
    }
  }
  return out;
}

function mergeIdLists(
  base: Record<string, Json>[],
  local: Record<string, Json>[],
  remote: Record<string, Json>[],
): Record<string, Json>[] {
  const baseById = new Map(base.map((item) => [idOf(item)!, item]));
  const localById = new Map(local.map((item) => [idOf(item)!, item]));
  const remoteIds = new Set(remote.map((item) => idOf(item)!));
  const out: Record<string, Json>[] = [];

  // Ordem do remoto primeiro; depois o que só existe no local.
  for (const item of remote) {
    const id = idOf(item)!;
    const mine = localById.get(id);
    const original = baseById.get(id);
    if (mine !== undefined) {
      out.push(merge3(original, mine, item) as Record<string, Json>);
    } else if (!(original !== undefined && deepEqual(original, item))) {
      // Novo no remoto, ou editado lá depois que apaguei aqui (edição vence).
      out.push(item);
    }
  }
  for (const item of local) {
    const id = idOf(item)!;
    if (remoteIds.has(id)) continue;
    const original = baseById.get(id);
    if (!(original !== undefined && deepEqual(original, item))) out.push(item);
  }
  return out;
}

/**
 * Merge de valores crus do localStorage (strings JSON; null = ausente).
 * Se algum lado não for JSON válido, vence o local.
 */
export function mergeRaw(
  base: string | null,
  local: string | null,
  remote: string | null,
): string | null {
  if (local === remote) return local;
  if (local === base) return remote;
  if (remote === base) return local;
  // Apagado de um lado e intocado do outro → apagado.
  if (local === null || remote === null) return local ?? remote;
  try {
    const merged = merge3(
      base === null ? undefined : JSON.parse(base),
      JSON.parse(local),
      JSON.parse(remote),
    );
    return JSON.stringify(merged);
  } catch {
    return local;
  }
}
