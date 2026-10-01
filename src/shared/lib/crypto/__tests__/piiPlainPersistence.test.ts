/**
 * Fork ModelInk3D — server mode keeps the three PII stores on `manifestStorage`.
 *
 * Behind the multi-user server every `manifestStorage` write is synced across
 * devices, so `enablePlainPiiPersistence` routes customers/quotes/history back
 * to it instead of the per-browser vault. These specs pin that the stores
 * hydrate from and write to `localStorage`, that the hydration gate still
 * refuses a write before hydration (no initial-state clobber), and that the
 * live data is not reported as legacy plaintext residue.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useCustomerStore } from "@/shared/stores/customerStore";
import "@/shared/stores/quoteStore";
import "@/shared/stores/historyStore";

import {
  PII_STORE_KEY,
  enablePlainPiiPersistence,
  getPiiStoreAccessState,
  getPiiSurfaceWriteBlockReason,
  isPlainPiiPersistence,
  rehydratePiiStores,
  resetPiiStoreHydrationForTests,
  whenPiiWritesSettled,
} from "@/shared/lib/crypto/piiStoreHydration";
import { manifestStorage } from "@/shared/lib/manifestStorage";
import { detectLegacyPlaintextPii } from "@/shared/lib/legacyPiiPlaintext";

const KEY = PII_STORE_KEY.customers;

function seedCustomers(names: string[]): void {
  const now = 1_700_000_000_000;
  const customers = names.map((name, i) => ({
    id: `c${i}`,
    name,
    createdAt: now,
    updatedAt: now,
    quoteCount: 0,
  }));
  localStorage.setItem(KEY, JSON.stringify({ state: { customers }, version: 1 }));
}

const form = (name: string) => ({
  name,
  company: "",
  email: "",
  phone: "",
  address: "",
  notes: "",
});

function storedNames(): string[] {
  const raw = localStorage.getItem(KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { state: { customers: { name: string }[] } };
  return parsed.state.customers.map((c) => c.name);
}

describe("plain PII persistence (server mode)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetPiiStoreHydrationForTests();
    useCustomerStore.setState({ customers: [] });
  });

  afterEach(() => {
    resetPiiStoreHydrationForTests();
    localStorage.clear();
  });

  it("is off by default", () => {
    expect(isPlainPiiPersistence()).toBe(false);
  });

  it("hydrates all three stores from localStorage", async () => {
    enablePlainPiiPersistence(manifestStorage);
    seedCustomers(["Cliente Sintético A"]);

    const outcomes = await rehydratePiiStores();

    expect(outcomes.map((o) => o.status)).toEqual(["hydrated", "hydrated", "hydrated"]);
    expect(getPiiStoreAccessState()).toEqual({ status: "hydrated" });
    expect(getPiiSurfaceWriteBlockReason(KEY)).toBeNull();
    expect(useCustomerStore.getState().customers.map((c) => c.name)).toEqual([
      "Cliente Sintético A",
    ]);
  });

  it("writes store changes back to localStorage", async () => {
    enablePlainPiiPersistence(manifestStorage);
    seedCustomers(["Cliente Sintético A"]);
    await rehydratePiiStores();

    useCustomerStore.getState().addCustomer(form("Cliente Sintético B"));
    await whenPiiWritesSettled();

    expect(storedNames()).toEqual(["Cliente Sintético A", "Cliente Sintético B"]);
  });

  it("refuses a write before hydration instead of clobbering the record", async () => {
    enablePlainPiiPersistence(manifestStorage);
    seedCustomers(["Cliente Sintético A"]);

    useCustomerStore.getState().addCustomer(form("Antes da hidratação"));
    await whenPiiWritesSettled().catch(() => undefined);

    expect(storedNames()).toEqual(["Cliente Sintético A"]);
  });

  it("does not report the live keys as legacy plaintext residue", () => {
    seedCustomers(["Cliente Sintético A"]);
    expect(detectLegacyPlaintextPii().present).toBe(true);

    enablePlainPiiPersistence(manifestStorage);
    expect(detectLegacyPlaintextPii().present).toBe(false);
  });
});
