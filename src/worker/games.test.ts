import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDealRefreshStatus, getGameDeals } from "../services/game-deals";
import { refreshGameDeals, type DealSource } from "../services/deal-refresh";
import { ItadError } from "../services/itad-errors";
import type { DealOffer } from "../services/deal-types";
import { listGames, parseGameQuery, type CityBuilderGameDto, type GameDto } from "./games";
import { createHttpClient } from "../db/http";
import { createD1WorkerTestHarness, type D1WorkerTestHarness } from "../db/testing";
import type { DbClient, DbStatement } from "../db/access";

const start = 1_800_000_000;
let now = start;
let client: DbClient;
let offerHarness: D1WorkerTestHarness;
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

describe("rankings with ITAD offers", () => {
  beforeEach(async () => {
    now = start;
    offerHarness = await createD1WorkerTestHarness();
    client = createHttpClient(offerHarness.clientConfig);
    await client.batch([1, 2, 3, 4].map((id) => ({
      sql: "INSERT INTO games (id, steam_app_id, name, value_score, steam_review_score, steam_review_count) VALUES (?, ?, ?, ?, 90, 100)",
      args: [id, id, `Game ${id}`, 1000 - id * 100],
    })), "write");
  });
  afterEach(async () => { await offerHarness?.dispose(); });

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
    const failure = source({ bundles: async () => { throw new ItadError("UNAVAILABLE"); } });
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
    await expect(run(source({ prices: async () => { throw new ItadError("UNAVAILABLE"); } }))).rejects.toThrow("ITAD unavailable");
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

describe("native D1 viewer requests", () => {
  let harness: D1WorkerTestHarness;
  let client: DbClient;
  beforeEach(async () => {
    harness = await createD1WorkerTestHarness();
    client = createHttpClient(harness.clientConfig);
  });
  afterEach(async () => { await harness?.dispose(); });

  async function browse(params = ""): Promise<GameDto[]> {
    const response = await harness.fetch(`https://d1-test.invalid/api/games?${params}`);
    expect(response.status).toBe(200);
    return response.json();
  }

  async function seed(statements: DbStatement[]) {
    for (let offset = 0; offset < statements.length; offset += 400) {
      await client.batch(statements.slice(offset, offset + 400));
    }
  }

  test.each([100, 500])("returns a populated %i-game page with every game's offers in ranking order", async (size) => {
    expect(await browse(`limit=${size}`)).toEqual([]);
    const checkedAt = Math.floor(Date.now() / 1000);
    const appIds = Array.from({ length: size + 2 }, (_, i) => 5000 + i);
    await seed(appIds.toReversed().flatMap((appId) => [
      { sql: "INSERT INTO games (steam_app_id, name, value_score) VALUES (?, ?, ?)", args: [appId, `Ranked ${appId}`, 10000 - appId] },
      { sql: "INSERT INTO itad_game_map (steam_app_id, itad_id, checked_at) VALUES (?, ?, ?)", args: [appId, gid(appId), checkedAt] },
      { sql: "INSERT INTO game_deal_cache VALUES (?, 'US', 'retail', ?, ?)", args: [appId, checkedAt, JSON.stringify([{ ...offer("retail", checkedAt + 86400), id: `retail:${appId}` }])] },
      { sql: "INSERT INTO game_deal_cache VALUES (?, 'US', 'bundle', ?, ?)", args: [appId, checkedAt, JSON.stringify([{ ...offer("bundle", checkedAt + 86400), id: `bundle:${appId}` }])] },
    ]));
    const rows = await browse(`limit=${size}`);
    expect(rows.map((game) => game.steamAppId)).toEqual(appIds.slice(0, size));
    expect(rows.map((game) => game.deals)).toEqual(appIds.slice(0, size).map((appId) => ({
      status: "fresh", checkedAt, offers: [
        { ...offer("retail", checkedAt + 86400), id: `retail:${appId}` },
        { ...offer("bundle", checkedAt + 86400), id: `bundle:${appId}` },
      ],
    })));
    expect((await browse(`limit=${size}&offset=1`)).map((game) => game.steamAppId)).toEqual(appIds.slice(1, size + 1));
  });

  test("applies combined account, mode, controller and on-sale filters before pagination", async () => {
    const checkedAt = Math.floor(Date.now() / 1000);
    await seed(Array.from({ length: 13 }, (_, i) => ({
      sql: `INSERT INTO games (id, steam_app_id, name, value_score, has_single_player,
        has_online_co_op, has_local_co_op, controller_support) VALUES (?, ?, ?, ?, 1, 1, 1, 'full')`,
      args: [i + 1, i + 1, `Filtered ${i + 1}`, 1000 - i * 10],
    })));
    await client.batch([
      "UPDATE games SET is_early_access=1 WHERE id=1",
      "UPDATE games SET playtime_minutes=20 WHERE id=2",
      "UPDATE games SET is_mmo=1 WHERE id=3",
      "UPDATE games SET is_ignored=1 WHERE id=4",
      "UPDATE games SET has_single_player=0 WHERE id=5",
      "UPDATE games SET has_multiplayer=1 WHERE id=6",
      "UPDATE games SET has_online_co_op=0 WHERE id=7",
      "UPDATE games SET controller_support='partial' WHERE id=8",
      "UPDATE games SET value_score=NULL WHERE id=12",
      "UPDATE games SET is_endless=1 WHERE id=13",
    ]);
    await seed(Array.from({ length: 13 }, (_, i) => ({
      sql: "INSERT INTO game_deal_cache VALUES (?, ?, ?, ?, ?)",
      args: [i + 1, i === 8 ? "CA" : "US", i === 10 ? "bundle" : "retail", checkedAt,
        JSON.stringify(i === 9 ? [offer("retail", checkedAt + 3600), { ...offer("retail", checkedAt + 3600), id: "retail:2" }] : [offer(i === 10 ? "bundle" : "retail", checkedAt + 3600)])],
    })));
    const combined = "onSale=true&hideIgnored=true&hidePlayed=true&hideEa=true&hideMMO=true&singleOnly=true";
    expect((await browse(`${combined}&coop=online-coop&controller=full`)).map((game) => game.id)).toEqual([10, 11]);
    const page = await browse(`${combined}&coop=online-coop&controller=full&limit=1&offset=1`);
    expect(page.map((game) => game.id)).toEqual([11]);
    expect(page[0]?.deals.offers[0]?.kind).toBe("bundle");
    expect((await browse(`${combined}&coop=local-coop&controller=partial`)).map((game) => game.id)).toEqual([7, 8, 10, 11]);
    expect((await browse(`${combined}&coop=has-coop&controller=partial`)).map((game) => game.id)).toEqual([7, 8, 10, 11]);
    expect(await browse(`${combined}&coop=online-coop&controller=full&offset=2`)).toEqual([]);
    expect((await browse()).map((game) => game.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test("keeps US offer selection, expiry, empty, unmapped and missing scopes distinct", async () => {
    const checkedAt = Math.floor(Date.now() / 1000);
    const cheap = { ...offer("retail", checkedAt + 3600), id: "retail:a", voucher: "SAVE α", drm: ["Steam"], note: "Existing note", expiresAt: checkedAt + 3600 };
    const tied = { ...cheap, id: "retail:b" };
    const expensive = { ...cheap, id: "retail:z", priceCents: 900 };
    const bundle = { ...offer("bundle", checkedAt + 3600), priceCents: 100 };
    const expired = offer("retail", checkedAt - 60);
    const cache = (appId: number, country: string, kind: string, time: number, offers: DealOffer[]): DbStatement => ({
      sql: "INSERT INTO game_deal_cache VALUES (?, ?, ?, ?, ?)", args: [appId, country, kind, time, JSON.stringify(offers)],
    });
    await seed([
      ...Array.from({ length: 6 }, (_, i) => ({ sql: "INSERT INTO games (steam_app_id, name, value_score) VALUES (?, ?, ?)", args: [i + 1, `Offer ${i + 1}`, 100 - i] })),
      { sql: "INSERT INTO itad_game_map VALUES (3, NULL, ?)", args: [checkedAt] },
      cache(1, "US", "retail", checkedAt, [expensive, tied, expired, cheap]),
      cache(1, "US", "bundle", checkedAt, [bundle, { ...bundle, id: "bundle:expired", validUntil: checkedAt - 60 }]),
      cache(1, "CA", "retail", checkedAt, [{ ...cheap, id: "foreign:1" }]),
      cache(2, "US", "retail", checkedAt - 86460, [cheap]),
      cache(2, "US", "bundle", checkedAt, []),
      cache(4, "CA", "retail", checkedAt, [cheap]),
      cache(4, "CA", "bundle", checkedAt, [bundle]),
      cache(5, "US", "retail", checkedAt - 86460, [cheap]),
      cache(5, "CA", "retail", checkedAt, [cheap]),
      cache(6, "US", "retail", checkedAt, []),
      cache(6, "US", "bundle", checkedAt, []),
    ]);
    const rows = await browse();
    expect(rows.map((game) => game.deals)).toEqual([
      { status: "fresh", checkedAt, offers: [cheap, tied, expensive, bundle] },
      { status: "partial", checkedAt: checkedAt - 86460, offers: [] },
      { status: "unmapped", checkedAt, offers: [] },
      { status: "unknown", checkedAt: null, offers: [] },
      { status: "stale", checkedAt: checkedAt - 86460, offers: [] },
      { status: "fresh", checkedAt, offers: [] },
    ]);
    expect((await browse("onSale=true")).map((game) => game.steamAppId)).toEqual([1]);
    expect(await browse("country=CA")).toEqual(rows);
    const response = await harness.fetch("https://d1-test.invalid/api/deal-state");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      country: "US", currency: "USD", maxAgeSeconds: 86400, lastAttemptAt: null, lastSuccessAt: null,
      lastError: null, isRunning: false, gamesChecked: 0, totalGames: 6, freshGames: 2,
    });
  });

  test("preserves human Steam Status and deal-state DTOs without machine credentials", async () => {
    const read = async (path: string) => {
      const response = await harness.fetch(`https://d1-test.invalid${path}`);
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await read("/api/health")).toEqual({ ok: true });
    expect(await read("/api/sync-state")).toBeNull();
    expect(await read("/api/deal-state")).toEqual({
      country: "US", currency: "USD", maxAgeSeconds: 86400, lastAttemptAt: null, lastSuccessAt: null,
      lastError: null, isRunning: false, gamesChecked: 0, totalGames: 0, freshGames: 0,
    });
    const checkedAt = Math.floor(Date.now() / 1000);
    await client.batch([
      { sql: `INSERT INTO sync_state (key, last_attempt_at, last_success_at, last_error, is_running,
          lock_expires_at, ignored_count, wishlist_count, owned_count, games_updated, games_removed, updated_at)
          VALUES ('steam_status', ?, ?, 'Existing Steam Status error', 1, ?, 14, 27, 120, 8, 0, ?)`,
        args: [checkedAt, checkedAt - 3600, checkedAt + 600, checkedAt] },
      "INSERT INTO sync_state (key, last_error) VALUES ('another_key', 'Not this state')",
      { sql: `INSERT INTO deal_refresh_state VALUES ('US', ?, ?, 'Existing offer error', 'synthetic-lease', ?, 9)`,
        args: [checkedAt, checkedAt - 3600, checkedAt + 600] },
      "INSERT INTO deal_refresh_state (country, last_error, games_checked) VALUES ('CA', 'Not this country', 99)",
    ]);
    expect(await read("/api/sync-state")).toEqual({
      key: "steam_status", lastAttemptAt: checkedAt, lastSuccessAt: checkedAt - 3600,
      lastError: "Existing Steam Status error", isRunning: true, lockExpiresAt: checkedAt + 600,
      ignoredCount: 14, wishlistCount: 27, ownedCount: 120, gamesUpdated: 8, gamesRemoved: 0, updatedAt: checkedAt,
    });
    expect(await read("/api/deal-state")).toEqual({
      country: "US", currency: "USD", maxAgeSeconds: 86400, lastAttemptAt: checkedAt, lastSuccessAt: checkedAt - 3600,
      lastError: "Existing offer error", isRunning: true, gamesChecked: 9, totalGames: 0, freshGames: 0,
    });
    await client.execute({ sql: "UPDATE deal_refresh_state SET lock_expires_at=? WHERE country='US'", args: [checkedAt - 60] });
    expect(await read("/api/deal-state")).toMatchObject({ isRunning: false, lastError: "Existing offer error", gamesChecked: 9 });
    expect((await harness.fetch("https://d1-test.invalid/api/internal/db")).status).toBe(401);
    expect((await harness.fetch("https://d1-test.invalid/api/games", { method: "POST" })).status).toBe(404);
    expect((await harness.fetch("https://d1-test.invalid/api/unknown")).status).toBe(404);
  });

  test("preserves city-builder weighting, stable ties, null scores and eligibility", async () => {
    const rows = [
      [40, 800, "City Builder broken JSON", "full", null, 0],
      [30, 100, '["City Builder"]', "full", null, 0],
      [20, 800, JSON.stringify([...Array.from({ length: 19 }, (_, i) => `Tag ${i}`), "City Builder"]), "full", 0, 0],
      [10, 104, '["Strategy","City Builder"]', "partial", 60, 0],
      [60, null, '["City Builder"]', "partial", null, 0],
      [50, null, '["City Builder"]', "full", null, 0],
      [70, 9999, '["City Builder"]', null, null, 0],
      [80, 9999, '["City Builder"]', "full", 61, 0],
      [90, 9999, '["City Builder"]', "full", null, 1],
      [100, 9999, '["Simulation"]', "full", null, 0],
    ] satisfies (number | string | null)[][];
    await seed(rows.map((row) => ({
      sql: `INSERT INTO games (id, steam_app_id, name, value_score, tags, controller_support,
        playtime_minutes, is_ignored, steam_review_score, steam_review_count, hltb_main) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 92, 100, 12.5)`,
      args: [row[0]!, row[0]!, `City ${row[0]}`, ...row.slice(1)],
    })));
    const response = await harness.fetch("https://d1-test.invalid/api/city-builders");
    expect(response.status).toBe(200);
    const cities: CityBuilderGameDto[] = await response.json();
    expect(cities.map((game) => [game.steam_app_id, game.tag_rank, game.weighted_score])).toEqual([
      [20, 20, 200], [40, 20, 200], [10, 2, 100], [30, 1, 100], [50, 1, null], [60, 1, null],
    ]);
    expect(cities[2]).toEqual({
      steam_app_id: 10, name: "City 10", steam_review_score: 92, steam_review_count: 100,
      hltb_main: 12.5, controller_support: "partial", playtime_minutes: 60,
      value_score: 104, tag_rank: 2, weighted_score: 100,
    });
  });

  test("returns every city builder beyond a single D1 result limit without changing stable ties", async () => {
    await seed([
      { sql: "INSERT INTO games (id, steam_app_id, name, value_score, tags, controller_support) VALUES (-1, 30000, 'First tied city', 10, '[\"City Builder\"]', 'full')" },
      ...Array.from({ length: 10000 }, (_, i) => ({
        sql: "INSERT INTO games (id, steam_app_id, name, value_score, tags, controller_support) VALUES (?, ?, ?, ?, '[\"City Builder\"]', 'full')",
        args: [i + 1, i + 1, `Large city ${i + 1}`, i === 9999 ? 12345 : 10],
      })),
    ]);
    const response = await harness.fetch("https://d1-test.invalid/api/city-builders");
    expect(response.status).toBe(200);
    const cities: CityBuilderGameDto[] = await response.json();
    expect(cities.map((game) => game.steam_app_id)).toEqual([10000, 30000, ...Array.from({ length: 9999 }, (_, i) => i + 1)]);
    expect(cities[0]?.weighted_score).toBe(12345);
    expect(cities.at(-1)?.weighted_score).toBe(10);
  });

  test("keeps all chunked mapping and cache reads in one snapshot during native publication", async () => {
    const appIds = Array.from({ length: 500 }, (_, i) => i + 1);
    await seed(appIds.map((appId) => ({ sql: "INSERT INTO itad_game_map VALUES (?, NULL, ?)", args: [appId, start] })));
    const writer = async () => {
      for (let phase = 1; phase <= 30; phase++) {
        const mapped = phase % 2 === 1;
        const statements: DbStatement[] = [
          { sql: "UPDATE itad_game_map SET itad_id=?, checked_at=?", args: [mapped ? gid(1) : null, start + phase] },
          "DELETE FROM game_deal_cache",
        ];
        if (mapped) statements.push(
          { sql: "INSERT INTO game_deal_cache SELECT steam_app_id, 'US', 'retail', ?, ? FROM itad_game_map", args: [start + phase, JSON.stringify([offer("retail")])] },
          { sql: "INSERT INTO game_deal_cache SELECT steam_app_id, 'US', 'bundle', ?, ? FROM itad_game_map", args: [start + phase, JSON.stringify([offer("bundle")])] },
        );
        await client.batch(statements);
      }
    };
    const reader = async () => {
      for (let i = 0; i < 30; i++) {
        const snapshot = await getGameDeals(client, appIds, start);
        expect(snapshot.size).toBe(500);
        expect(new Set([...snapshot.values()].map((deals) => JSON.stringify(deals))).size).toBe(1);
        expect(["fresh", "unmapped"]).toContain(snapshot.get(1)!.status);
      }
    };
    await Promise.all([writer(), reader()]);
    const completed = await getGameDeals(client, appIds, start);
    expect(completed.get(1)).toEqual({ status: "unmapped", checkedAt: start + 30, offers: [] });
    expect(completed.get(500)).toEqual({ status: "unmapped", checkedAt: start + 30, offers: [] });
  });

  test("preserves stable equal-Value-Score pages and existing query bounds", async () => {
    await seed(Array.from({ length: 502 }, (_, i) => ({
      sql: "INSERT INTO games (id, steam_app_id, name, value_score) VALUES (?, ?, ?, 50)",
      args: [502 - i, 9000 + i, `Tie ${i}`],
    })));
    const expectedIds = Array.from({ length: 502 }, (_, i) => i + 1);
    for (const filters of ["", "hideIgnored=true"]) {
      const first = await browse(`limit=500&${filters}`);
      const rest = await browse(`limit=500&offset=500&${filters}`);
      expect([...first, ...rest].map((game) => game.id)).toEqual(expectedIds);
      expect((await browse(`limit=500&${filters}`)).map((game) => game.id)).toEqual(expectedIds.slice(0, 500));
    }
    expect((await browse("limit=9999&offset=-1")).map((game) => game.id)).toEqual(expectedIds.slice(0, 500));
    expect((await browse("limit=invalid&offset=invalid")).map((game) => game.id)).toEqual(expectedIds.slice(0, 100));
    expect((await browse("limit=0")).map((game) => game.id)).toEqual([1]);
    expect(await browse("offset=100000")).toEqual([]);
  });

  test("does not initialize schema on human reads and retains missing Steam Status as null", async () => {
    const empty = await createD1WorkerTestHarness({ bootstrap: false });
    try {
      const response = await empty.fetch("https://d1-test.invalid/api/sync-state");
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
      const unbootstrapped = createHttpClient(empty.clientConfig);
      await expect(unbootstrapped.execute("SELECT last_error FROM sync_state")).rejects.toMatchObject({ code: "SQL_ERROR", message: "no such table: sync_state" });
      for (const path of ["games", "city-builders", "deal-state"]) {
        const failed = await empty.fetch(`https://d1-test.invalid/api/${path}`);
        expect(failed.status).toBe(500);
      }
      await expect(unbootstrapped.execute("SELECT name FROM games")).rejects.toMatchObject({ code: "SQL_ERROR", message: "no such table: games" });
      await expect(unbootstrapped.execute("SELECT country FROM deal_refresh_state")).rejects.toMatchObject({ code: "SQL_ERROR", message: "no such table: deal_refresh_state" });
    } finally { await empty.dispose(); }
  });

  test("returns the human game DTO with Catalog Facts, Steam Status and Value Score", async () => {
    expect(await browse()).toEqual([]);
    await client.execute({
      sql: `INSERT INTO games (
        id, steam_app_id, name, steam_review_score, steam_review_count,
        hltb_id, hltb_main, hltb_main_extra, hltb_completionist, value_score,
        is_on_wishlist, is_early_access, controller_support, release_date,
        is_owned, playtime_minutes, is_ignored, has_single_player, has_multiplayer,
        has_co_op, has_online_co_op, has_local_co_op, has_pvp, has_online_pvp,
        has_local_pvp, has_crossplatform, is_mmo, tags, created_at, updated_at
      ) VALUES (?, ?, ?, 94, 1200, 81, 12.5, 18, 24.5, 987.25,
        1, 1, 'partial', '2024-02-29', 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, NULL, 1, 0, ?, ?, ?)`,
      args: [41, 1041, 'City "α"', '["City Builder","Co-op"]', start - 60, start],
    });
    expect(await browse()).toEqual([{
      id: 41, steamAppId: 1041, name: 'City "α"', steamReviewScore: 94, steamReviewCount: 1200,
      hltbId: 81, hltbMain: 12.5, hltbMainExtra: 18, hltbCompletionist: 24.5, valueScore: 987.25,
      isEndless: false, isOnWishlist: true, isEarlyAccess: true, controllerSupport: "partial",
      releaseDate: "2024-02-29", isOwned: true, playtimeMinutes: 0, isIgnored: true,
      hasSinglePlayer: true, hasMultiplayer: false, hasCoOp: true, hasOnlineCoOp: true,
      hasLocalCoOp: false, hasPvP: true, hasOnlinePvP: false, hasLocalPvP: false,
      hasCrossplatform: true, isMMO: false, tags: '["City Builder","Co-op"]',
      createdAt: start - 60, updatedAt: start,
      deals: { status: "unknown", checkedAt: null, offers: [] },
    }]);
  });
});
