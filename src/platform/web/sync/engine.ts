/**
 * Motor de sincronização localStorage ↔ servidor (fork ModelInk3D).
 *
 * Os stores continuam lendo/gravando o localStorage como no upstream. Este
 * módulo:
 *  1. no boot (ANTES de importar os stores) baixa tudo do servidor para o
 *     localStorage — os stores hidratam já com os dados do servidor;
 *  2. escuta cada gravação feita via manifestStorage e envia ao servidor
 *     (debounce por chave, controle otimista de versão);
 *  3. em conflito (409) faz merge 3-way com o que outro usuário gravou;
 *  4. busca mudanças dos outros no foco da aba e a cada 30 s, e reidrata
 *     os stores afetados.
 *
 * Nada aqui importa stores: a reidratação é injetada depois do boot.
 */
import { create } from "zustand";
import { setStorageWriteListener } from "@/shared/lib/manifestStorage";
import {
  api,
  ConflictError,
  redirectToLogin,
  UnauthorizedError,
  type KvItem,
  type ServerUser,
} from "./api";
import { isSyncedKey, KEY_SCOPES, SYNC_USER_KEY, SYNCED_KEYS, type SyncedKey } from "./keys";
import { mergeRaw } from "./merge";

const PUSH_DEBOUNCE_MS = 600;
const PULL_INTERVAL_MS = 30_000;
const RETRY_MS = 5_000;
const MAX_CONFLICT_ROUNDS = 5;
/** Limite do corpo de um fetch keepalive é 64 KB. */
const KEEPALIVE_MAX_CHARS = 60_000;

export type SyncState = "synced" | "saving" | "offline";

interface SyncStatus {
  user: ServerUser | null;
  state: SyncState;
  lastSyncedAt: number | null;
}

export const useSyncStatus = create<SyncStatus>(() => ({
  user: null,
  state: "synced",
  lastSyncedAt: null,
}));

/** Reidrata o store dono da chave. Retorna false se não houver como. */
export type Rehydrator = (key: SyncedKey) => boolean;

interface Synced {
  version: number;
  raw: string | null;
}

/** Último valor/versão que este navegador confirmou com o servidor. */
const synced = new Map<SyncedKey, Synced>();
/**
 * Chaves com edição local ainda não confirmada pelo servidor. Só entra aqui o
 * que passou pelo manifestStorage (edição real) ou por merge — nunca uma
 * remoção direta do localStorage (logout, "apagar meus dados"), que não pode
 * virar exclusão no servidor.
 */
const pending = new Set<SyncedKey>();
const timers = new Map<SyncedKey, ReturnType<typeof setTimeout>>();
const inflight = new Map<SyncedKey, Promise<void>>();
let rev = 0;
let stopped = false;
let rehydrate: Rehydrator = () => false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function raw(key: SyncedKey): string | null {
  return window.localStorage.getItem(key);
}

/** Grava direto no localStorage, sem disparar o listener (não é edição local). */
function writeRaw(key: SyncedKey, value: string | null): void {
  if (value === null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, value);
}

function known(key: SyncedKey): Synced {
  return synced.get(key) ?? { version: 0, raw: null };
}

function refreshState(): void {
  const busy = inflight.size > 0 || timers.size > 0 || pending.size > 0;
  if (useSyncStatus.getState().state === "offline" && busy) return;
  useSyncStatus.setState({
    state: busy ? "saving" : "synced",
    ...(busy ? {} : { lastSyncedAt: Date.now() }),
  });
}

function handleFailure(error: unknown): void {
  if (error instanceof UnauthorizedError) {
    redirectToLogin();
    return;
  }
  console.warn("[sync] falha, nova tentativa em breve:", error);
  useSyncStatus.setState({ state: "offline" });
  if (!retryTimer) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      useSyncStatus.setState({ state: "saving" });
      void flushAll().then(pull);
    }, RETRY_MS);
  }
}

/* ------------------------------------------------------------------ */
/*  Push                                                               */
/* ------------------------------------------------------------------ */

function schedulePush(key: SyncedKey): void {
  if (stopped) return;
  pending.add(key);
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void flush(key);
    }, PUSH_DEBOUNCE_MS),
  );
  refreshState();
}

/** Envia a chave; serializado por chave para não brigar consigo mesmo. */
function flush(key: SyncedKey): Promise<void> {
  const previous = inflight.get(key) ?? Promise.resolve();
  const next = previous
    .then(() => push(key))
    .finally(() => {
      if (inflight.get(key) === next) inflight.delete(key);
      refreshState();
    });
  inflight.set(key, next);
  refreshState();
  return next;
}

async function push(key: SyncedKey): Promise<void> {
  for (let round = 0; round < MAX_CONFLICT_ROUNDS; round++) {
    if (stopped || !pending.has(key)) return;
    const local = raw(key);
    const base = known(key);
    if (local === base.raw) {
      pending.delete(key);
      return;
    }
    try {
      const { version } = await api.put(key, local, base.version);
      synced.set(key, { version, raw: local });
      // Se houve nova edição durante o envio, continua pendente.
      if (raw(key) === local) pending.delete(key);
      rev = Math.max(rev, version);
      if (useSyncStatus.getState().state === "offline") {
        useSyncStatus.setState({ state: "saving" });
      }
      return;
    } catch (error) {
      if (!(error instanceof ConflictError)) {
        handleFailure(error);
        return;
      }
      // Outro usuário gravou antes: mescla e tenta de novo sobre a versão dele.
      const remote = error.current;
      const merged = mergeRaw(base.raw, raw(key), remote?.value ?? null);
      synced.set(key, { version: remote?.version ?? 0, raw: remote?.value ?? null });
      if (merged !== raw(key)) {
        writeRaw(key, merged);
        rehydrate(key);
      }
    }
  }
  console.error(`[sync] "${key}": conflitos demais seguidos, desisti desta rodada.`);
}

