import { afterEach, beforeEach, expect, test } from "bun:test";
import { validateWireRequest, type DbClient } from "../db/access";
import { createHttpClient } from "../db/http";
import { createD1WorkerTestHarness, type D1WorkerTestHarness } from "../db/testing";
import { refreshGameDeals, type DealSource } from "./deal-refresh";
import { ItadError } from "./itad-errors";
import { ItadClient } from "./itad-client";
import { getDealRefreshStatus, getGameDeals } from "./game-deals";
import type { DealOffer } from "./deal-types";

const start = 1_800_000_000;
const gid = (id: number) => `00000000-0000-0000-0000-${String(id).padStart(12, "0")}`;
const offer = (kind: "retail" | "bundle", validUntil = start + 86400): DealOffer => ({
  kind, id: `${kind}:1`, title: "Known offer", store: "Known store", url: "https://itad.link/example/?affiliate=unchanged",
  priceCents: 500, currency: "USD", discountPercent: kind === "retail" ? 50 : null,
  drm: [], voucher: null, note: null, expiresAt: null, validUntil,
});
let harness: D1WorkerTestHarness;
let client: DbClient;
let now: number;
function source(overrides: Partial<DealSource> = {}): DealSource {
  return {
    lookup: async (ids) => new Map(ids.map((id) => [id, gid(id)])),
    prices: async (ids) => new Map(ids.map((id) => [id, id === gid(2) ? [offer("retail")] : []])),
    bundles: async () => ({ fetchedAt: now, games: new Map([[gid(3), [offer("bundle")]]]) }),
    ...overrides,
  };
}
const run = (provider = source(), db = client) => refreshGameDeals(db, provider, { now: () => now });
beforeEach(async () => {
  now = start;
  harness = await createD1WorkerTestHarness();
  client = createHttpClient(harness.clientConfig);
  await client.batch([1, 2, 3, 4].map((id) => ({
    sql: "INSERT INTO games (steam_app_id, name, value_score) VALUES (?, ?, ?)", args: [id, `Game ${id}`, 1000 - id * 100],
  })));
});
afterEach(async () => { await harness?.dispose(); });

test("offer refresh publishes persisted scopes and success through the external client without schema initialization", async () => {
  expect(await run()).toEqual({ skipped: false, gamesChecked: 4, missingPrices: 0, unmapped: 0 });
  expect(await getGameDeals(client, [1, 2, 3], now)).toEqual(new Map([
    [1, { status: "fresh", checkedAt: start, offers: [] }],
    [2, { status: "fresh", checkedAt: start, offers: [offer("retail")] }],
    [3, { status: "fresh", checkedAt: start, offers: [offer("bundle")] }],
  ]));
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastAttemptAt: start, lastSuccessAt: start, lastError: null, isRunning: false, gamesChecked: 4, totalGames: 4, freshGames: 4 });
});

test("offer refresh partitions independent complete retail/bundle pairs by escaped UTF-8 request bytes without dropping offers", async () => {
  await client.batch([5, 6, 7, 8].map((id) => ({ sql: "INSERT INTO games (steam_app_id, name, value_score) VALUES (?, ?, 50)", args: [id, `Game ${id}`] })));
  const payload = '\"\\\né'.repeat(70_000);
  await run(source({
    prices: async (ids) => new Map(ids.map((id) => [id, [{ ...offer("retail"), note: payload }]])),
    bundles: async () => ({ fetchedAt: now, games: new Map(Array.from({ length: 8 }, (_, i) => [gid(i + 1), [{ ...offer("bundle"), note: payload }]])) }),
  }));
  expect((await client.execute(`SELECT steam_app_id, kind, checked_at, json_array_length(offers_json) AS offers,
    length(json_extract(offers_json, '$[0].note')) AS note_length FROM game_deal_cache ORDER BY steam_app_id, kind`)).rows).toEqual(
    Array.from({ length: 8 }, (_, i) => [
      { steam_app_id: i + 1, kind: "bundle", checked_at: start, offers: 1, note_length: 280_000 },
      { steam_app_id: i + 1, kind: "retail", checked_at: start, offers: 1, note_length: 280_000 },
    ]).flat(),
  );
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ gamesChecked: 8, freshGames: 8, lastSuccessAt: start, lastError: null, isRunning: false });
});

