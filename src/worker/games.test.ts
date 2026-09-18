import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { games } from "../db/schema";
import { ensureDealTables, getDealRefreshStatus, getGameDeals } from "../services/game-deals";
import { refreshGameDeals, type DealSource } from "../services/deal-refresh";
import type { DealOffer } from "../services/deal-types";
import { listGames, parseGameQuery } from "./games";

const start = 1_800_000_000;
let now = start;
let client: Client;
const gid = (id: number) => `00000000-0000-0000-0000-${String(id).padStart(12, "0")}`;
const offer = (kind: "retail" | "bundle", validUntil = start + 86400): DealOffer => ({
  kind, id: `${kind}:1`, title: kind === "retail" ? "Store" : "Bundle", store: "Store",
  url: "https://itad.link/example/?affiliate=unchanged", priceCents: 500, currency: "USD",
  discountPercent: kind === "retail" ? 50 : null, drm: [], voucher: null, note: null,
  expiresAt: null, validUntil,
});
function source(overrides: Partial<DealSource> = {}): DealSource {
  return {
    lookup: async (ids) => new Map(ids.map((id) => [id, gid(id)])),
    prices: async (ids) => new Map(ids.map((id) => [id, id === gid(2) ? [offer("retail")] : []])),
    bundles: async () => ({ fetchedAt: now, games: new Map([[gid(3), [offer("bundle")]]]) }),
    ...overrides,
  };
}
const query = (params = "") => parseGameQuery(new URL(`https://example.test/api/games?${params}`));
const run = (provider = source()) => refreshGameDeals(client, provider, { now: () => now });

beforeEach(async () => {
  now = start;
  client = createClient({ url: "file::memory:" });
  // Use the application's actual Drizzle columns; fixtures don't maintain a second schema.
  const columns = getTableConfig(games).columns.map((column) => {
    const fallback = typeof column.default === "boolean" ? Number(column.default) : typeof column.default === "number" ? column.default : null;
    return `"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}${fallback !== null ? ` DEFAULT ${fallback}` : ""}`;
  });
  await client.execute(`CREATE TABLE games (${columns.join(",")})`);
  await ensureDealTables(client);
  await client.batch([1, 2, 3, 4].map((id) => ({
    sql: "INSERT INTO games (id, steam_app_id, name, value_score, steam_review_score, steam_review_count) VALUES (?, ?, ?, ?, 90, 100)",
    args: [id, id, `Game ${id}`, 1000 - id * 100],
  })), "write");
});
afterEach(() => client.close());

