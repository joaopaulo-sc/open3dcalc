/**
 * Chaves do localStorage sincronizadas com o servidor (fork ModelInk3D).
 * Espelha `server/src/kv.ts` (KEY_SCOPES) — manter as duas listas iguais.
 *
 * shared = dados da farm, iguais para todos; user = preferências pessoais.
 * `open3dcalc_settings_v2` é o rascunho do cálculo em andamento (produto,
 * quantidade, aba), por isso é por usuário.
 */
export const KEY_SCOPES = {
  open3dcalc_history_v2: "shared",
  open3dcalc_customers_v1: "shared",
  open3dcalc_quotes_v1: "shared",
  open3dcalc_catalog_v1: "shared",
  open3dcalc_filaments: "shared",
  open3dcalc_color_palette_v1: "shared",
  open3dcalc_products: "shared",
  open3dcalc_dashboard_v1: "shared",
  open3dcalc_dashboard_goal: "shared",
  open3dcalc_settings_v2: "user",
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

export const SYNCED_KEYS = Object.keys(KEY_SCOPES) as SyncedKey[];

export function isSyncedKey(key: string): key is SyncedKey {
  return Object.hasOwn(KEY_SCOPES, key);
}

/** Id do último usuário que sincronizou neste navegador (fora do manifesto). */
export const SYNC_USER_KEY = "calc_sync_user";