test.each(["unknown", "committed"])("offer refresh stops after a %s publication error without speculative lease cleanup or success", async (outcome) => {
  const uncertain = createHttpClient({ ...harness.clientConfig, fetch: async (request) => {
    const body = validateWireRequest(await request.clone().json());
    const response = await harness.fetch(request);
    if (body.op === "batch" && body.statements.some((statement) => statement.sql.includes("INSERT INTO game_deal_cache"))) {
      await response.body?.cancel();
      if (outcome === "unknown") throw new Error("credential-URL-and-SQL-parameters-must-not-escape");
      return Response.json({ version: 1, ok: false, requestId: request.headers.get("X-Steam-Value-Request-Id"), error: { code: "RESULT_LIMIT", message: "Database result exceeds supported limits", outcome: "committed" } }, { status: 413 });
    }
    return response;
  } });
  await expect(run(source(), uncertain)).rejects.toMatchObject({ code: outcome === "unknown" ? "OUTCOME_UNKNOWN" : "RESULT_LIMIT", outcome });
  expect(await getGameDeals(client, [2], now)).toEqual(new Map([[2, { status: "fresh", checkedAt: start, offers: [offer("retail")] }]]));
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastAttemptAt: start, lastSuccessAt: null, lastError: null, isRunning: true, gamesChecked: 0, freshGames: 4 });
  expect(await run()).toMatchObject({ skipped: true });
});

test.each(["unknown", "committed"])("a mapping publication error with %s outcome preserves its lease and previous success for reconciliation", async (outcome) => {
  await run();
  now = start + 604800;
  const uncertain = createHttpClient({ ...harness.clientConfig, fetch: async (request) => {
    const body = validateWireRequest(await request.clone().json());
    const response = await harness.fetch(request);
    if (body.op === "batch" && body.statements.some((statement) => statement.sql.includes("INSERT INTO itad_game_map"))) {
      await response.body?.cancel();
      if (outcome === "unknown") throw new Error("private mapping parameters and credentials");
      return Response.json({ version: 1, ok: false, requestId: request.headers.get("X-Steam-Value-Request-Id"), error: { code: "RESULT_LIMIT", message: "Database result exceeds supported limits", outcome: "committed" } }, { status: 413 });
    }
    return response;
  } });
  await expect(run(source({ lookup: async (ids) => new Map(ids.map((id) => [id, null])) }), uncertain)).rejects.toMatchObject({ code: outcome === "unknown" ? "OUTCOME_UNKNOWN" : "RESULT_LIMIT", outcome });
  expect((await getGameDeals(client, [2], now)).get(2)).toEqual({ status: "unmapped", checkedAt: start + 604800, offers: [] });
  expect((await client.execute("SELECT steam_app_id FROM game_deal_cache")).rows).toEqual([]);
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastSuccessAt: start, lastError: null, gamesChecked: 0, isRunning: true });
});

test("an abandoned mapping writer cannot delete replacement offers and detects its rejected mapping publication", async () => {
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delayed = createHttpClient({ ...harness.clientConfig, fetch: async (request) => {
    const body = validateWireRequest(await request.clone().json());
    if (body.op === "batch" && body.statements.some((statement) => statement.sql.includes("INSERT INTO itad_game_map"))) {
      ready.resolve(); await release.promise;
    }
    return harness.fetch(request);
  } });
  const first = run(source(), delayed);
  try {
    await ready.promise;
    expect(await run()).toMatchObject({ skipped: true });
    now = start + 900;
    expect(await run()).toMatchObject({ skipped: false, gamesChecked: 4 });
    const replacement = await getGameDeals(client, [2], now);
    release.resolve();
    await expect(first).rejects.toThrow("Offer refresh lost mapping lease");
    expect(await getGameDeals(client, [2], now)).toEqual(replacement);
    expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastAttemptAt: start + 900, lastSuccessAt: start + 900, lastError: null, isRunning: false, gamesChecked: 4 });
  } finally { release.resolve(); await first.catch(() => undefined); }
});