describe("rankings with ITAD offers", () => {
  test("filters before pagination, includes bundles, and leaves unfiltered order unchanged", async () => {
    expect((await listGames(client, query(), now))[0]?.deals.status).toBe("unknown");
    await run();
    expect((await listGames(client, query(), now)).map((g) => g.id)).toEqual([1, 2, 3, 4]);
    expect((await listGames(client, query("onSale=true&limit=1"), now)).map((g) => g.id)).toEqual([2]);
    const next = await listGames(client, query("onSale=true&limit=1&offset=1"), now);
    expect(next.map((g) => g.id)).toEqual([3]);
    expect(next[0]?.deals.offers[0]?.kind).toBe("bundle");
    expect((await listGames(client, query("onSale=true&offset=2"), now))).toEqual([]);
    expect((await getGameDeals(client, [1], now)).get(1)).toMatchObject({ status: "fresh", offers: [] });
    expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastSuccessAt: start, isRunning: false, totalGames: 4, freshGames: 4 });
  });

  test("combines existing filters without duplicates for multiple offers", async () => {
    await client.execute("UPDATE games SET is_ignored=1, playtime_minutes=20, is_early_access=1, is_mmo=1 WHERE id=2");
    await client.execute("UPDATE games SET has_single_player=1, has_multiplayer=0, has_online_co_op=1, controller_support='full' WHERE id=3");
    await run(source({ prices: async (ids) => new Map(ids.map((id) => [id, [offer("retail"), { ...offer("retail"), id: "retail:2" }]])) }));
    const rows = await listGames(client, query("onSale=true&hideIgnored=true&hidePlayed=true&hideEa=true&hideMMO=true&singleOnly=true&coop=online-coop&controller=full"), now);
    expect(rows.map((g) => g.id)).toEqual([3]);
    expect(rows[0]?.deals.offers).toHaveLength(3);
  });

  test("expires at exactly 24 hours and honors earlier provider expiry", async () => {
    await run(source({ prices: async (ids) => new Map(ids.map((id) => [id, id === gid(2) ? [offer("retail", start + 60)] : []])) }));
    expect((await listGames(client, query("onSale=true"), start + 59)).map((g) => g.id)).toEqual([2, 3]);
    expect((await listGames(client, query("onSale=true"), start + 60)).map((g) => g.id)).toEqual([3]);
    expect((await listGames(client, query("onSale=true"), start + 86399)).map((g) => g.id)).toEqual([3]);
    expect(await listGames(client, query("onSale=true"), start + 86400)).toEqual([]);
    expect((await getGameDeals(client, [3], start + 86400)).get(3)?.status).toBe("stale");
  });

  test("does not turn missing or failed responses into fresh retail data", async () => {
    await run();
    now = start + 86400;
    const result = await run(source({ prices: async () => new Map() }));
    expect(result.missingPrices).toBe(4);
    expect((await getGameDeals(client, [2], now)).get(2)).toMatchObject({ status: "partial", offers: [] });
    const failure = source({ bundles: async () => { throw new Error("ITAD unavailable"); } });
    now += 10;
    await expect(run(failure)).rejects.toThrow("ITAD unavailable");
    expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastError: "ITAD unavailable", isRunning: false, lastSuccessAt: start + 86400 });
    expect((await getGameDeals(client, [2], now)).get(2)?.checkedAt).toBe(start);
  });

  test("successful empty offers remove disappeared sales; unknown mappings are distinct", async () => {
    await run();
    now++;
    await run(source({ prices: async (ids) => new Map(ids.map((id) => [id, []])), bundles: async () => ({ fetchedAt: now, games: new Map() }) }));
    expect(await listGames(client, query("onSale=true"), now)).toEqual([]);
    now += 7 * 86400;
    await run(source({ lookup: async (ids) => new Map(ids.map((id) => [id, null])) }));
    expect((await getGameDeals(client, [2], now)).get(2)).toMatchObject({ status: "unmapped", offers: [] });
  });

  test("batches large rankings and reuses mappings until their seven-day expiry", async () => {
    await client.batch(Array.from({ length: 205 }, (_, i) => ({
      sql: "INSERT INTO games (id, steam_app_id, name, value_score) VALUES (?, ?, ?, 10)",
      args: [i + 10, i + 10, `Extra ${i}`],
    })), "write");
    const sizes: number[] = [];
    const provider = source({ lookup: async (ids) => { sizes.push(ids.length); return new Map(ids.map((id) => [id, gid(id)])); } });
    expect(await run(provider)).toMatchObject({ gamesChecked: 209 });
    expect(sizes).toEqual([200, 9]);
    now += 3600;
    await run(provider);
    expect(sizes).toEqual([200, 9]);
    now += 7 * 86400;
    await run(provider);
    expect(sizes).toEqual([200, 9, 200, 9]);
  });

  test("a failed retail request keeps previously verified offers within their original lifetime", async () => {
    await run();
    now += 3600;
    await expect(run(source({ prices: async () => { throw new Error("ITAD unavailable"); } }))).rejects.toThrow("ITAD unavailable");
    expect((await getGameDeals(client, [2], now)).get(2)).toMatchObject({ checkedAt: start, status: "fresh" });
    expect((await listGames(client, query("onSale=true"), now)).map((g) => g.id)).toEqual([2, 3]);
    expect(await listGames(client, query("onSale=true"), start + 86400)).toEqual([]);
  });

  test("prevents overlapping refreshes and recovers an abandoned lease", async () => {
    let release!: () => void;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = run(source({ bundles: async () => { ready(); await blocked; return { fetchedAt: now, games: new Map() }; } }));
    await started;
    expect(await getDealRefreshStatus(client, now)).toMatchObject({ isRunning: true });
    expect(await run()).toMatchObject({ skipped: true });
    now += 901;
    await run();
    release();
    await expect(first).rejects.toThrow("lease expired");
    expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastError: null, isRunning: false, gamesChecked: 4 });
  });
});
