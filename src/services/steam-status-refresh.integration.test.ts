import { afterEach, beforeEach, expect, test } from "bun:test";
import { isRecord, validateWireRequest, type DbClient } from "../db/access";
import { createHttpClient } from "../db/http";
import { createD1WorkerTestHarness, type D1WorkerTestHarness } from "../db/testing";
import { getSyncState, syncSteamStatus, syncSteamStatusFromUserData, type SteamUserData } from "./steam-status-sync";

const start = 1_800_000_000;
const source = () => ({
  userData: async () => ({ rgOwnedApps: [10, 20, 30], rgWishlist: [30], rgIgnoredApps: { "40": 1 } }),
  library: async () => ({ ownedGames: new Map([[10, 90], [20, 60]]), recentlyPlayedGames: new Map([[10, 110], [30, 11]]) }),
});

let harness: D1WorkerTestHarness;
let client: DbClient;
beforeEach(async () => {
  harness = await createD1WorkerTestHarness();
  client = createHttpClient(harness.clientConfig);
});
afterEach(async () => { await harness?.dispose(); });

test("a rejected Steam Status refresh persists failure without runtime schema initialization", async () => {
  await client.execute("INSERT INTO games (steam_app_id, name, is_owned, playtime_minutes) VALUES (10, 'Existing game', 1, 120)");
  expect(await syncSteamStatus(client, {})).toMatchObject({ success: false, error: "Missing STEAM_LOGIN_SECURE" });
  expect(await getSyncState(client)).toMatchObject({ lastSuccessAt: null, lastError: "Missing STEAM_LOGIN_SECURE", isRunning: false, lockExpiresAt: null });
  expect((await client.execute("SELECT steam_app_id, is_owned, playtime_minutes FROM games")).rows).toEqual([{ steam_app_id: 10, is_owned: 1, playtime_minutes: 120 }]);
});

test("browser-backed Steam Status publishes markers and preserves maximum recorded and recent Playtime", async () => {
  await client.batch([
    "INSERT INTO games (steam_app_id, name, is_owned, is_ignored, is_on_wishlist, playtime_minutes) VALUES (10, 'Higher recorded', 1, 1, 1, 120)",
    "INSERT INTO games (steam_app_id, name) VALUES (20, 'Newly owned')",
    "INSERT INTO games (steam_app_id, name) VALUES (30, 'Free recent game')",
    "INSERT INTO games (steam_app_id, name, is_owned, playtime_minutes) VALUES (40, 'Left library', 1, 22)",
  ]);
  const provider = source();
  expect(await syncSteamStatusFromUserData(client, {}, await provider.userData(), { source: provider, now: () => start })).toMatchObject({ success: true, gamesUpdated: 4, gamesRemoved: 0 });
  expect((await client.execute("SELECT steam_app_id, is_owned, is_ignored, is_on_wishlist, playtime_minutes FROM games ORDER BY steam_app_id")).rows).toEqual([
    { steam_app_id: 10, is_owned: 1, is_ignored: 0, is_on_wishlist: 0, playtime_minutes: 120 },
    { steam_app_id: 20, is_owned: 1, is_ignored: 0, is_on_wishlist: 0, playtime_minutes: 60 },
    { steam_app_id: 30, is_owned: 0, is_ignored: 0, is_on_wishlist: 1, playtime_minutes: 11 },
    { steam_app_id: 40, is_owned: 0, is_ignored: 1, is_on_wishlist: 0, playtime_minutes: 22 },
  ]);
  expect(await getSyncState(client)).toMatchObject({ lastAttemptAt: start, lastSuccessAt: start, lastError: null, isRunning: false, lockExpiresAt: null, ownedCount: 2, ignoredCount: 1, wishlistCount: 1, gamesUpdated: 4 });
});

test.each(["unknown", "committed"])("Steam Status stops after a game-write error with %s outcome without clearing its uncertain lock or advertising success", async (outcome) => {
  await client.execute("INSERT INTO games (steam_app_id, name) VALUES (20, 'Newly owned')");
  const uncertain = createHttpClient({ ...harness.clientConfig, fetch: async (request) => {
    const body = validateWireRequest(await request.clone().json());
    const response = await harness.fetch(request);
    if (body.op === "batch" && body.mode === "write") {
      await response.body?.cancel();
      if (outcome === "unknown") throw new Error("secret-url-and-SQL-parameters-must-not-escape");
      return Response.json({ version: 1, ok: false, requestId: request.headers.get("X-Steam-Value-Request-Id"), error: { code: "RESULT_LIMIT", message: "Database result exceeds supported limits", outcome: "committed" } }, { status: 413 });
    }
    return response;
  } });
  await expect(syncSteamStatus(uncertain, {}, { source: source(), now: () => start })).rejects.toMatchObject({
    code: outcome === "unknown" ? "OUTCOME_UNKNOWN" : "RESULT_LIMIT", outcome,
    message: outcome === "unknown" ? "Database write outcome is unknown; inspect state before resuming" : "Database result exceeds supported limits",
  });
  expect((await client.execute("SELECT is_owned, playtime_minutes FROM games WHERE steam_app_id=20")).rows).toEqual([{ is_owned: 1, playtime_minutes: 60 }]);
  expect(await getSyncState(client)).toMatchObject({ lastSuccessAt: null, lastError: null, isRunning: true, lockExpiresAt: start + 900, gamesUpdated: 0 });
});