test("offer refresh reads every ranked game beyond one bounded result page without changing checked-null mappings", async () => {
  for (let first = 5; first <= 10_005; first += 200) {
    await client.batch(Array.from({ length: Math.min(200, 10_006 - first) }, (_, i) => [
      { sql: "INSERT INTO games (steam_app_id, name, value_score) VALUES (?, ?, 5)", args: [first + i, `Game ${first + i}`] },
      { sql: "INSERT INTO itad_game_map (steam_app_id, itad_id, checked_at) VALUES (?, NULL, ?)", args: [first + i, start] },
    ]).flat());
  }
  await client.batch([1, 2, 3, 4].map((id) => ({ sql: "INSERT INTO itad_game_map (steam_app_id, itad_id, checked_at) VALUES (?, NULL, ?)", args: [id, start] })));
  expect(await run()).toEqual({ skipped: false, gamesChecked: 10_005, missingPrices: 0, unmapped: 10_005 });
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ gamesChecked: 10_005, totalGames: 10_005, freshGames: 0, lastSuccessAt: start });
  expect((await client.execute("SELECT COUNT(*) AS total FROM itad_game_map WHERE itad_id IS NULL AND checked_at=1800000000")).rows).toEqual([{ total: 10_005 }]);
});

test("new mappings with missing retail remain partial rather than successful empty retail", async () => {
  expect(await run(source({ prices: async () => new Map() }))).toMatchObject({ missingPrices: 4, gamesChecked: 4 });
  expect((await getGameDeals(client, [2], now)).get(2)).toEqual({ status: "partial", checkedAt: start, offers: [] });
  expect((await client.execute("SELECT DISTINCT kind FROM game_deal_cache")).rows).toEqual([{ kind: "bundle" }]);
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ freshGames: 0, lastSuccessAt: start });
});

test("offer limit preserves ranked ordering and excludes endless and unranked games", async () => {
  await client.batch([
    "INSERT INTO games (steam_app_id, name, value_score, is_endless) VALUES (5, 'Endless', 5000, 1)",
    "INSERT INTO games (steam_app_id, name) VALUES (6, 'Unranked')",
  ]);
  expect(await refreshGameDeals(client, source(), { now: () => now, limit: 2 })).toMatchObject({ gamesChecked: 2 });
  expect((await client.execute("SELECT steam_app_id FROM itad_game_map ORDER BY steam_app_id")).rows).toEqual([{ steam_app_id: 1 }, { steam_app_id: 2 }]);
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ gamesChecked: 2, totalGames: 4, freshGames: 2 });
});

test("offer freshness expires at exactly 24 hours and honors earlier provider expiration", async () => {
  await run(source({ prices: async (ids) => new Map(ids.map((id) => [id, id === gid(2) ? [offer("retail", start + 60)] : []])) }));
  expect((await getGameDeals(client, [2, 3], start + 59)).get(2)?.offers).toEqual([offer("retail", start + 60)]);
  expect((await getGameDeals(client, [2, 3], start + 60)).get(2)).toMatchObject({ status: "fresh", offers: [] });
  expect((await getGameDeals(client, [3], start + 86399)).get(3)?.offers).toEqual([offer("bundle")]);
  expect((await getGameDeals(client, [3], start + 86400)).get(3)).toEqual({ status: "stale", checkedAt: start, offers: [] });
  expect(await getDealRefreshStatus(client, start + 86400)).toMatchObject({ freshGames: 0 });
});

test("missing retail does not renew verified data, provider failure preserves it, and successful empty scopes remove sales", async () => {
  await run();
  now = start + 3600;
  await expect(run(source({ prices: async () => { throw new ItadError("UNAVAILABLE"); } }))).rejects.toThrow("ITAD unavailable");
  expect((await getGameDeals(client, [2], now)).get(2)).toEqual({ status: "fresh", checkedAt: start, offers: [offer("retail")] });
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastSuccessAt: start, lastError: "ITAD unavailable", isRunning: false });
  now = start + 86400;
  expect(await run(source({ prices: async () => new Map(), bundles: async () => ({ fetchedAt: now, games: new Map() }) }))).toMatchObject({ missingPrices: 4 });
  expect((await getGameDeals(client, [2], now)).get(2)).toEqual({ status: "partial", checkedAt: start, offers: [] });
  now++;
  await run(source({ prices: async (ids) => new Map(ids.map((id) => [id, []])), bundles: async () => ({ fetchedAt: now, games: new Map() }) }));
  expect((await getGameDeals(client, [2], now)).get(2)).toEqual({ status: "fresh", checkedAt: start + 86401, offers: [] });
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastSuccessAt: start + 86401, lastError: null, freshGames: 4 });
});

