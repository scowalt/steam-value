import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHttpClient } from "../src/db/http";
import { createDrizzleDb } from "../src/db/drizzle";
import { deleteGames, findGame, insertGames, readAllGames, syncManualWishlist } from "../src/db/manual";
import type { NewGame } from "../src/db/schema";
import { createD1WorkerTestHarness, type D1WorkerTestHarness } from "../src/db/testing";
import { createD1TransferSource, createD1TransferTarget, exportSnapshot, importSnapshot, inventorySource, prepareRollback, validateSnapshot, type FreezeRecord, type Snapshot, type TransferSource, type TransferTarget } from "../src/db/transfer";
import { syncSteamStatus, getSyncState } from "../src/services/steam-status-sync";
import { refreshGameDeals, type DealSource } from "../src/services/deal-refresh";
import { ItadError } from "../src/services/itad-errors";
import { getDealRefreshStatus, getGameDeals } from "../src/services/game-deals";
import type { DealOffer } from "../src/services/deal-types";
import type { GameDto, CityBuilderGameDto } from "../src/worker/games";
import { main as refreshCatalog } from "./refresh-steam-catalog";

const usage = "Usage: db:rehearse --local --destination <new-private-directory>";
const appIds = Array.from({ length: 500 }, (_, index) => index + 1);
const tags = '["City Builder", "é"]';
const createdAt = new Date("2023-11-14T22:13:20Z");
const updatedAt = new Date("2023-11-14T22:13:21Z");

function freeze(sourceId: string): FreezeRecord {
  return { mode: "frozen-writers", sourceId, recordId: `synthetic-${sourceId}`, frozenAt: Math.floor(Date.now() / 1000),
    evidence: "Synthetic disposable D1; every rehearsal writer awaited; no scheduled or external writers",
    writersPaused: ["synthetic-rehearsal"], writersDrained: ["synthetic-rehearsal"], manualWritersDrained: true, holdsUntilRelease: true };
}

function offer(kind: "retail" | "bundle", now: number): DealOffer {
  return { kind, id: `${kind}:synthetic`, title: "Synthetic offer", store: "Synthetic store", url: "https://offers.invalid/synthetic",
    priceCents: 500, currency: "USD", discountPercent: kind === "retail" ? 50 : null,
    drm: ["Steam"], voucher: null, note: "Synthetic é", expiresAt: null, validUntil: now + 86400 };
}

function game(steamAppId: number): NewGame {
  return { steamAppId, name: `Synthetic ${steamAppId}`, steamReviewScore: 95, steamReviewCount: 1234, hltbId: 23,
    hltbMain: 12.5, hltbMainExtra: null, hltbCompletionist: 40.25, valueScore: 1000 - steamAppId,
    isEndless: false, isOnWishlist: steamAppId === 1, isEarlyAccess: steamAppId === 1 ? null : false,
    controllerSupport: "full", releaseDate: "2020-01-02", isOwned: steamAppId === 1, playtimeMinutes: steamAppId === 1 ? 45 : null,
    isIgnored: false, hasSinglePlayer: true, hasMultiplayer: false, hasCoOp: true, hasOnlineCoOp: true, hasLocalCoOp: false,
    hasPvP: false, hasOnlinePvP: false, hasLocalPvP: false, hasCrossplatform: true, isMMO: false, tags, createdAt, updatedAt };
}

