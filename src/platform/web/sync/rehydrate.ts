/**
 * Recarrega um store a partir do localStorage quando o sync trouxe dados
 * novos do servidor. Importado só DEPOIS do boot do sync (importa stores).
 *
 * Chaves sem entrada aqui (preferências, dashboard) são gravadas no
 * localStorage e passam a valer na próxima abertura do app.
 */
import { useCatalogStore } from "@/shared/stores/catalogStore";
import { useColorPalette, loadColors } from "@/shared/stores/colorPalette";
import { useCustomerStore } from "@/shared/stores/customerStore";
import { useHistoryStore } from "@/shared/stores/historyStore";
import { useProductInventory } from "@/shared/stores/productInventory";
import { useQuoteStore } from "@/shared/stores/quoteStore";
import { loadSpools, useSpoolStore } from "@/shared/stores/spoolStore";
import type { Rehydrator } from "./engine";
import type { SyncedKey } from "./keys";

const REHYDRATORS: Partial<Record<SyncedKey, () => unknown>> = {
  open3dcalc_customers_v1: () => useCustomerStore.persist.rehydrate(),
  open3dcalc_quotes_v1: () => useQuoteStore.persist.rehydrate(),
  open3dcalc_history_v2: () => useHistoryStore.persist.rehydrate(),
  open3dcalc_products: () => useProductInventory.persist.rehydrate(),
  open3dcalc_catalog_v1: () => useCatalogStore.getState().load(),
  open3dcalc_filaments: () => useSpoolStore.setState({ spools: loadSpools() }),
  open3dcalc_color_palette_v1: () => useColorPalette.setState({ colors: loadColors() }),
};

export const rehydrateKey: Rehydrator = (key) => {
  const run = REHYDRATORS[key];
  if (!run) return false;
  try {
    void run();
    return true;
  } catch (error) {
    console.warn(`[sync] falha ao recarregar "${key}":`, error);
    return false;
  }
};