test("Steam Status refreshes the complete Game Catalog beyond one bounded result page", async () => {
  for (let first = 1; first <= 10_005; first += 400) {
    await client.batch(Array.from({ length: Math.min(400, 10_006 - first) }, (_, offset) => ({
      sql: "INSERT INTO games (steam_app_id, name) VALUES (?, ?)", args: [first + offset, `Game ${first + offset}`],
    })));
  }
  const provider = {
    userData: async () => ({ rgOwnedApps: [1], rgWishlist: [], rgIgnoredApps: {} }),
    library: async () => ({ ownedGames: new Map(Array.from({ length: 10_005 }, (_, offset) => [offset + 1, 60])), recentlyPlayedGames: new Map<number, number>() }),
  };
  expect(await syncSteamStatus(client, {}, { source: provider, now: () => start })).toMatchObject({ success: true, gamesUpdated: 10_005 });
  expect((await client.execute("SELECT COUNT(*) AS total, MIN(steam_app_id) AS first, MAX(steam_app_id) AS last FROM games WHERE is_owned=1 AND playtime_minutes=60")).rows).toEqual([{ total: 10_005, first: 1, last: 10_005 }]);
  expect(await getSyncState(client)).toMatchObject({ ownedCount: 10_005, gamesUpdated: 10_005, isRunning: false });
});

const rejectedSteamCases: { name: string; userData: SteamUserData; owned: [number, number][]; error: string }[] = [
  { name: "incomplete authenticated fields", userData: { rgOwnedApps: [10] }, owned: [[10, 60]], error: "Steam Dynamic Store returned an incomplete response" },
  { name: "expired Steam authentication", userData: { rgOwnedApps: [], rgWishlist: [], rgIgnoredApps: {} }, owned: [[10, 60]], error: "Steam Dynamic Store session is not authenticated" },
  { name: "empty official owned-games response", userData: { rgOwnedApps: [10], rgWishlist: [], rgIgnoredApps: {} }, owned: [], error: "Steam owned-games API returned no games" },
  { name: "greater-than-80-percent drops", userData: { rgOwnedApps: [10], rgWishlist: [10], rgIgnoredApps: { "10": 1 } }, owned: [[10, 60]], error: "Steam Status refresh rejected suspicious count drops: wishlist 50 -> 1, ignored 50 -> 1, owned 50 -> 1" },
];
test.each(rejectedSteamCases)("rejected Steam Status preserves persisted markers and last successful counts: $name", async ({ userData, owned, error }) => {
  await client.batch([
    "INSERT INTO games (steam_app_id, name, is_owned, is_ignored, is_on_wishlist, playtime_minutes) VALUES (10, 'Protected game', 1, 1, 1, 120)",
    { sql: "INSERT INTO sync_state (key, last_success_at, ignored_count, wishlist_count, owned_count, games_updated) VALUES ('steam_status', ?, 50, 50, 50, 7)", args: [start - 1] },
  ]);
  const provider = {
    userData: async (): Promise<SteamUserData> => userData,
    library: async () => ({ ownedGames: new Map(owned), recentlyPlayedGames: new Map<number, number>() }),
  };
  expect(await syncSteamStatus(client, {}, { source: provider, now: () => start })).toMatchObject({ success: false, error });
  expect(await getSyncState(client)).toMatchObject({ lastAttemptAt: start, lastSuccessAt: start - 1, lastError: error, isRunning: false, lockExpiresAt: null, ignoredCount: 50, wishlistCount: 50, ownedCount: 50, gamesUpdated: 7 });
  expect((await client.execute("SELECT is_owned, is_ignored, is_on_wishlist, playtime_minutes FROM games WHERE steam_app_id=10")).rows).toEqual([{ is_owned: 1, is_ignored: 1, is_on_wishlist: 1, playtime_minutes: 120 }]);
});

