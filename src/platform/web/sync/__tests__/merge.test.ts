import { describe, expect, it } from "vitest";
import { merge3, mergeRaw } from "../merge";

const q = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, ...extra });

describe("merge3", () => {
  it("keeps whichever side changed", () => {
    expect(merge3(1, 1, 2)).toBe(2);
    expect(merge3(1, 3, 1)).toBe(3);
  });

  it("local wins a true primitive conflict", () => {
    expect(merge3("a", "local", "remote")).toBe("local");
  });

  it("merges object fields changed on different sides", () => {
    const base = { a: 1, b: 1, c: 1 };
    expect(merge3(base, { ...base, a: 2 }, { ...base, b: 3 })).toEqual({ a: 2, b: 3, c: 1 });
  });

  it("drops a field deleted on one side and untouched on the other", () => {
    expect(merge3({ a: 1, b: 1 }, { a: 1 }, { a: 1, b: 1, c: 5 })).toEqual({ a: 1, c: 5 });
  });

  it("unions additions to id lists from both sides", () => {
    const base = [q("1")];
    const merged = merge3(base, [q("1"), q("L")], [q("1"), q("R")]) as { id: string }[];
    expect(merged.map((x) => x.id)).toEqual(["1", "R", "L"]);
  });

  it("honours deletions from either side", () => {
    const base = [q("1"), q("2"), q("3")];
    const local = [q("1"), q("3")]; // deleted 2 here
    const remote = [q("1"), q("2")]; // deleted 3 there
    expect((merge3(base, local, remote) as { id: string }[]).map((x) => x.id)).toEqual(["1"]);
  });

  it("keeps an item edited remotely even if deleted locally", () => {
    const base = [q("1")];
    const merged = merge3(base, [], [q("1", { name: "editado" })]);
    expect(merged).toEqual([q("1", { name: "editado" })]);
  });

  it("merges the same item edited on both sides field by field", () => {
    const base = [q("1", { price: 10, qty: 1 })];
    const merged = merge3(base, [q("1", { price: 12, qty: 1 })], [q("1", { price: 10, qty: 5 })]);
    expect(merged).toEqual([q("1", { price: 12, qty: 5 })]);
  });

  it("adds both increments of next* counters", () => {
    const base = { quotes: [], nextNumber: 5 };
    const local = { quotes: [q("a")], nextNumber: 6 };
    const remote = { quotes: [q("b")], nextNumber: 6 };
    expect(merge3(base, local, remote)).toEqual({ quotes: [q("b"), q("a")], nextNumber: 7 });
  });

  it("with no base (first sync of an old browser) unions both datasets", () => {
    const merged = merge3(undefined, { state: { customers: [q("x")] } }, { state: { customers: [q("y")] } });
    expect(merged).toEqual({ state: { customers: [q("y"), q("x")] } });
  });
});

describe("mergeRaw", () => {
  it("works on zustand persist payloads", () => {
    const wrap = (quotes: unknown[]) => JSON.stringify({ state: { quotes }, version: 0 });
    const out = mergeRaw(wrap([q("1")]), wrap([q("1"), q("L")]), wrap([q("1"), q("R")]));
    expect(JSON.parse(out!).state.quotes.map((x: { id: string }) => x.id)).toEqual(["1", "R", "L"]);
  });

  it("treats null as deleted", () => {
    expect(mergeRaw('"a"', null, '"a"')).toBeNull();
    expect(mergeRaw('"a"', null, '"b"')).toBe('"b"');
  });

  it("falls back to local on invalid JSON", () => {
    expect(mergeRaw("{", '{"a":1}', '{"a":2}')).toBe('{"a":1}');
  });
});