function flushAll(): Promise<void> {
  for (const [key, timer] of timers) {
    clearTimeout(timer);
    timers.delete(key);
  }
  return Promise.all([...pending].map(flush)).then(() => undefined);
}

/**
 * Saída da página: `fetch` com keepalive sobrevive ao fechamento da aba.
 * Conflito aqui não tem como ser mesclado — o valor volta a ser enviado (e
 * mesclado) na próxima abertura só se ainda estiver pendente, o que não
 * acontece; por isso o debounce é curto e a troca de aba já envia tudo.
 */
function flushOnExit(): void {
  if (stopped) return;
  for (const key of pending) {
    const value = raw(key);
    if ((value?.length ?? 0) > KEEPALIVE_MAX_CHARS) continue;
    void api.put(key, value, known(key).version, true).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/*  Pull                                                               */
/* ------------------------------------------------------------------ */

function applyRemote(item: KvItem): void {
  if (!isSyncedKey(item.key)) return;
  const key = item.key;
  const base = known(key);
  if (item.version <= base.version) return;

  const local = raw(key);
  if (!pending.has(key) || local === base.raw) {
    pending.delete(key);
    writeRaw(key, item.value);
    synced.set(key, { version: item.version, raw: item.value });
    if (!rehydrate(key)) {
      console.info(`[sync] "${key}" atualizado no servidor; vale na próxima abertura.`);
    }
    return;
  }
  // Tenho edição local ainda não enviada: mescla agora e reenvia.
  const merged = mergeRaw(base.raw, local, item.value);
  synced.set(key, { version: item.version, raw: item.value });
  writeRaw(key, merged);
  rehydrate(key);
  schedulePush(key);
}

let pulling: Promise<void> | null = null;

export function pull(): Promise<void> {
  if (stopped) return Promise.resolve();
  pulling ??= api
    .list(rev)
    .then(({ rev: serverRev, items }) => {
      for (const item of items) applyRemote(item);
      rev = Math.max(rev, serverRev);
      refreshState();
    })
    .catch(handleFailure)
    .finally(() => {
      pulling = null;
    });
  return pulling;
}

/* ------------------------------------------------------------------ */
/*  Boot                                                               */
/* ------------------------------------------------------------------ */

/**
 * Carrega a sessão e os dados do servidor para o localStorage. Tem de rodar
 * antes de qualquer import de store. Lança se o servidor estiver fora.
 */
export async function bootSync(): Promise<ServerUser> {
  let user: ServerUser;
  try {
    user = await api.me();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirectToLogin();
    throw error;
  }

  const lastUser = window.localStorage.getItem(SYNC_USER_KEY);
  // Primeira vez deste navegador no servidor: o que já existe no localStorage
  // é o uso antigo (só local) e é mesclado com o servidor em vez de descartado.
  const migrating = lastUser === null;
  const { rev: serverRev, items } = await api.list(0);
  const byKey = new Map(items.map((item) => [item.key, item]));

  for (const key of SYNCED_KEYS) {
    const item = byKey.get(key);
    const local = raw(key);
    const remote = item?.value ?? null;
    synced.set(key, { version: item?.version ?? 0, raw: remote });

    if (migrating && local !== null && local !== remote) {
      // Dado compartilhado: une os dois (base vazia). Preferência: fica a local.
      const merged =
        KEY_SCOPES[key] === "shared" && remote !== null ? mergeRaw(null, local, remote) : local;
      writeRaw(key, merged);
      pending.add(key);
    } else {
      // Usuário diferente do anterior, ou navegador já sincronizado: vale o servidor.
      writeRaw(key, remote);
    }
  }
  rev = serverRev;
  window.localStorage.setItem(SYNC_USER_KEY, String(user.id));
  useSyncStatus.setState({ user, state: pending.size ? "saving" : "synced", lastSyncedAt: Date.now() });

  setStorageWriteListener((key) => {
    if (isSyncedKey(key)) schedulePush(key);
  });
  return user;
}

/** Liga reidratação, pull periódico e envio na saída. Chamar após o render. */
export function startSync(rehydrator: Rehydrator): void {
  rehydrate = rehydrator;
  // Dados migrados do uso antigo sobem agora.
  void flushAll();

  window.addEventListener("focus", () => void pull());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void pull();
    else void flushAll();
  });
  // pagehide roda depois do beforeunload do app (que grava o rascunho do cálculo).
  window.addEventListener("pagehide", flushOnExit);
  setInterval(() => {
    if (document.visibilityState === "visible") void pull();
  }, PULL_INTERVAL_MS);
}

/** Sai: envia o pendente, encerra a sessão e limpa os dados locais. */
export async function logout(): Promise<void> {
  await flushAll().catch(() => undefined);
  stopped = true;
  setStorageWriteListener(null);
  await api.logout().catch(() => undefined);
  for (const key of SYNCED_KEYS) window.localStorage.removeItem(key);
  // Não apaga o marcador: o beforeunload do app ainda regrava o rascunho do
  // cálculo durante o redirect, e um navegador "nunca sincronizado" subiria
  // esse resto como dado de quem entrar em seguida. Com o marcador, o próximo
  // login simplesmente descarta o local e usa o servidor.
  window.localStorage.setItem(SYNC_USER_KEY, "logged-out");
  location.replace("/login");
}