async function seed(harness: D1WorkerTestHarness, now: number) {
  const client = createHttpClient(harness.clientConfig);
  const inserted = await insertGames(createDrizzleDb(client), appIds.map(game));
  assert.deepEqual(inserted.map((row) => row.steamAppId), appIds);
  await client.batch([
    "INSERT INTO games (id, steam_app_id, name) VALUES (900, 900, 'Synthetic deleted allocation')",
    "DELETE FROM games WHERE id = 900",
    { sql: "INSERT INTO sync_state (key, last_success_at, owned_count, wishlist_count, updated_at) VALUES ('steam_status', ?, 1, 1, ?)", args: [now - 1, now] },
    { sql: "INSERT INTO sync_state (key, updated_at) VALUES (NULL, ?)", args: [now] },
    { sql: "INSERT INTO sync_state (key, updated_at) VALUES (NULL, ?)", args: [now - 1] },
    { sql: "INSERT INTO catalog_refresh_state (key, last_app_id, started_at, apps_seen, processed_count, inserted_count, updated_count, failed_count) VALUES ('steam_official_catalog', 500, ?, 12, 3, 1, 1, 1)", args: [now] },
    { sql: "INSERT INTO catalog_refresh_failures VALUES (9999, 'Synthetic orphan', 'Synthetic review unavailable', 3, ?)", args: [now] },
    { sql: "INSERT INTO itad_game_map VALUES (9999, NULL, ?)", args: [now] },
    { sql: "INSERT INTO game_deal_cache VALUES (9999, 'GB', 'retail', ?, '[]')", args: [now] },
    { sql: "INSERT INTO deal_refresh_state VALUES ('US', ?, ?, 'Synthetic previous failure', 'synthetic-abandoned', ?, 500)", args: [now - 2, now - 2, now - 1] },
    "INSERT INTO deal_refresh_state (country, last_error) VALUES ('GB', 'Synthetic retained error')",
  ]);
  const statements = appIds.flatMap((id) => [
    { sql: "INSERT INTO itad_game_map VALUES (?, ?, ?)", args: [id, `synthetic-${id}`, now] },
    { sql: "INSERT INTO game_deal_cache VALUES (?, 'US', 'retail', ?, ?)", args: [id, now, JSON.stringify([offer("retail", now)])] },
    { sql: "INSERT INTO game_deal_cache VALUES (?, 'US', 'bundle', ?, '[]')", args: [id, now] },
  ]);
  for (let offset = 0; offset < statements.length; offset += 400) await client.batch(statements.slice(offset, offset + 400));
}

