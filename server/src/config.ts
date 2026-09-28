import path from "node:path";

export interface Config {
  port: number;
  host: string;
  /** Diretório do SQLite (volume Docker em produção). */
  dataDir: string;
  /** Build web do open3dcalc (dist-web). Vazio = não serve estáticos. */
  staticDir: string | null;
  /** Origem pública, ex.: https://calc.modelink3d.link — usada na checagem de CSRF. */
  publicOrigin: string | null;
  cookieSecure: boolean;
  sessionDays: number;
  /** Número de proxies na frente (Cloudflare + Traefik = 2). */
  trustProxyHops: number;
  /** Tentativas de login por minuto por IP. */
  loginRatePerMinute: number;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env.PORT, 8080),
    host: env.HOST ?? "0.0.0.0",
    dataDir: path.resolve(env.CALC_DATA_DIR ?? "./data"),
    staticDir: env.CALC_STATIC_DIR ? path.resolve(env.CALC_STATIC_DIR) : null,
    publicOrigin: env.CALC_PUBLIC_ORIGIN?.replace(/\/+$/, "") || null,
    cookieSecure: env.CALC_COOKIE_SECURE !== "false",
    sessionDays: int(env.CALC_SESSION_DAYS, 30),
    trustProxyHops: int(env.CALC_TRUST_PROXY_HOPS, 2),
    loginRatePerMinute: int(env.CALC_LOGIN_RATE_PER_MINUTE, 10),
  };
}