test("Steam Status refuses overlap through its exact expiry and rejects abandoned late completion", async () => {
  let now = start;
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const provider = source();
  const first = syncSteamStatus(client, {}, { now: () => now, source: {
    ...provider, library: async () => { ready.resolve(); await release.promise; return provider.library(); },
  } });
  try {
    await ready.promise;
    expect(await getSyncState(client)).toMatchObject({ isRunning: true, lockExpiresAt: start + 900 });
    expect(await syncSteamStatus(client, {}, { source: provider, now: () => now })).toMatchObject({ skipped: true });
    now = start + 900;
    expect(await syncSteamStatus(client, {}, { source: provider, now: () => now })).toMatchObject({ skipped: true });
    now++;
    expect(await syncSteamStatus(client, {}, { source: provider, now: () => now })).toMatchObject({ success: true });
    release.resolve();
    expect(await first).toMatchObject({ success: false, error: "Steam Status refresh lost completion lock" });
    expect(await getSyncState(client)).toMatchObject({ lastAttemptAt: start + 901, lastSuccessAt: start + 901, lastError: null, isRunning: false, lockExpiresAt: null, ownedCount: 2 });
  } finally { release.resolve(); await first.catch(() => undefined); }
});

test("Steam Status provider failures are safely persisted without exposing credential-bearing exceptions", async () => {
  await expect(syncSteamStatus(client, {}, { source: {
    ...source(), library: async () => { throw new Error("https://provider.invalid/?key=private-credential / raw SQL parameters"); },
  }, now: () => start })).resolves.toMatchObject({ success: false, error: "Steam provider request failed" });
  expect(await getSyncState(client)).toMatchObject({ lastError: "Steam provider request failed", isRunning: false, lockExpiresAt: null, lastSuccessAt: null });
});

test("native rollback prevents a partial Steam Status game group and preserves safe failure state", async () => {
  await client.execute("INSERT INTO games (steam_app_id, name) VALUES (20, 'Newly owned')");
  const rejected = createHttpClient({ ...harness.clientConfig, fetch: async (request) => {
    const body = validateWireRequest(await request.clone().json());
    if (body.op === "batch" && body.mode === "write") {
      const statements = [...body.statements, { sql: "INSERT INTO games (steam_app_id, name) VALUES (20, 'duplicate')", args: [] }];
      return harness.fetch(new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify({ ...body, statements }) }));
    }
    return harness.fetch(request);
  } });
  expect(await syncSteamStatus(rejected, {}, { source: source(), now: () => start })).toMatchObject({ success: false, error: "Database constraint violation" });
  expect((await client.execute("SELECT is_owned, playtime_minutes FROM games WHERE steam_app_id=20")).rows).toEqual([{ is_owned: 0, playtime_minutes: null }]);
  expect(await getSyncState(client)).toMatchObject({ lastSuccessAt: null, lastError: "Database constraint violation", isRunning: false, gamesUpdated: 0 });
});

test("missing schema stays missing when Steam Status reads or attempts a refresh", async () => {
  const empty = await createD1WorkerTestHarness({ bootstrap: false });
  try {
    const unbootstrapped = createHttpClient(empty.clientConfig);
    expect(await getSyncState(unbootstrapped)).toBeNull();
    await expect(syncSteamStatus(unbootstrapped, {}, { source: source(), now: () => start })).rejects.toMatchObject({ code: "SQL_ERROR", outcome: "not-applied", message: "no such table: sync_state" });
    expect(await getSyncState(unbootstrapped)).toBeNull();
  } finally { await empty.dispose(); }
});

test.each(["acquisition", "completion"])("a lost Steam Status %s reply stops at the persisted outcome without speculative failure writes", async (phase) => {
  await client.execute("INSERT INTO games (steam_app_id, name) VALUES (20, 'Uncertain state game')");
  const uncertain = createHttpClient({ ...harness.clientConfig, fetch: async (request) => {
    const body = validateWireRequest(await request.clone().json());
    const response = await harness.fetch(request);
    const matching = body.op === "execute" && (phase === "acquisition" ? body.statement.sql.includes("INSERT INTO sync_state") : body.statement.sql.includes("last_success_at ="));
    if (matching) { await response.body?.cancel(); throw new Error("private endpoint / parameters / credential"); }
    return response;
  } });
  await expect(syncSteamStatus(uncertain, {}, { source: source(), now: () => start })).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", outcome: "unknown", message: "Database write outcome is unknown; inspect state before resuming" });
  expect(await getSyncState(client)).toMatchObject(phase === "acquisition"
    ? { isRunning: true, lockExpiresAt: start + 900, lastSuccessAt: null, lastError: null, gamesUpdated: 0 }
    : { isRunning: false, lockExpiresAt: null, lastSuccessAt: start, lastError: null, gamesUpdated: 1 });
});