async function verify(harness: D1WorkerTestHarness, now: number, postCutover: boolean) {
  const client = createHttpClient(harness.clientConfig);
  const db = createDrizzleDb(client);
  const read = async <T>(path: string): Promise<T> => {
    const response = await harness.fetch(`https://d1-test.invalid${path}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  for (const size of [100, 500]) {
    const page = await read<GameDto[]>(`/api/games?limit=${size}`);
    assert.deepEqual(page.map((row) => row.steamAppId), appIds.slice(0, size));
    assert.equal(page[0]?.hltbMain, 12.5);
    assert.equal(page[0]?.isOwned, true);
    assert.equal(page[0]?.createdAt, 1700000000);
    assert.equal(page[0]?.tags, tags);
    assert.ok(page.every((row) => row.deals.status === "fresh"));
  }
  const onSale = await read<GameDto[]>("/api/games?limit=500&onSale=true");
  assert.deepEqual(onSale.map((row) => row.steamAppId), postCutover ? [2, 3] : appIds);
  const city = await read<CityBuilderGameDto[]>("/api/city-builders");
  assert.equal(city[0]?.steam_app_id, 1);
  assert.equal(city[0]?.tag_rank, 1);
  assert.equal(city[0]?.weighted_score, 999);
  const typed = await findGame(db, 1);
  assert.ok(typed);
  assert.equal(typed.hltbMainExtra, null);
  assert.equal(typed.hltbCompletionist, 40.25);
  assert.equal(typed.isEarlyAccess, null);
  assert.deepEqual(typed.createdAt, createdAt);
  if (!postCutover) assert.deepEqual(typed.updatedAt, updatedAt);
  assert.equal((await readAllGames(db)).length, postCutover ? 501 : 500);
  assert.deepEqual((await client.execute("SELECT COUNT(*) AS total FROM sync_state WHERE key IS NULL")).rows, [{ total: 2 }]);
  const status = await read<Awaited<ReturnType<typeof getSyncState>>>("/api/sync-state");
  assert.equal(status?.lastSuccessAt, postCutover ? now : now - 1);
  assert.equal(status?.ownedCount, postCutover ? 2 : 1);
  const catalog = await client.execute("SELECT last_app_id, failed_count, completed_at IS NOT NULL AS completed FROM catalog_refresh_state WHERE key = 'steam_official_catalog'");
  assert.deepEqual(catalog.rows, [{ last_app_id: postCutover ? 9999 : 500, failed_count: postCutover ? 2 : 1, completed: postCutover ? 1 : 0 }]);
  assert.deepEqual((await client.execute("SELECT attempts FROM catalog_refresh_failures WHERE steam_app_id = 9999")).rows, [{ attempts: postCutover ? 4 : 3 }]);
  const state = await read<Awaited<ReturnType<typeof getDealRefreshStatus>>>("/api/deal-state");
  assert.equal(state.isRunning, false);
  assert.equal(state.gamesChecked, 500);
  assert.deepEqual((await client.execute("SELECT m.itad_id, c.country, c.offers_json FROM itad_game_map m JOIN game_deal_cache c ON c.steam_app_id = m.steam_app_id WHERE m.steam_app_id = 9999")).rows, [{ itad_id: null, country: "GB", offers_json: "[]" }]);
  return { passed: ["viewer", "steam-status", "catalog-facts", "offers"] };
}

async function importedWorker(snapshot: Snapshot, directory: string, label: string, now: number, postCutover: boolean) {
  let target: TransferTarget | undefined;
  const harness: D1WorkerTestHarness = await createD1WorkerTestHarness({ operatorSetup: async (binding) => {
    target = createD1TransferTarget(binding, { id: label, intent: "staging", freezeRecord: freeze(label), receiptPath: join(directory, `${label}.json`),
      verifyBehavior: () => verify(harness, now, postCutover) });
    await importSnapshot(target, snapshot);
  } });
  if (!target) { await harness.dispose(); throw new Error("Missing explicit synthetic transfer target"); }
  return { harness, target };
}

async function runWriters(harness: D1WorkerTestHarness, now: number) {
  const client = createHttpClient(harness.clientConfig);
  const db = createDrizzleDb(client);
  const source = { userData: async () => ({ rgOwnedApps: [1, 2], rgWishlist: [1], rgIgnoredApps: {} }),
    library: async () => ({ ownedGames: new Map([[1, 30], [2, 120]]), recentlyPlayedGames: new Map<number, number>() }) };
  assert.equal((await syncSteamStatus(client, {}, { source, now: () => now })).success, true);
  assert.equal((await findGame(db, 1))?.playtimeMinutes, 45);
  const rejected = await syncSteamStatus(client, {}, { source: { ...source, userData: async () => ({ rgOwnedApps: [], rgWishlist: [], rgIgnoredApps: {} }) }, now: () => now + 1 });
  assert.equal(rejected.success, false);
  assert.equal((await getSyncState(client))?.lastSuccessAt, now);
  assert.equal((await findGame(db, 2))?.playtimeMinutes, 120);
  const provider: DealSource = { lookup: async (ids) => new Map(ids.map((id) => [id, `synthetic-${id}`])),
    prices: async (ids) => new Map(ids.map((id) => [id, id === "synthetic-2" ? [offer("retail", now)] : []])),
    bundles: async () => ({ fetchedAt: now, games: new Map([["synthetic-3", [offer("bundle", now)]]]) }) };
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = refreshGameDeals(client, { ...provider, bundles: async (country) => { ready.resolve(); await release.promise; return provider.bundles(country); } }, { now: () => now });
  try {
    await ready.promise;
    assert.equal((await getDealRefreshStatus(client, now)).isRunning, true);
    assert.equal((await refreshGameDeals(client, provider, { now: () => now })).skipped, true);
    release.resolve();
    assert.deepEqual(await first, { skipped: false, gamesChecked: 500, missingPrices: 0, unmapped: 0 });
  } finally { release.resolve(); await first.catch(() => undefined); }
  await assert.rejects(refreshGameDeals(client, { ...provider, prices: async () => { throw new ItadError("UNAVAILABLE"); } }, { now: () => now + 1 }), /ITAD unavailable/);
  assert.equal((await getDealRefreshStatus(client, now + 1)).lastSuccessAt, now);
  const missing = await refreshGameDeals(client, { ...provider, prices: async (ids) => new Map(ids.filter((id) => id !== "synthetic-2").map((id) => [id, []])) }, { now: () => now + 2 });
  assert.equal(missing.missingPrices, 1);
  assert.deepEqual((await getGameDeals(client, [2], now + 2)).get(2)?.offers, [offer("retail", now)]);
  assert.equal((await client.execute("SELECT checked_at FROM game_deal_cache WHERE steam_app_id=2 AND country='US' AND kind='retail'")).rows[0]?.checked_at, now);
  const wishlist = new Set(appIds.slice(0, 123));
  await syncManualWishlist(db, wishlist);
  assert.deepEqual((await readAllGames(db)).filter((row) => row.isOnWishlist).map((row) => row.steamAppId), appIds.slice(0, 123));
  const added = await insertGames(db, Array.from({ length: 205 }, (_, index) => game(2000 + index)));
  assert.deepEqual(added.map((row) => row.id), Array.from({ length: 205 }, (_, index) => 901 + index));
  assert.equal(await deleteGames(db, added.map((row) => row.id)), 205);
  assert.equal((await readAllGames(db)).length, 500);
  await refreshCatalog(["--review-delay-ms", "0", "--checkpoint-every", "1"], { client, provider: {
    fetchAppList: async (_options, cursor) => { assert.equal(cursor, 500); return [{ appid: 501, name: "Synthetic new catalog game" }, { appid: 9999, name: "Synthetic orphan" }]; },
    fetchReviewSummary: async (app) => { if (app.appid === 9999) throw new Error("Synthetic review unavailable"); return { totalReviews: 100, totalPositive: 90, totalNegative: 10 }; },
  } });
  assert.equal((await findGame(db, 501))?.id, 1106);
}

export async function main(argv: string[]) {
  if (argv.length !== 3 || argv[0] !== "--local" || argv[1] !== "--destination" || !argv[2] || argv[2].startsWith("--")) throw new Error(usage);
  const directory = resolve(argv[2]);
  const now = Math.floor(Date.now() / 1000);
  let frozenSource: (() => TransferSource) | undefined;
  const original = await createD1WorkerTestHarness({ operatorSetup: async (binding) => {
    frozenSource = () => createD1TransferSource(binding, { id: "synthetic-before-cutover", freezeRecord: freeze("synthetic-before-cutover") });
  } });
  try {
    await seed(original, now);
    assert.ok(frozenSource);
    const source = frozenSource();
    await verify(original, now, false);
    await inventorySource(source, directory);
    const baseline = await exportSnapshot(source, join(directory, "baseline"), source.freezeRecord);
    const imported = await importedWorker(baseline, directory, "import", now, false);
    try {
      const validation = await validateSnapshot(imported.target, baseline);
      await runWriters(imported.harness, now);
      const post = createD1TransferSource(imported.target.binding, { id: "synthetic-after-cutover", freezeRecord: freeze("synthetic-after-cutover") });
      const recovery = await prepareRollback(post, baseline, join(directory, "recovery"));
      assert.equal(recovery.status, "reconciliation-required");
      assert.equal(recovery.automaticReversion, false);
      const current = { directory: join(directory, "recovery"), manifest: await Bun.file(join(directory, "recovery", "manifest.json")).json() };
      const restored = await importedWorker(current, directory, "restore", now, true);
      try {
        const restoredValidation = await validateSnapshot(restored.target, current);
        const after = await inventorySource(restored.target);
        assert.deepEqual((await inventorySource(source)).tables, baseline.manifest.tables);
        const report = { scope: "isolated-local", schemaStatus: "provisional-source-schema", destination: directory,
          baseline: { status: validation.status, tableRows: Object.fromEntries(baseline.manifest.tables.map((table) => [table.name, table.rowCount])), highWater: 900 },
          recovery: { status: recovery.status, automaticReversion: recovery.automaticReversion, sequenceChanged: recovery.sequenceChanged, delta: recovery.delta },
          restore: { status: restoredValidation.status, tableRows: Object.fromEntries(after.tables.map((table) => [table.name, table.rowCount])), highWater: after.sequence[0]?.seq } };
        assert.deepEqual(baseline.manifest.sequence, [{ name: "games", seq: 900 }]);
        assert.deepEqual(after.sequence, [{ name: "games", seq: 1106 }]);
        const file = await open(join(directory, "summary.json"), "wx", 0o600);
        try { await file.writeFile(JSON.stringify(report)); await file.sync(); } finally { await file.close(); }
        return report;
      } finally { await restored.harness.dispose(); }
    } finally { await imported.harness.dispose(); }
  } finally { await original.dispose(); }
}

if (import.meta.main) {
  if (process.argv.slice(2).join(" ") === "--help") console.log(usage);
  else main(process.argv.slice(2)).then((report) => console.log(JSON.stringify(report))).catch(() => {
    console.error("Synthetic local D1 rehearsal failed; retain protected artifacts for inspection. " + usage);
    process.exitCode = 1;
  });
}
