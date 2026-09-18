import { describe, expect, test } from "bun:test";
import { ItadClient } from "./itad-client";

const now = 1_800_000_000;
const id = "018d937f-21e1-728e-86d7-9acb3c59f2bb";
const url = "https://itad.link/product/?affiliate=keep-me&app=example";
const deal = (overrides: Record<string, unknown> = {}) => ({
  shop: { id: 6, name: "Fanatical" }, price: { amount: 5, amountInt: 500, currency: "USD" },
  regular: { amount: 10, amountInt: 1000, currency: "USD" }, cut: 50,
  voucher: "SAVE", drm: [{ id: 61, name: "Steam" }], expiry: null, url, ...overrides,
});
const bundle = (overrides: Record<string, unknown> = {}) => ({
  id: 100, title: "Story Bundle", page: { id: 8, name: "Fanatical", shopId: 6 }, url,
  publish: new Date((now - 1000) * 1000).toISOString(), expiry: null, note: "See store terms",
  tiers: [{ price: { amount: 12, amountInt: 1200, currency: "USD" }, addon: false, games: [{ id }] }],
  ...overrides,
});
function fakeClient(body: unknown) {
  return new ItadClient("test-not-a-secret", { now: () => now, sleep: async () => {},
    fetch: async () => Response.json(body) });
}

describe("ITAD contracts", () => {
  test("maps exact Steam app IDs and rejects incomplete mappings", async () => {
    expect(await fakeClient({ "app/620": id, "app/570": null }).lookup([620, 570])).toEqual(new Map([[620, id], [570, null]]));
    await expect(fakeClient({ "app/620": id }).lookup([620, 570])).rejects.toThrow("Incomplete");
  });

  test("keeps original offer URLs, voucher and DRM with a 24-hour validity", async () => {
    const offers = await fakeClient([{ id, deals: [deal()] }]).prices([id], "US");
    expect(offers.get(id)?.[0]).toMatchObject({ store: "Fanatical", priceCents: 500,
      discountPercent: 50, voucher: "SAVE", drm: ["Steam"], url, validUntil: now + 86400 });
  });

  test("keeps temporary 100% discounts but excludes regular/free/foreign/expired prices", async () => {
    const offers = await fakeClient([{ id, deals: [
      deal({ cut: 100, price: { amountInt: 0, currency: "USD" } }),
      deal({ cut: 0 }),
      deal({ cut: 0, price: { amountInt: 0, currency: "USD" }, regular: { amountInt: 0, currency: "USD" } }),
      deal({ price: { amountInt: 400, currency: "EUR" } }),
      deal({ expiry: new Date(now * 1000).toISOString() }),
    ] }]).prices([id], "US");
    expect(offers.get(id)).toHaveLength(1);
    expect(offers.get(id)?.[0]?.priceCents).toBe(0);
  });

  test("honors earlier expiry and rejects unsafe URLs or malformed responses", async () => {
    const offers = await fakeClient([{ id, deals: [deal({ expiry: new Date((now + 60) * 1000).toISOString() })] }]).prices([id], "US");
    expect(offers.get(id)?.[0]?.validUntil).toBe(now + 60);
    for (const invalid of [deal({ url: "javascript:alert(1)" }), deal({ expiry: "not-a-date" }), deal({ price: null })]) {
      await expect(fakeClient([{ id, deals: [invalid] }]).prices([id], "US")).rejects.toThrow();
    }
    expect((await fakeClient([]).prices([id], "US")).has(id)).toBe(false);
  });

  test("keeps only matching bundle tier totals, with null/add-on/choice prices link-only", async () => {
    const feed = await fakeClient([
      bundle(),
      bundle({ id: 101, title: "Build Your Own Bundle" }),
      bundle({ id: 102, tiers: [{ price: null, addon: false, games: [{ id }] }] }),
      bundle({ id: 103, tiers: [{ price: { amountInt: 200, currency: "USD" }, addon: true, games: [{ id }] }] }),
      bundle({ id: 104, expiry: new Date((now - 1) * 1000).toISOString() }),
      bundle({ id: 105, tiers: [{ price: { amountInt: 100, currency: "EUR" }, addon: false, games: [{ id }] }] }),
    ]).bundles("US");
    const offers = feed.games.get(id)!;
    expect(offers).toHaveLength(4);
    expect(offers.map((offer) => offer.priceCents)).toEqual([1200, null, null, null]);
    expect(offers[0]).toMatchObject({ kind: "bundle", discountPercent: null, drm: [], url });
    expect(offers[3]?.note).toContain("prerequisite");
  });

  test("sends keys only in headers, honors Retry-After, and never logs secrets in errors", async () => {
    const waits: number[] = [];
    let calls = 0;
    const client = new ItadClient("fixture-private-key", {
      now: () => now, sleep: async (ms) => { waits.push(ms); },
      fetch: async (request, init) => {
        expect(String(request)).not.toContain("fixture-private-key");
        expect(new Headers(init?.headers).get("ITAD-API-Key")).toBe("fixture-private-key");
        expect(String(request)).toContain("deals=false");
        calls++;
        return calls === 1 ? new Response("rate limited", { status: 429, headers: { "Retry-After": "3" } }) : Response.json([{ id, deals: [] }]);
      },
    });
    expect((await client.prices([id], "US")).get(id)).toEqual([]);
    expect(waits).toContain(3000);
    const rejected = new ItadClient("fixture-private-key", { sleep: async () => {}, fetch: async () => new Response("fixture-private-key", { status: 401 }) });
    await expect(rejected.prices([id], "US")).rejects.toThrow("ITAD request failed (HTTP 401)");
  });

  test("does not truncate a long Retry-After or publish a partial bundle feed", async () => {
    const client = new ItadClient("test", { sleep: async () => {}, fetch: async () => new Response(null, { status: 429, headers: { "Retry-After": "600" } }) });
    await expect(client.bundles("US")).rejects.toThrow("long retry delay");
    let calls = 0;
    const paged = new ItadClient("test", { now: () => now, sleep: async () => {}, retries: 0, fetch: async () => {
      calls++;
      return calls === 1 ? Response.json(Array.from({ length: 50 }, (_, i) => bundle({ id: i }))) : new Response(null, { status: 503 });
    } });
    await expect(paged.bundles("US")).rejects.toThrow("HTTP 503");
  });
});