test("the intentional native Node 24 refresh path loads Playwright and publishes Steam Status and offers through the actual Worker", async () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node 24 is required for browser-backed refresh compatibility");
  await client.execute("INSERT INTO games (steam_app_id, name, value_score) VALUES (20, 'Node game', 100)");
  const code = `
    import { createInterface } from "node:readline";
    const input = createInterface({ input: process.stdin });
    try {
      if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Node 24 required");
      const { chromium } = await import("playwright");
      if (typeof chromium.connectOverCDP !== "function") throw new Error("Playwright CDP unavailable");
      const { createHttpClient } = await import("./src/db/http.ts");
      const { syncSteamStatusFromUserData } = await import("./src/services/steam-status-sync.ts");
      const { refreshGameDeals } = await import("./src/services/deal-refresh.ts");
      const client = createHttpClient({
        url: ${JSON.stringify(harness.clientConfig.url)}, token: ${JSON.stringify(harness.clientConfig.token)}, accessClientId: "synthetic-id", accessClientSecret: "synthetic-secret",
        fetch: async (request) => {
          const reply = new Promise(resolve => input.once("line", line => resolve(JSON.parse(line))));
          process.stdout.write(JSON.stringify({ kind: "request", url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() }) + "\\n");
          const response = await reply;
          return new Response(response.body, { status: response.status, headers: response.headers });
        },
      });
      const steam = await syncSteamStatusFromUserData(client, {}, { rgOwnedApps: [20], rgWishlist: [], rgIgnoredApps: {} }, {
        now: () => ${start}, source: { userData: async () => ({}), library: async () => ({ ownedGames: new Map([[20, 60]]), recentlyPlayedGames: new Map() }) },
      });
      const offers = await refreshGameDeals(client, {
        lookup: async ids => new Map(ids.map(id => [id, "node-itad-id"])), prices: async ids => new Map(ids.map(id => [id, []])),
        bundles: async () => ({ fetchedAt: ${start}, games: new Map() }),
      }, { now: () => ${start} });
      client.close();
      process.stdout.write(JSON.stringify({ kind: "result", steamSuccess: steam.success, offers }) + "\\n");
    } catch { process.stderr.write("Node refresh compatibility failed\\n"); process.exitCode = 1; }
    finally { input.close(); }
  `;
  const child = Bun.spawn([node, "--input-type=module", "-e", code], { env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  async function line(): Promise<unknown> {
    while (!pending.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error("Node refresh exited before completing its isolated request");
      pending += decoder.decode(next.value, { stream: true });
    }
    const end = pending.indexOf("\n");
    const value: unknown = JSON.parse(pending.slice(0, end));
    pending = pending.slice(end + 1);
    return value;
  }
  try {
    for (;;) {
      const message = await line();
      if (!isRecord(message)) throw new Error("Invalid Node refresh request bridge");
      if (message.kind === "result") {
        expect(message).toEqual({ kind: "result", steamSuccess: true, offers: { skipped: false, gamesChecked: 1, missingPrices: 0, unmapped: 0 } });
        break;
      }
      if (message.kind !== "request" || typeof message.url !== "string" || typeof message.method !== "string" || typeof message.body !== "string" || !isRecord(message.headers)) throw new Error("Invalid Node refresh request bridge");
      const headers = new Headers();
      for (const [key, value] of Object.entries(message.headers)) {
        if (typeof value !== "string") throw new Error("Invalid Node refresh header");
        headers.set(key, value);
      }
      const response = await harness.fetch(new Request(message.url, { method: message.method, headers, body: message.body }));
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((header, key) => { responseHeaders[key] = header; });
      child.stdin.write(JSON.stringify({ status: response.status, headers: responseHeaders, body: await response.text() }) + "\n");
    }
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect((await client.execute("SELECT is_owned, playtime_minutes FROM games WHERE steam_app_id=20")).rows).toEqual([{ is_owned: 1, playtime_minutes: 60 }]);
    expect(await getSyncState(client)).toMatchObject({ lastSuccessAt: start, gamesUpdated: 1, isRunning: false });
    expect((await client.execute("SELECT kind, offers_json FROM game_deal_cache WHERE steam_app_id=20 ORDER BY kind")).rows).toEqual([{ kind: "bundle", offers_json: "[]" }, { kind: "retail", offers_json: "[]" }]);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await reader.cancel();
    reader.releaseLock();
    await new Response(child.stderr).text();
  }
});