test("checked mappings are reused until exactly seven days and remapping deletes old scopes atomically across countries", async () => {
  expect((await getGameDeals(client, [2], now)).get(2)).toEqual({ status: "unknown", checkedAt: null, offers: [] });
  await run();
  await client.execute({ sql: "INSERT INTO game_deal_cache (steam_app_id, country, kind, checked_at, offers_json) VALUES (2, 'CA', 'retail', ?, '[]')", args: [start] });
  const unmatched = source({ lookup: async (ids) => new Map(ids.map((id) => [id, null])) });
  now = start + 604799;
  await run(unmatched);
  expect((await client.execute("SELECT itad_id, checked_at FROM itad_game_map WHERE steam_app_id=2")).rows).toEqual([{ itad_id: gid(2), checked_at: start }]);
  now++;
  expect(await run(unmatched)).toMatchObject({ unmapped: 4 });
  expect((await getGameDeals(client, [2], now)).get(2)).toEqual({ status: "unmapped", checkedAt: start + 604800, offers: [] });
  expect((await client.execute("SELECT country FROM game_deal_cache WHERE steam_app_id=2")).rows).toEqual([]);
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ gamesChecked: 4, freshGames: 0, lastSuccessAt: start + 604800 });
});

test("209 ranked games preserve 200-game provider batches and all 400-statement publication boundaries", async () => {
  await client.batch(Array.from({ length: 205 }, (_, i) => ({ sql: "INSERT INTO games (steam_app_id, name, value_score) VALUES (?, ?, 5)", args: [i + 5, `Game ${i + 5}`] })));
  expect(await run(source({ lookup: async (ids) => {
    if (ids.length > 200) throw new Error("provider batch is unsupported");
    return new Map(ids.map((id) => [id, gid(id)]));
  } }))).toMatchObject({ gamesChecked: 209, missingPrices: 0 });
  expect((await client.execute("SELECT COUNT(*) AS total FROM itad_game_map")).rows).toEqual([{ total: 209 }]);
  expect((await client.execute("SELECT COUNT(*) AS total FROM game_deal_cache")).rows).toEqual([{ total: 418 }]);
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ gamesChecked: 209, freshGames: 209 });
});

test.each(["publication", "completion"])("a replaced offer lease fences late %s and preserves replacement success", async (phase) => {
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delayed = createHttpClient({ ...harness.clientConfig, fetch: async (request) => {
    const body = validateWireRequest(await request.clone().json());
    const matching = phase === "publication"
      ? body.op === "batch" && body.statements.some((statement) => statement.sql.includes("INSERT INTO game_deal_cache"))
      : body.op === "execute" && body.statement.sql.includes("SET last_success_at");
    if (matching) { ready.resolve(); await release.promise; }
    return harness.fetch(request);
  } });
  const first = run(source(), delayed);
  try {
    await ready.promise;
    now = start + 900;
    await run(source({ prices: async (ids) => new Map(ids.map((id) => [id, []])), bundles: async () => ({ fetchedAt: now, games: new Map() }) }));
    release.resolve();
    await expect(first).rejects.toThrow(`Offer refresh lost ${phase} lease`);
    expect((await getGameDeals(client, [2, 3], now)).get(2)).toEqual({ status: "fresh", checkedAt: start + 900, offers: [] });
    expect((await getGameDeals(client, [3], now)).get(3)).toEqual({ status: "fresh", checkedAt: start + 900, offers: [] });
    expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastSuccessAt: start + 900, lastError: null, isRunning: false, gamesChecked: 4 });
  } finally { release.resolve(); await first.catch(() => undefined); }
});

test("an expired offer lease cannot renew, releases only its own failure state, and the next run can recover", async () => {
  await expect(run(source({ bundles: async () => { now = start + 900; return { fetchedAt: now, games: new Map() }; } }))).rejects.toThrow("Offer refresh lease expired or was replaced");
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastSuccessAt: null, lastError: "Offer refresh lease expired or was replaced", isRunning: false, gamesChecked: 0, freshGames: 0 });
  expect(await run()).toMatchObject({ gamesChecked: 4, skipped: false });
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastSuccessAt: start + 900, lastError: null });
});

