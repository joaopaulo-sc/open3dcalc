import { useState } from "react";
import { CloudOff, KeyRound, LogOut, RefreshCw, CheckCircle2 } from "lucide-react";
import { api } from "./api";
import { logout, useSyncStatus, type SyncState } from "./engine";

const STATUS: Record<SyncState, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  synced: { label: "Tudo salvo no servidor", className: "text-emerald-500", Icon: CheckCircle2 },
  saving: { label: "Salvando…", className: "text-[var(--color-accent)] animate-spin", Icon: RefreshCw },
  offline: { label: "Sem conexão — tentando de novo", className: "text-amber-500", Icon: CloudOff },
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts.at(-1)![0] : "")).toUpperCase();
}

function PasswordForm({ onDone }: { onDone: () => void }): React.ReactElement {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api.changePassword(current, next);
      setMessage({ ok: true, text: "Senha alterada. Outros dispositivos foram desconectados." });
      setCurrent("");
      setNext("");
      setTimeout(onDone, 2500);
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none";

  return (
    <form onSubmit={submit} className="mt-2 space-y-2 px-1">
      <input
        type="password"
        autoComplete="current-password"
        placeholder="Senha atual"
        aria-label="Senha atual"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        className={inputClass}
        required
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder="Nova senha (mín. 10)"
        aria-label="Nova senha"
        minLength={10}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        className={inputClass}
        required
      />
      {message && (
        <p role="status" className={`text-xs ${message.ok ? "text-emerald-500" : "text-red-500"}`}>
          {message.text}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="flex-1 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
        >
          Salvar
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}

/** Usuário logado, status do sync, troca de senha e sair (fork ModelInk3D). */
export function SessionPanel({ desktop = false }: { desktop?: boolean }): React.ReactElement | null {
  const user = useSyncStatus((s) => s.user);
  const state = useSyncStatus((s) => s.state);
  const [showPassword, setShowPassword] = useState(false);
  const [leaving, setLeaving] = useState(false);
  if (!user) return null;

  const status = STATUS[state];
  const itemClass = desktop
    ? "nav-item w-full text-left focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
    : "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none min-h-[48px]";

  return (
    <section
      aria-label="Sessão"
      data-testid="session-panel"
      className={desktop ? "mb-4 pb-4 border-b border-[var(--color-border)]" : "pt-3 mt-2 border-t border-[var(--color-border)]"}
    >
      <div className={`flex items-center gap-3 ${desktop ? "px-3" : "px-4"} py-2`}>
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] text-sm font-bold text-[var(--color-text-inverse)]"
        >
          {initials(user.displayName)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{user.displayName}</p>
          <p className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]" role="status">
            <status.Icon className={`h-3.5 w-3.5 shrink-0 ${status.className}`} aria-hidden="true" />
            <span className="truncate">{status.label}</span>
          </p>
        </div>
      </div>
      <ul className="space-y-1">
        <li>
          <button
            type="button"
            className={itemClass}
            aria-expanded={showPassword}
            onClick={() => setShowPassword((v) => !v)}
          >
            <KeyRound className="w-[18px] h-[18px] shrink-0" aria-hidden="true" />
            <span>Alterar senha</span>
          </button>
          {showPassword && <PasswordForm onDone={() => setShowPassword(false)} />}
        </li>
        <li>
          <button
            type="button"
            className={itemClass}
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              void logout();
            }}
          >
            <LogOut className="w-[18px] h-[18px] shrink-0" aria-hidden="true" />
            <span>{leaving ? "Saindo…" : "Sair"}</span>
          </button>
        </li>
      </ul>
    </section>
  );
}