test("unsupported single-scope bytes reject the complete publication group rather than clip offers or publish a prefix", async () => {
  await run();
  now++;
  await expect(run(source({ prices: async (ids) => new Map(ids.map((id) => [id, id === gid(4) ? [{ ...offer("retail"), note: "é".repeat(500_000) }] : []])) }))).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", outcome: "not-applied" });
  expect((await getGameDeals(client, [2], now)).get(2)).toEqual({ status: "fresh", checkedAt: start, offers: [offer("retail")] });
  expect((await client.execute("SELECT DISTINCT checked_at FROM game_deal_cache")).rows).toEqual([{ checked_at: start }]);
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastSuccessAt: start, lastError: "Database request exceeds supported limits", isRunning: false });
});

test("unsafe provider exceptions never escape or enter persisted offer failure state", async () => {
  await expect(run(source({ bundles: async () => { throw new Error("private-token / SQL parameters / raw upstream body"); } }))).rejects.toThrow("Offer provider request failed");
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastError: "Offer provider request failed", lastSuccessAt: null, isRunning: false, freshGames: 0 });
});

test.each([
  { name: "object validation", response: () => Response.json([]), message: "Invalid ITAD object" },
  { name: "invalid JSON", response: () => new Response("synthetic-untrusted-body"), message: "ITAD returned invalid JSON" },
  { name: "HTTP rejection", response: () => new Response("synthetic-untrusted-body", { status: 401 }), message: "ITAD request failed (HTTP 401)" },
])("real provider diagnostics remain useful and safe through native refresh persistence: $name", async ({ response, message }) => {
  const provider = new ItadClient("synthetic-provider-key", { fetch: async () => response(), sleep: async () => {}, retries: 0, now: () => now });
  await expect(run(source({ lookup: (ids) => provider.lookup(ids) }))).rejects.toThrow(message);
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastError: message, lastSuccessAt: null, isRunning: false, freshGames: 0 });
});

test("a trusted provider error keeps its safe diagnostic even if its public message is overwritten", async () => {
  const error = new ItadError("INVALID_OBJECT");
  error.message = "synthetic-private-key / raw provider body / SQL parameters";
  await expect(run(source({ prices: async () => { throw error; } }))).rejects.toThrow("Invalid ITAD object");
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastError: "Invalid ITAD object", lastSuccessAt: null, isRunning: false, freshGames: 0 });
});

test.each(["ITAD unavailable", "Invalid ITAD object", "ITAD request failed (HTTP 401)"])("untrusted exceptions cannot spoof safe provider diagnostics by message: %s", async (message) => {
  const error = Object.assign(new Error(message), { name: "ItadError", code: "UNAVAILABLE" });
  await expect(run(source({ prices: async () => { throw error; } }))).rejects.toThrow("Offer provider request failed");
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastError: "Offer provider request failed", lastSuccessAt: null, isRunning: false, freshGames: 0 });
});

test.each(["mapping", "scopes"])("native rollback preserves complete prior offer %s when a publication group fails", async (phase) => {
  await run();
  const before = await client.batch(["SELECT * FROM itad_game_map ORDER BY steam_app_id", "SELECT * FROM game_deal_cache ORDER BY steam_app_id, country, kind"], "read");
  now += phase === "mapping" ? 604800 : 1;
  const rejected = createHttpClient({ ...harness.clientConfig, fetch: async (request) => {
    const body = validateWireRequest(await request.clone().json());
    const table = phase === "mapping" ? "itad_game_map" : "game_deal_cache";
    if (body.op === "batch" && body.statements.some((statement) => statement.sql.includes(`INSERT INTO ${table}`))) {
      const statements = [...body.statements, { sql: "INSERT INTO game_deal_cache (steam_app_id, country, kind, checked_at, offers_json) VALUES (999, 'US', 'invalid', 1, '[]')", args: [] }];
      return harness.fetch(new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify({ ...body, statements }) }));
    }
    return harness.fetch(request);
  } });
  await expect(run(source({ lookup: async (ids) => new Map(ids.map((id) => [id, null])), prices: async (ids) => new Map(ids.map((id) => [id, []])), bundles: async () => ({ fetchedAt: now, games: new Map() }) }), rejected)).rejects.toMatchObject({ code: "SQL_ERROR", outcome: "rolled-back", message: "Database constraint violation" });
  expect(await client.batch(["SELECT * FROM itad_game_map ORDER BY steam_app_id", "SELECT * FROM game_deal_cache ORDER BY steam_app_id, country, kind"], "read")).toEqual(before);
  expect(await getDealRefreshStatus(client, now)).toMatchObject({ lastSuccessAt: start, lastError: "Database constraint violation", isRunning: false, gamesChecked: 0 });
});
