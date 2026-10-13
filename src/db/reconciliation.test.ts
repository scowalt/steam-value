import { afterAll, beforeAll, expect, test } from "bun:test";
import { createLocalD1, type LocalD1Owner } from "./local-d1";
import { applyMigrations, loadMigrations, migrationChecksum } from "./migrations";
import { createD1TransferSource, createD1TransferTarget, exportSnapshot, importSnapshot, inventorySource, prepareRollback, validateSnapshot, type FreezeRecord, type TransferTarget } from "./transfer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createD1WorkerTestHarness, type D1WorkerTestHarness } from "./testing";
import { createHttpClient } from "./http";
import { createDrizzleDb } from "./drizzle";

let owner: LocalD1Owner;
let nextDatabase = 0;
const directories: string[] = [];

beforeAll(async () => {
  owner = await createLocalD1({ databaseNames: Array.from({ length: 100 }, (_, index) => `RECONCILIATION_${index}`) });
});

afterAll(async () => {
  await owner.dispose();
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function emptyBinding() {
  return owner.getBinding(`RECONCILIATION_${nextDatabase++}`);
}

function freeze(sourceId: string): FreezeRecord {
  return { mode: "frozen-writers", sourceId, recordId: "synthetic-reconciliation", frozenAt: 1700000000,
    evidence: "Synthetic isolated native D1; no external writers", writersPaused: ["fixture"], writersDrained: ["fixture"],
    manualWritersDrained: true, holdsUntilRelease: true };
}

async function legacyBinding(sql?: string) {
  const binding = await emptyBinding();
  const ddl = sql ?? await Bun.file(new URL("../../schemas/legacy-source-v1.sql", import.meta.url)).text();
  await binding.batch(ddl.split(";").map((statement) => statement.trim()).filter(Boolean).map((statement) => binding.prepare(statement)));
  return binding;
}

async function preparedBinding() {
  const binding = await emptyBinding();
  await applyMigrations(binding, await loadMigrations());
  return binding;
}

async function artifactPath(name: string) {
  const directory = await mkdtemp(join(tmpdir(), "steam-value-reconciliation-"));
  directories.push(directory);
  return join(directory, name);
}

async function populatedLegacy() {
  const binding = await legacyBinding();
  await binding.batch([
    binding.prepare(`INSERT INTO games VALUES (4,101,'Legacy β; game',94,1200,23,12.25,NULL,39.5,7.5,1700000000,1700000001,0,1,NULL,'full','2020-01-02',1,45,1,0,1,0,1,0,1,0,1,NULL,0,'[ "City Builder", "β" ]')`),
    binding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (17,102,'Defaults')"),
    binding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (950,103,'Deleted allocation')"),
    binding.prepare("DELETE FROM games WHERE id = 950"),
    binding.prepare("INSERT INTO sync_state VALUES ('steam_status',1700000010,1700000009,'Synthetic failure',1,1700000910,2,3,4,5,6,1700000010)"),
    binding.prepare("INSERT INTO sync_state (key,updated_at) VALUES (NULL,1700000011)"),
    binding.prepare("INSERT INTO sync_state (key,updated_at) VALUES (NULL,1700000012)"),
    binding.prepare("INSERT INTO catalog_refresh_state VALUES ('steam_official_catalog',102,1700000000,NULL,100,12,11,3,4,1,2,1,NULL,1700000010)"),
    binding.prepare("INSERT INTO catalog_refresh_failures VALUES (1999,'Orphan Catalog Facts','Synthetic retry',3,1700000010)"),
    binding.prepare("INSERT INTO itad_game_map VALUES (101,'synthetic-itad',1700000000)"),
    binding.prepare("INSERT INTO itad_game_map VALUES (1999,NULL,1700000001)"),
    binding.prepare("INSERT INTO game_deal_cache VALUES (101,'US','retail',1700000000,'[]')"),
    binding.prepare(`INSERT INTO game_deal_cache VALUES (1999,'GB','bundle',1700000001,'[ {"validUntil":1700086400,"priceCents":null} ]')`),
    binding.prepare("INSERT INTO deal_refresh_state VALUES ('US',1700000010,1700000000,NULL,'synthetic-lock',1700000910,2)"),
    binding.prepare("INSERT INTO deal_refresh_state VALUES ('GB',NULL,NULL,'Synthetic error',NULL,NULL,0)"),
    binding.prepare("INSERT INTO __drizzle_migrations (rowid,id,hash,created_at) VALUES (-7,NULL,'synthetic first',NULL)"),
    binding.prepare("INSERT INTO __drizzle_migrations (rowid,id,hash,created_at) VALUES (5,NULL,'synthetic second',12.5)"),
    binding.prepare("INSERT INTO __drizzle_migrations (rowid,id,hash,created_at) VALUES (9,'legacy-key','synthetic third','non-numeric')"),
  ]);
  return { binding, ...createD1TransferSource(binding, { id: "synthetic-legacy", freezeRecord: freeze("synthetic-legacy") }) };
}

test("explicit bootstrap retains both legacy games indexes and a nonempty SERIAL ledger without rewriting history", async () => {
  const binding = await emptyBinding();
  const migrations = await loadMigrations();
  await applyMigrations(binding, migrations);
  expect(migrations[0]?.checksum).toBe("bcb5a3738c65336b9af697be9816d3039edffd9da0ef627cc50da5ecf5d0a83a");
  expect((await binding.prepare("SELECT name FROM pragma_index_list('games') ORDER BY name").all()).results).toEqual([
    { name: "games_steam_app_id_unique" }, { name: "idx_games_browse_default" }, { name: "idx_games_browse_owned_playtime" },
    { name: "idx_games_status_filters" }, { name: "idx_games_steam_app_id" }, { name: "idx_games_value_score" },
  ]);
  expect((await binding.prepare("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_xinfo('__drizzle_migrations') ORDER BY cid").all()).results).toEqual([
    { name: "id", type: "SERIAL", notnull: 0, dflt_value: null, pk: 1 },
    { name: "hash", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "created_at", type: "numeric", notnull: 0, dflt_value: null, pk: 0 },
  ]);
  await binding.batch([
    binding.prepare("INSERT INTO __drizzle_migrations (rowid,id,hash,created_at) VALUES (-7,NULL,'synthetic first',NULL)"),
    binding.prepare("INSERT INTO __drizzle_migrations (rowid,id,hash,created_at) VALUES (5,NULL,'synthetic second',12.5)"),
    binding.prepare("INSERT INTO __drizzle_migrations (rowid,id,hash,created_at) VALUES (9,'legacy-key','synthetic third','non-numeric')"),
  ]);
  expect((await applyMigrations(binding, migrations)).alreadyApplied).toEqual(["0001_complete_schema.sql", "0002_retain_legacy_metadata.sql"]);
  expect((await binding.prepare("SELECT rowid,id,hash,created_at,typeof(created_at) AS storage FROM __drizzle_migrations ORDER BY rowid").all()).results).toEqual([
    { rowid: -7, id: null, hash: "synthetic first", created_at: null, storage: "null" },
    { rowid: 5, id: null, hash: "synthetic second", created_at: 12.5, storage: "real" },
    { rowid: 9, id: "legacy-key", hash: "synthetic third", created_at: "non-numeric", storage: "text" },
  ]);
});

test("inventory admits only the reviewed legacy structure and records nonidentical source and target schema evidence", async () => {
  const binding = await legacyBinding();
  const source = createD1TransferSource(binding, { id: "synthetic-legacy", freezeRecord: freeze("synthetic-legacy") });
  const inventory = await inventorySource(source);
  expect(inventory.schemaCompatibility).toMatchObject({ profile: "observed-legacy-v1", rawDdlIdentical: false, targetSchemaFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(inventory.sourceMigrationHistory).toBeNull();
  expect(inventory.schema.tables.map((table) => table.name)).toEqual([
    "__drizzle_migrations", "catalog_refresh_failures", "catalog_refresh_state", "deal_refresh_state", "game_deal_cache", "games", "itad_game_map", "sync_state",
  ]);
  const columns = inventory.schema.tables.find((table) => table.name === "games")!.columns;
  expect(columns.map((column) => column.name)).toEqual([
    "id", "steam_app_id", "name", "steam_review_score", "steam_review_count", "hltb_id", "hltb_main", "hltb_main_extra", "hltb_completionist", "value_score",
    "created_at", "updated_at", "is_endless", "is_on_wishlist", "is_early_access", "controller_support", "release_date", "is_owned", "playtime_minutes",
    "has_single_player", "has_multiplayer", "has_co_op", "has_online_co_op", "has_local_co_op", "has_pvp", "has_online_pvp", "has_local_pvp", "has_crossplatform", "is_mmo", "is_ignored", "tags",
  ]);
  expect(columns.filter((column) => column.dflt_value === "false").map((column) => [column.type, column.notnull])).toEqual(Array.from({ length: 15 }, () => ["INTEGER", 0]));
  expect(inventory.schema.tables.find((table) => table.name === "sync_state")!.columns.at(-1)).toMatchObject({ name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: "unixepoch()" });
});

test("reviewed legacy transfer preserves every typed cell and verifies the actual Worker and selected-field ORM contract", async () => {
  const source = await populatedLegacy();
  const snapshot = await exportSnapshot(source, await artifactPath("snapshot"), source.freezeRecord);
  const rows = (await Bun.file(join(snapshot.directory, "games.jsonl")).text()).trim().split("\n").map((line) => JSON.parse(line));
  expect(rows[0]).toEqual({ rowid: 4, values: [
    ["integer",4],["integer",101],["text","Legacy β; game"],["integer",94],["integer",1200],["integer",23],
    ["real",12.25],["null",null],["real",39.5],["real",7.5],["integer",0],["integer",1],["null",null],
    ["text","full"],["text","2020-01-02"],["integer",1],["integer",45],["integer",0],["integer",1],["integer",0],
    ["integer",1],["integer",0],["integer",1],["integer",0],["integer",1],["integer",0],["integer",1],["null",null],
    ["text",'[ "City Builder", "β" ]'],["integer",1700000000],["integer",1700000001],
  ] });
  expect(snapshot.manifest.tables.map((table) => [table.name, table.rowCount])).toEqual([
    ["__drizzle_migrations",3],["catalog_refresh_failures",1],["catalog_refresh_state",1],["deal_refresh_state",2],
    ["game_deal_cache",2],["games",2],["itad_game_map",2],["sync_state",3],
  ]);
  let target: TransferTarget | undefined;
  let harness: D1WorkerTestHarness;
  const receiptPath = await artifactPath("import.json");
  harness = await createD1WorkerTestHarness({ operatorSetup: async (binding) => {
    target = createD1TransferTarget(binding, { id: "synthetic-target", intent: "staging", freezeRecord: freeze("synthetic-target"), receiptPath,
      verifyBehavior: async () => {
        const client = createHttpClient(harness.clientConfig);
        const response = await harness.fetch("https://d1-test.invalid/api/games?limit=100");
        expect(response.status).toBe(200);
        const viewerRows: unknown = await response.json();
        expect(viewerRows).toEqual([expect.objectContaining({ id: 4, steamAppId: 101, name: "Legacy β; game", hltbMain: 12.25, isOwned: true, createdAt: 1700000000, tags: '[ "City Builder", "β" ]' })]);
        const db = createDrizzleDb(client);
        expect(await db.query.games.findFirst({ columns: { tags: true, createdAt: true, isOwned: true, isEarlyAccess: true, name: true, hltbMain: true } })).toEqual({
          tags: '[ "City Builder", "β" ]', createdAt: new Date("2023-11-14T22:13:20Z"), isOwned: true, isEarlyAccess: null, name: "Legacy β; game", hltbMain: 12.25,
        });
        expect((await client.execute("SELECT created_at AS time,name AS title,is_owned AS owned FROM games WHERE id = 4")).columns).toEqual(["time","title","owned"]);
        expect((await client.execute("SELECT is_owned,is_early_access,created_at,updated_at FROM games WHERE id = 17")).rows).toEqual([{ is_owned: 0, is_early_access: 0, created_at: null, updated_at: null }]);
        expect((await client.execute("SELECT is_running,owned_count,lock_expires_at FROM sync_state WHERE key = 'steam_status'")).rows).toEqual([{ is_running: 1, owned_count: 4, lock_expires_at: 1700000910 }]);
        expect((await client.execute("SELECT COUNT(*) AS total FROM sync_state WHERE key IS NULL")).rows).toEqual([{ total: 2 }]);
        expect((await client.execute("SELECT last_app_id,completed_at,failed_count FROM catalog_refresh_state")).rows).toEqual([{ last_app_id: 102, completed_at: null, failed_count: 1 }]);
        expect((await client.execute("SELECT attempts FROM catalog_refresh_failures WHERE steam_app_id = 1999")).rows).toEqual([{ attempts: 3 }]);
        expect((await client.execute("SELECT m.itad_id,c.offers_json FROM itad_game_map m JOIN game_deal_cache c ON c.steam_app_id=m.steam_app_id WHERE c.country='GB'")).rows).toEqual([{ itad_id: null, offers_json: '[ {"validUntil":1700086400,"priceCents":null} ]' }]);
        expect((await client.execute("SELECT offers_json FROM game_deal_cache WHERE country='US'")).rows).toEqual([{ offers_json: "[]" }]);
        expect((await client.execute("SELECT lock_token,games_checked FROM deal_refresh_state WHERE country='US'")).rows).toEqual([{ lock_token: "synthetic-lock", games_checked: 2 }]);
        expect((await client.execute("SELECT rowid,id,hash,created_at,typeof(created_at) AS storage FROM __drizzle_migrations ORDER BY rowid")).rows).toEqual([
          { rowid: -7, id: null, hash: "synthetic first", created_at: null, storage: "null" },
          { rowid: 5, id: null, hash: "synthetic second", created_at: 12.5, storage: "real" },
          { rowid: 9, id: "legacy-key", hash: "synthetic third", created_at: "non-numeric", storage: "text" },
        ]);
        return { passed: ["viewer", "steam-status", "catalog-facts", "offers"] };
      } });
    await importSnapshot(target, snapshot);
  } });
  try {
    if (!target) throw new Error("Missing explicit target");
    const validation = await validateSnapshot(target, snapshot);
    expect(validation).toMatchObject({ status: "validated", tableCount: 8, sourceSchemaFingerprint: snapshot.manifest.schemaFingerprint,
      schemaFingerprint: snapshot.manifest.schemaCompatibility.targetSchemaFingerprint, schemaCompatibility: snapshot.manifest.schemaCompatibility });
    expect((await createHttpClient(harness.clientConfig).execute("INSERT INTO games (steam_app_id,name) VALUES (104,'After high-water') RETURNING id")).rows).toEqual([{ id: 951 }]);
  } finally { await harness.dispose(); }
});

test("a lost sequence-only native write reply is uncertain, cannot validate or replay, and requires a fresh target", async () => {
  const sourceBinding = await legacyBinding();
  await sourceBinding.batch([
    sourceBinding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (950,103,'Deleted only')"),
    sourceBinding.prepare("DELETE FROM games"),
  ]);
  const source = createD1TransferSource(sourceBinding, { id: "synthetic-deleted-only", freezeRecord: freeze("synthetic-deleted-only") });
  const snapshot = await exportSnapshot(source, await artifactPath("deleted-only"), source.freezeRecord);
  const binding = await preparedBinding();
  const lostReply = new Proxy(binding, { get(native, key) {
    if (key === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => {
      await native.batch(statements);
      throw new Error("Synthetic unsafe reply details");
    };
    const value = Reflect.get(native, key, native);
    return typeof value === "function" ? value.bind(native) : value;
  } });
  const target = createD1TransferTarget(lostReply, { id: "uncertain-sequence", intent: "empty", freezeRecord: freeze("uncertain-sequence"), receiptPath: await artifactPath("lost.json") });
  await expect(importSnapshot(target, snapshot)).rejects.toMatchObject({ code: "TRANSFER_FAILED" });
  const receipt = await Bun.file(target.receiptPath).text();
  expect(JSON.parse(receipt)).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: "partial-or-unknown", errorCode: "TRANSFER_FAILED" });
  expect(receipt.includes("unsafe reply")).toBe(false);
  expect((await inventorySource(target)).sequence).toEqual([{ name: "games", seq: 950 }]);
  await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  const replay = createD1TransferTarget(binding, { id: "uncertain-sequence", intent: "staging", freezeRecord: freeze("uncertain-sequence"), receiptPath: await artifactPath("replay.json") });
  await expect(importSnapshot(replay, snapshot)).rejects.toMatchObject({ code: "TARGET_NOT_EMPTY" });
  const fresh = createD1TransferTarget(await preparedBinding(), { id: "fresh-sequence", intent: "empty", freezeRecord: freeze("fresh-sequence"), receiptPath: await artifactPath("fresh.json") });
  expect((await importSnapshot(fresh, snapshot)).status).toBe("imported");
  expect((await inventorySource(fresh)).sequence).toEqual([{ name: "games", seq: 950 }]);
}, 15000);

test("legacy exports explicitly distinguish canonical data columns from observed physical columns", async () => {
  const source = await populatedLegacy();
  const snapshot = await exportSnapshot(source, await artifactPath("columns"), source.freezeRecord);
  expect(snapshot.manifest.tables.find((table) => table.name === "games")!.columns).toEqual([
    "id", "steam_app_id", "name", "steam_review_score", "steam_review_count", "hltb_id", "hltb_main", "hltb_main_extra", "hltb_completionist", "value_score",
    "is_endless", "is_on_wishlist", "is_early_access", "controller_support", "release_date", "is_owned", "playtime_minutes", "is_ignored",
    "has_single_player", "has_multiplayer", "has_co_op", "has_online_co_op", "has_local_co_op", "has_pvp", "has_online_pvp", "has_local_pvp", "has_crossplatform", "is_mmo", "tags", "created_at", "updated_at",
  ]);
  expect(snapshot.manifest.schema.tables.find((table) => table.name === "games")!.columns[10]!.name).toBe("created_at");
});

test("appending the retained objects is atomic and preserves all original table contents, high-water and receipts", async () => {
  const binding = await emptyBinding();
  const migrations = await loadMigrations();
  await applyMigrations(binding, migrations.slice(0, 1));
  await binding.batch([
    binding.prepare("INSERT INTO games (id,steam_app_id,name,is_owned,tags,created_at) VALUES (7,42,'Synthetic retained',NULL,'[ \"β\" ]',1700000000)"),
    binding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (950,43,'Deleted')"), binding.prepare("DELETE FROM games WHERE id=950"),
    binding.prepare("INSERT INTO sync_state (key,updated_at) VALUES (NULL,1700000000)"),
    binding.prepare("INSERT INTO catalog_refresh_state (key,updated_at) VALUES ('steam_official_catalog',1700000001)"),
    binding.prepare("INSERT INTO catalog_refresh_failures VALUES (1999,'Orphan','Synthetic',3,1700000002)"),
    binding.prepare("INSERT INTO itad_game_map VALUES (1999,NULL,1700000003)"),
    binding.prepare("INSERT INTO game_deal_cache VALUES (1999,'GB','retail',1700000004,'[]')"),
    binding.prepare("INSERT INTO deal_refresh_state (country) VALUES ('GB')"),
  ]);
  const tables = ["games","sync_state","catalog_refresh_state","catalog_refresh_failures","itad_game_map","game_deal_cache","deal_refresh_state","sqlite_sequence","steam_value_migrations"];
  const before = (await binding.batch(tables.map((table) => binding.prepare(`SELECT * FROM ${table} ORDER BY rowid`)))).map((result) => result.results);
  const sql = migrations[1]!.sql + "\nINSERT INTO absent_table VALUES (1);";
  await expect(applyMigrations(binding, [migrations[0]!, { ...migrations[1]!, sql, checksum: await migrationChecksum(sql) }])).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
  expect((await binding.batch(tables.map((table) => binding.prepare(`SELECT * FROM ${table} ORDER BY rowid`)))).map((result) => result.results)).toEqual(before);
  expect((await binding.prepare("SELECT name FROM sqlite_schema WHERE name IN ('__drizzle_migrations','idx_games_status_filters','idx_games_value_score')").all()).results).toEqual([]);
  expect(await applyMigrations(binding, migrations)).toMatchObject({ applied: ["0002_retain_legacy_metadata.sql"], alreadyApplied: ["0001_complete_schema.sql"] });
  const after = (await binding.batch(tables.map((table) => binding.prepare(`SELECT * FROM ${table} ORDER BY rowid`)))).map((result) => result.results);
  expect(after.slice(0, 8)).toEqual(before.slice(0, 8));
  expect(after[8]![0]).toEqual(before[8]![0]);
  expect(after[8]).toHaveLength(2);
  const changed = migrations[1]!.sql + "\nCREATE TABLE unreviewed_history (id INTEGER);";
  await expect(applyMigrations(binding, [migrations[0]!, { ...migrations[1]!, sql: changed, checksum: await migrationChecksum(changed) }])).rejects.toMatchObject({ code: "MIGRATION_CHANGED" });
  await expect(applyMigrations(binding, [migrations[0]!, { ...migrations[1]!, checksum: "0".repeat(64) }])).rejects.toMatchObject({ code: "INVALID_MIGRATION" });
  expect((await binding.prepare("SELECT name FROM sqlite_schema WHERE name='unreviewed_history'").all()).results).toEqual([]);
});

const legacyDrift = [
  { name: "extra table", sql: "CREATE TABLE unreviewed_operational (id INTEGER)" },
  { name: "missing original table", sql: "DROP TABLE sync_state" },
  { name: "missing legacy ledger", sql: "DROP TABLE __drizzle_migrations" },
  { name: "missing legacy index", sql: "DROP INDEX idx_games_status_filters" },
  { name: "trigger lookalike", sql: "CREATE TRIGGER unreviewed_trigger AFTER INSERT ON games BEGIN UPDATE games SET is_owned=1 WHERE id=new.id; END" },
  { name: "view lookalike", sql: "CREATE VIEW unreviewed_view AS SELECT * FROM games" },
  { name: "extra column", sql: "ALTER TABLE sync_state ADD COLUMN unknown_clock INTEGER" },
  { name: "changed type", from: "hltb_main REAL", to: "hltb_main numeric" },
  { name: "changed default", from: "is_owned INTEGER DEFAULT false", to: "is_owned INTEGER DEFAULT 0" },
  { name: "equivalent unreviewed default spelling", from: "is_owned INTEGER DEFAULT false", to: "is_owned INTEGER DEFAULT FALSE" },
  { name: "changed nullability", from: "name TEXT NOT NULL", to: "name TEXT" },
  { name: "changed game constraint", from: "steam_app_id INTEGER NOT NULL", to: "steam_app_id INTEGER NOT NULL CHECK(steam_app_id>0)" },
  { name: "changed offer constraint", from: "CHECK(json_valid(offers_json))", to: "CHECK(1)" },
  { name: "changed predicate", from: "AND is_ignored = 0", to: "AND is_ignored = 1" },
  { name: "changed index direction", from: "ON games(value_score DESC);", to: "ON games(value_score ASC);" },
  { name: "changed index collation", from: "is_mmo, is_owned);", to: "is_mmo, is_owned COLLATE NOCASE);" },
  { name: "foreign key", from: "steam_app_id INTEGER PRIMARY KEY,\n    itad_id", to: "steam_app_id INTEGER PRIMARY KEY REFERENCES games(steam_app_id),\n    itad_id" },
  { name: "ledger type lookalike", from: "id SERIAL PRIMARY KEY", to: "id INTEGER PRIMARY KEY" },
  { name: "ledger constraint lookalike", from: "hash TEXT NOT NULL", to: "hash TEXT" },
  { name: "unreviewed formatting", from: "CREATE TABLE sync_state (", to: "CREATE TABLE sync_state  (" },
  { name: "table flag lookalike", from: "PRIMARY KEY(steam_app_id, country, kind)\n);", to: "PRIMARY KEY(steam_app_id, country, kind)\n) WITHOUT ROWID;" },
];

test.each(legacyDrift)("legacy reconciliation refuses $name rather than normalizing or dropping it", async (drift) => {
  const ddl = await Bun.file(new URL("../../schemas/legacy-source-v1.sql", import.meta.url)).text();
  const binding = await legacyBinding("from" in drift ? ddl.replace(drift.from!, drift.to!) : ddl);
  if ("sql" in drift) await binding.prepare(drift.sql!).run();
  const source = createD1TransferSource(binding, { id: "synthetic-drift", freezeRecord: freeze("synthetic-drift") });
  await expect(inventorySource(source)).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
});

test.each(["lost", "cancelled"])("a %s native ledger-import reply leaves a partial target that cannot validate or append", async (kind) => {
  const source = await populatedLegacy();
  const snapshot = await exportSnapshot(source, await artifactPath("ledger"), source.freezeRecord);
  const binding = await preparedBinding();
  const controller = new AbortController();
  const uncertain = new Proxy(binding, { get(native, key) {
    if (key === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => {
      const result = await native.batch(statements);
      if (kind === "lost") throw new Error("Synthetic unsafe ledger reply");
      controller.abort(); return result;
    };
    const value = Reflect.get(native, key, native);
    return typeof value === "function" ? value.bind(native) : value;
  } });
  const target = createD1TransferTarget(uncertain, { id: "partial-ledger", intent: "staging", freezeRecord: freeze("partial-ledger"), receiptPath: await artifactPath("partial.json"), signal: controller.signal });
  await expect(importSnapshot(target, snapshot)).rejects.toMatchObject({ code: kind === "lost" ? "TRANSFER_FAILED" : "INCOMPLETE_IMPORT" });
  expect(await Bun.file(target.receiptPath).json()).toMatchObject({ status: "incomplete", writeOutcome: "partial-or-unknown", confirmedRows: { __drizzle_migrations: kind === "lost" ? 0 : 3 } });
  expect((await inventorySource(target)).tables.find((table) => table.name === "__drizzle_migrations")!.rowCount).toBe(3);
  await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  const replay = createD1TransferTarget(binding, { id: "partial-ledger", intent: "empty", freezeRecord: freeze("partial-ledger"), receiptPath: await artifactPath("append.json") });
  await expect(importSnapshot(replay, snapshot)).rejects.toMatchObject({ code: "TARGET_NOT_EMPTY" });
});

test("cross-profile recovery records no phantom column-order changes and validates preserved post-import ledger and application writes on a fresh Worker", async () => {
  const source = await populatedLegacy();
  const baseline = await exportSnapshot(source, await artifactPath("baseline"), source.freezeRecord);
  const target = createD1TransferTarget(await preparedBinding(), { id: "post-import", intent: "staging", freezeRecord: freeze("post-import"), receiptPath: await artifactPath("import.json") });
  await importSnapshot(target, baseline);
  expect(await inventorySource(target)).toMatchObject({ tables: baseline.manifest.tables, sequence: [{ name: "games", seq: 950 }], schemaCompatibility: { profile: "prepared-d1-v2", rawDdlIdentical: true } });
  const unchanged = await prepareRollback(target, baseline, await artifactPath("unchanged"));
  expect(unchanged).toMatchObject({ status: "reconciliation-required", automaticReversion: false, sequenceChanged: false });
  expect(Object.values(unchanged.delta)).toEqual(Array.from({ length: 8 }, () => ({ added: 0, deleted: 0, changed: 0 })));
  await target.binding.batch([
    target.binding.prepare("UPDATE games SET name='Changed after import' WHERE id=4"),
    target.binding.prepare("INSERT INTO games (steam_app_id,name) VALUES (104,'Added after import')"),
    target.binding.prepare("UPDATE catalog_refresh_failures SET attempts=4 WHERE steam_app_id=1999"),
    target.binding.prepare("DELETE FROM itad_game_map WHERE steam_app_id=1999"),
    target.binding.prepare("UPDATE __drizzle_migrations SET created_at=13.5 WHERE rowid=5"),
    target.binding.prepare("DELETE FROM __drizzle_migrations WHERE rowid=-7"),
    target.binding.prepare("INSERT INTO __drizzle_migrations (rowid,id,hash,created_at) VALUES (13,7,'synthetic new',1700000000)"),
  ]);
  const directory = await artifactPath("recovery");
  expect(await prepareRollback(target, baseline, directory)).toMatchObject({ status: "reconciliation-required", automaticReversion: false, sequenceChanged: true, delta: {
    __drizzle_migrations: { added: 1, deleted: 1, changed: 1 }, games: { added: 1, deleted: 0, changed: 1 },
    catalog_refresh_failures: { added: 0, deleted: 0, changed: 1 }, itad_game_map: { added: 0, deleted: 1, changed: 0 },
  } });
  const changes = (await Bun.file(join(directory, "reconciliation.jsonl")).text()).trim().split("\n").map((line) => JSON.parse(line));
  expect(changes.find((change) => change.table === "__drizzle_migrations" && change.rowid === 5)).toMatchObject({
    before: { values: [["null",null],["text","synthetic second"],["real",12.5]] }, after: { values: [["null",null],["text","synthetic second"],["real",13.5]] },
  });
  let restored: TransferTarget | undefined;
  let harness: D1WorkerTestHarness;
  const receiptPath = await artifactPath("restore.json");
  harness = await createD1WorkerTestHarness({ operatorSetup: async (binding) => {
    restored = createD1TransferTarget(binding, { id: "fresh-recovery", intent: "empty", freezeRecord: freeze("fresh-recovery"), receiptPath, verifyBehavior: async () => {
      const client = createHttpClient(harness.clientConfig);
      const response = await harness.fetch("https://d1-test.invalid/api/games");
      expect(response.status).toBe(200);
      const viewerRows: unknown = await response.json();
      expect(viewerRows).toEqual([expect.objectContaining({ id: 4, steamAppId: 101, name: "Changed after import", isOwned: true })]);
      expect((await client.execute("SELECT created_at FROM __drizzle_migrations WHERE rowid=5")).rows).toEqual([{ created_at: 13.5 }]);
      expect((await client.execute("SELECT is_running,lock_expires_at FROM sync_state WHERE key='steam_status'")).rows).toEqual([{ is_running: 1, lock_expires_at: 1700000910 }]);
      expect((await client.execute("SELECT attempts FROM catalog_refresh_failures WHERE steam_app_id=1999")).rows).toEqual([{ attempts: 4 }]);
      expect((await client.execute("SELECT offers_json FROM game_deal_cache WHERE steam_app_id=1999 AND country='GB'")).rows).toEqual([{ offers_json: '[ {"validUntil":1700086400,"priceCents":null} ]' }]);
      return { passed: ["viewer", "steam-status", "catalog-facts", "offers"] };
    } });
    await importSnapshot(restored, directory);
  } });
  try {
    if (!restored) throw new Error("Missing explicit recovery target");
    expect(await validateSnapshot(restored, directory)).toMatchObject({ status: "validated", tableCount: 8, schemaCompatibility: { profile: "prepared-d1-v2", rawDdlIdentical: true } });
    expect((await inventorySource(restored)).sequence).toEqual([{ name: "games", seq: 951 }]);
    expect(await inventorySource(source)).toMatchObject({ tables: baseline.manifest.tables, schema: baseline.manifest.schema, sequence: baseline.manifest.sequence });
    expect((await createHttpClient(harness.clientConfig).execute("INSERT INTO games (steam_app_id,name) VALUES (105,'Next restored allocation') RETURNING id")).rows).toEqual([{ id: 952 }]);
  } finally { await harness.dispose(); }
}, 15000);

test.each(["raw-equality", "profile", "target-fingerprint", "columns", "type", "ddl"])("snapshot readers refuse a re-signed unreviewed %s reconciliation claim before writes", async (kind) => {
  const source = await populatedLegacy();
  const snapshot = await exportSnapshot(source, await artifactPath("tamper"), source.freezeRecord);
  const manifestPath = join(snapshot.directory, "manifest.json");
  const manifest = await Bun.file(manifestPath).json();
  if (kind === "raw-equality") manifest.schemaCompatibility.rawDdlIdentical = true;
  if (kind === "profile") manifest.schemaCompatibility.profile = "prepared-d1-v2";
  if (kind === "target-fingerprint") manifest.schemaCompatibility.targetSchemaFingerprint = "0".repeat(64);
  if (kind === "columns") manifest.tables.find((table: { name: string }) => table.name === "games").columns.reverse();
  if (kind === "type") manifest.schema.tables.find((table: { name: string }) => table.name === "games").columns[0].type = "TEXT";
  if (kind === "ddl") manifest.schema.objects.find((object: { name: string }) => object.name === "game_deal_cache").sql = "CREATE TABLE game_deal_cache(steam_app_id INTEGER)";
  manifest.schemaFingerprint = await migrationChecksum(JSON.stringify(manifest.schema));
  await writeFile(manifestPath, JSON.stringify(manifest) + "\n");
  const receiptPath = join(snapshot.directory, "export-receipt.json");
  const receipt = await Bun.file(receiptPath).json();
  receipt.manifestDigest = await migrationChecksum(JSON.stringify(manifest));
  await writeFile(receiptPath, JSON.stringify(receipt) + "\n");
  const target = createD1TransferTarget(await preparedBinding(), { id: "tamper-target", intent: "empty", freezeRecord: freeze("tamper-target"), receiptPath: await artifactPath("import.json") });
  await expect(importSnapshot(target, snapshot)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  expect((await inventorySource(target)).tables.every((table) => table.rowCount === 0)).toBe(true);
});

test.each([
  { sql: "CREATE TABLE d1_migrations (payload TEXT)", bootstrapped: true },
  { sql: "CREATE TABLE d1_migrations (payload TEXT)", bootstrapped: false },
])("bootstrap refuses unreviewed metadata lookalikes rather than granting a name exemption: %j", async ({ sql, bootstrapped }) => {
  const binding = await emptyBinding();
  const migrations = await loadMigrations();
  if (bootstrapped) await applyMigrations(binding, migrations);
  await binding.prepare(sql).run();
  await expect(applyMigrations(binding, migrations)).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
});

test("native operator authorization refuses a reserved metadata lookalike and retains the explicit immutable bootstrap", async () => {
  const binding = await preparedBinding();
  await expect(binding.prepare("CREATE INDEX _cf_unreviewed ON games(name)").run()).rejects.toThrow(/not authorized/i);
  expect(await applyMigrations(binding, await loadMigrations())).toMatchObject({ applied: [], alreadyApplied: ["0001_complete_schema.sql", "0002_retain_legacy_metadata.sql"] });
});

test("bootstrap refuses an attached checksum-ledger trigger before append, preserving nonempty application state and immutable receipts before any dispatch", async () => {
  const binding = await emptyBinding();
  const migrations = await loadMigrations();
  await applyMigrations(binding, migrations.slice(0, 1));
  await binding.batch([
    binding.prepare("INSERT INTO games (id,steam_app_id,name,hltb_main,value_score,is_owned,tags,created_at) VALUES (7,42,'Synthetic retained β',12.25,42.5,NULL,'[ \"β\" ]',1700000000)"),
    binding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (950,43,'Deleted allocation')"), binding.prepare("DELETE FROM games WHERE id=950"),
    binding.prepare("INSERT INTO sync_state (key,updated_at) VALUES (NULL,1700000000)"),
    binding.prepare("INSERT INTO catalog_refresh_state (key,updated_at) VALUES ('steam_official_catalog',1700000001)"),
    binding.prepare("INSERT INTO catalog_refresh_failures VALUES (1999,'Synthetic orphan','Synthetic retry',3,1700000002)"),
    binding.prepare("INSERT INTO itad_game_map VALUES (1999,NULL,1700000003)"),
    binding.prepare("INSERT INTO game_deal_cache VALUES (1999,'GB','retail',1700000004,'[]')"),
    binding.prepare("INSERT INTO deal_refresh_state (country) VALUES ('GB')"),
  ]);
  const tables = ["games","sync_state","catalog_refresh_state","catalog_refresh_failures","itad_game_map","game_deal_cache","deal_refresh_state","sqlite_sequence","steam_value_migrations"];
  const contents = async () => (await binding.batch(tables.map((table) => binding.prepare(`SELECT * FROM ${table} ORDER BY rowid`)))).map((result) => result.results);
  const before = await contents();
  expect(before.every((rows) => rows.length > 0)).toBe(true);
  expect(await binding.prepare("SELECT name,hltb_main,typeof(hltb_main) AS storage,is_owned FROM games").all()).toMatchObject({ results: [{ name: "Synthetic retained β", hltb_main: 12.25, storage: "real", is_owned: null }] });
  const schemaJson = await binding.prepare("SELECT schema_json FROM steam_value_migrations WHERE id='0001_complete_schema.sql'").first<string>("schema_json");
  expect(await migrationChecksum(schemaJson!)).toBe("1b81a22b762050c5743fe24c78e9d7528dd966deccac96491548460430d967e5");
  await binding.prepare("CREATE TRIGGER unreviewed_receipt_trigger AFTER INSERT ON steam_value_migrations BEGIN UPDATE games SET name='Synthetic unexpectedly changed'; END").run();
  let dispatched = false;
  const guarded = new Proxy(binding, { get(native, key) {
    if (key === "batch") return (statements: Parameters<typeof binding.batch>[0]) => { dispatched = true; return native.batch(statements); };
    const value = Reflect.get(native, key, native);
    return typeof value === "function" ? value.bind(native) : value;
  } });
  await expect(applyMigrations(guarded, migrations)).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  expect(dispatched).toBe(false);
  expect(await contents()).toEqual(before);
  expect((await binding.prepare("SELECT name FROM sqlite_schema WHERE name IN ('__drizzle_migrations','idx_games_status_filters','idx_games_value_score')").all()).results).toEqual([]);
});

test.each([
  { stage: "repeat", object: "index", sql: "CREATE INDEX unreviewed_receipt_index ON steam_value_migrations(checksum)" },
  { stage: "append", object: "index", sql: "CREATE INDEX unreviewed_receipt_index ON steam_value_migrations(checksum)" },
  { stage: "repeat", object: "trigger", sql: "CREATE TRIGGER unreviewed_receipt_trigger AFTER INSERT ON steam_value_migrations BEGIN UPDATE games SET name='Synthetic unexpectedly changed'; END" },
])("bootstrap refuses an attached checksum-ledger $object on $stage without writes or receipt changes", async ({ stage, sql }) => {
  const binding = await emptyBinding();
  const migrations = await loadMigrations();
  await applyMigrations(binding, stage === "append" ? migrations.slice(0, 1) : migrations);
  await binding.prepare("INSERT INTO games (id,steam_app_id,name,value_score,is_owned) VALUES (7,42,'Synthetic retained',42.5,NULL)").run();
  const contents = async () => (await binding.batch([
    binding.prepare("SELECT rowid,*,typeof(value_score) AS storage FROM games ORDER BY rowid"),
    binding.prepare("SELECT * FROM sqlite_sequence ORDER BY rowid"),
    binding.prepare("SELECT rowid,* FROM steam_value_migrations ORDER BY rowid"),
  ])).map((result) => result.results);
  const before = await contents();
  await binding.prepare(sql).run();
  let dispatched = false;
  const guarded = new Proxy(binding, { get(native, key) {
    if (key === "batch") return (statements: Parameters<typeof binding.batch>[0]) => { dispatched = true; return native.batch(statements); };
    const value = Reflect.get(native, key, native);
    return typeof value === "function" ? value.bind(native) : value;
  } });
  await expect(applyMigrations(guarded, migrations)).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  expect(dispatched).toBe(false);
  expect(await contents()).toEqual(before);
});

test("sequence-only cancellation after a native read refuses the next mutation and remains durably incomplete", async () => {
  const sourceBinding = await preparedBinding();
  await sourceBinding.batch([
    sourceBinding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (950,42,'Synthetic deleted allocation')"),
    sourceBinding.prepare("DELETE FROM games"),
  ]);
  const source = createD1TransferSource(sourceBinding, { id: "cancel-source", freezeRecord: freeze("cancel-source") });
  const snapshot = await exportSnapshot(source, await artifactPath("cancel-before"), source.freezeRecord);
  const binding = await preparedBinding();
  const controller = new AbortController();
  let dispatched = false;
  const monitored = new Proxy(binding, { get(native, key) {
    if (key === "batch") return (statements: Parameters<typeof binding.batch>[0]) => { dispatched = true; return native.batch(statements); };
    const value = Reflect.get(native, key, native);
    return typeof value === "function" ? value.bind(native) : value;
  } });
  const base = createD1TransferTarget(monitored, { id: "cancel-before-target", intent: "empty", freezeRecord: freeze("cancel-before-target"), receiptPath: await artifactPath("cancel-before.json"), signal: controller.signal });
  const target: TransferTarget = { ...base, async query(sql, args) {
    const rows = await base.query(sql, args);
    if ((await Bun.file(base.receiptPath).json()).phase === "sequence") controller.abort();
    return rows;
  } };
  await expect(importSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  expect(controller.signal.aborted).toBe(true);
  expect(dispatched).toBe(false);
  expect(await Bun.file(target.receiptPath).json()).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: "not-started", errorCode: "INCOMPLETE_IMPORT" });
  expect((await inventorySource(base)).sequence).toEqual([]);
  await expect(validateSnapshot(base, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
});

test("cancellation after a committed sequence-only group preserves incomplete state and validates only a fresh recovery", async () => {
  const sourceBinding = await preparedBinding();
  await sourceBinding.batch([
    sourceBinding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (950,42,'Synthetic deleted allocation')"),
    sourceBinding.prepare("DELETE FROM games"),
  ]);
  const source = createD1TransferSource(sourceBinding, { id: "committed-cancel-source", freezeRecord: freeze("committed-cancel-source") });
  const snapshot = await exportSnapshot(source, await artifactPath("committed-cancel"), source.freezeRecord);
  const binding = await preparedBinding();
  const controller = new AbortController();
  const cancelledReply = new Proxy(binding, { get(native, key) {
    if (key === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => {
      const result = await native.batch(statements);
      controller.abort();
      return result;
    };
    const value = Reflect.get(native, key, native);
    return typeof value === "function" ? value.bind(native) : value;
  } });
  const target = createD1TransferTarget(cancelledReply, { id: "committed-cancel-target", intent: "empty", freezeRecord: freeze("committed-cancel-target"), receiptPath: await artifactPath("committed-cancel.json"), signal: controller.signal });
  await expect(importSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  expect(await Bun.file(target.receiptPath).json()).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: "partial-or-unknown", errorCode: "INCOMPLETE_IMPORT", confirmedRows: { games: 0, __drizzle_migrations: 0 } });
  expect(await inventorySource(target)).toMatchObject({ tables: snapshot.manifest.tables, sequence: [{ name: "games", seq: 950 }] });
  await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  const replay = createD1TransferTarget(binding, { id: "committed-cancel-target", intent: "empty", freezeRecord: freeze("committed-cancel-target"), receiptPath: await artifactPath("committed-replay.json") });
  await expect(importSnapshot(replay, snapshot)).rejects.toMatchObject({ code: "TARGET_NOT_EMPTY" });
  const recovery = await artifactPath("committed-recovery");
  expect(await prepareRollback(target, snapshot, recovery)).toMatchObject({ status: "reconciliation-required", automaticReversion: false, sequenceChanged: false });
  let restored: TransferTarget | undefined;
  let harness: D1WorkerTestHarness;
  harness = await createD1WorkerTestHarness({ operatorSetup: async (native) => {
    restored = createD1TransferTarget(native, { id: "fresh-cancel-recovery", intent: "empty", freezeRecord: freeze("fresh-cancel-recovery"), receiptPath: await artifactPath("fresh-cancel.json"), verifyBehavior: async () => {
      const response = await harness.fetch("https://d1-test.invalid/api/games");
      expect(response.status).toBe(200);
      const page: unknown = await response.json();
      expect(page).toEqual([]);
      const client = createHttpClient(harness.clientConfig);
      expect((await client.batch([
        "SELECT COUNT(*) AS total FROM sync_state",
        "SELECT COUNT(*) AS total FROM catalog_refresh_state",
        "SELECT COUNT(*) AS total FROM game_deal_cache",
      ], "read")).map((result) => result.rows)).toEqual([[{ total: 0 }],[{ total: 0 }],[{ total: 0 }]]);
      return { passed: ["viewer", "steam-status", "catalog-facts", "offers"] };
    } });
    await importSnapshot(restored, recovery);
  } });
  try {
    if (!restored) throw new Error("Missing explicit recovery target");
    expect(await validateSnapshot(restored, recovery)).toMatchObject({ status: "validated", tableCount: 8 });
    expect((await createHttpClient(harness.clientConfig).execute("INSERT INTO games (steam_app_id,name) VALUES (43,'Synthetic fresh allocation') RETURNING id")).rows).toEqual([{ id: 951 }]);
    expect((await inventorySource(target)).sequence).toEqual([{ name: "games", seq: 950 }]);
  } finally { await harness.dispose(); }
});

test("empty import cancellation during final native inventory cannot publish a complete receipt", async () => {
  const source = createD1TransferSource(await preparedBinding(), { id: "empty-cancel-source", freezeRecord: freeze("empty-cancel-source") });
  const snapshot = await exportSnapshot(source, await artifactPath("empty-cancel"), source.freezeRecord);
  const binding = await preparedBinding();
  const controller = new AbortController();
  let dispatched = false;
  const monitored = new Proxy(binding, { get(native, key) {
    if (key === "batch") return (statements: Parameters<typeof binding.batch>[0]) => { dispatched = true; return native.batch(statements); };
    const value = Reflect.get(native, key, native);
    return typeof value === "function" ? value.bind(native) : value;
  } });
  const base = createD1TransferTarget(monitored, { id: "empty-cancel-target", intent: "empty", freezeRecord: freeze("empty-cancel-target"), receiptPath: await artifactPath("empty-cancel.json"), signal: controller.signal });
  const target: TransferTarget = { ...base, async query(sql, args) {
    const rows = await base.query(sql, args);
    if (rows.length > 0 && (await Bun.file(base.receiptPath).json()).phase === "sequence") controller.abort();
    return rows;
  } };
  await expect(importSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  expect(controller.signal.aborted).toBe(true);
  expect(dispatched).toBe(false);
  expect(await Bun.file(base.receiptPath).json()).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: "not-started", errorCode: "INCOMPLETE_IMPORT" });
  expect(await inventorySource(base)).toMatchObject({ tables: snapshot.manifest.tables, sequence: [] });
  await expect(validateSnapshot(base, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
});

test.each([false, true])("cancellation at actual complete-receipt publication retains conservative state rather than success, sequence=%s", async (hasSequence) => {
  const sourceBinding = await preparedBinding();
  if (hasSequence) await sourceBinding.batch([
    sourceBinding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (950,42,'Synthetic deleted allocation')"),
    sourceBinding.prepare("DELETE FROM games"),
  ]);
  const source = createD1TransferSource(sourceBinding, { id: "publication-source", freezeRecord: freeze("publication-source") });
  const snapshot = await exportSnapshot(source, await artifactPath("publication"), source.freezeRecord);
  const controller = new AbortController();
  const target = createD1TransferTarget(await preparedBinding(), { id: "publication-target", intent: "empty", freezeRecord: freeze("publication-target"), receiptPath: await artifactPath("publication.json"), signal: controller.signal });
  const publication = watch(dirname(target.receiptPath), { persistent: false }, (event, filename) => {
    if (event !== "rename" || filename !== basename(target.receiptPath)) return;
    try {
      const receipt = JSON.parse(readFileSync(target.receiptPath, "utf8"));
      if (receipt.status === "imported" && receipt.phase === "complete") controller.abort();
    } catch {}
  });
  try {
    await expect(importSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
    expect(controller.signal.aborted).toBe(true);
    expect(await Bun.file(target.receiptPath).json()).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: hasSequence ? "partial-or-unknown" : "not-started", errorCode: "INCOMPLETE_IMPORT" });
    expect((await inventorySource(target)).sequence).toEqual(hasSequence ? [{ name: "games", seq: 950 }] : []);
    await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  } finally { publication.close(); }
});

test("sequence-only cancellation during final native inventory preserves an acknowledged sequence without completing", async () => {
  const sourceBinding = await preparedBinding();
  await sourceBinding.batch([
    sourceBinding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (950,42,'Synthetic deleted allocation')"),
    sourceBinding.prepare("DELETE FROM games"),
  ]);
  const source = createD1TransferSource(sourceBinding, { id: "final-cancel-source", freezeRecord: freeze("final-cancel-source") });
  const snapshot = await exportSnapshot(source, await artifactPath("final-cancel"), source.freezeRecord);
  const binding = await preparedBinding();
  const controller = new AbortController();
  let committed = false;
  const monitored = new Proxy(binding, { get(native, key) {
    if (key === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => { const result = await native.batch(statements); committed = true; return result; };
    const value = Reflect.get(native, key, native);
    return typeof value === "function" ? value.bind(native) : value;
  } });
  const base = createD1TransferTarget(monitored, { id: "final-cancel-target", intent: "empty", freezeRecord: freeze("final-cancel-target"), receiptPath: await artifactPath("final-cancel.json"), signal: controller.signal });
  const target: TransferTarget = { ...base, async query(sql, args) {
    const rows = await base.query(sql, args);
    if (committed) controller.abort();
    return rows;
  } };
  await expect(importSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  expect(controller.signal.aborted).toBe(true);
  expect(await Bun.file(base.receiptPath).json()).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: "partial-or-unknown", errorCode: "INCOMPLETE_IMPORT" });
  expect(await inventorySource(base)).toMatchObject({ tables: snapshot.manifest.tables, sequence: [{ name: "games", seq: 950 }] });
  await expect(validateSnapshot(base, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
});

test("row-group cancellation after native preparation must stop before mutation even after durable progress fencing", async () => {
  const sourceBinding = await preparedBinding();
  await sourceBinding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (17,42,'Synthetic retained')").run();
  const source = createD1TransferSource(sourceBinding, { id: "row-cancel-source", freezeRecord: freeze("row-cancel-source") });
  const snapshot = await exportSnapshot(source, await artifactPath("row-cancel"), source.freezeRecord);
  const binding = await preparedBinding();
  const controller = new AbortController();
  const receiptPath = await artifactPath("row-cancel.json");
  let dispatched = false;
  const monitored = new Proxy(binding, { get(native, key) {
    if (key === "prepare") return (sql: string) => {
      const statement = native.prepare(sql);
      if (JSON.parse(readFileSync(receiptPath, "utf8")).phase === "rows") controller.abort();
      return statement;
    };
    if (key === "batch") return (statements: Parameters<typeof binding.batch>[0]) => { dispatched = true; return native.batch(statements); };
    const value = Reflect.get(native, key, native);
    return typeof value === "function" ? value.bind(native) : value;
  } });
  const target = createD1TransferTarget(monitored, { id: "row-cancel-target", intent: "empty", freezeRecord: freeze("row-cancel-target"), receiptPath, signal: controller.signal });
  await expect(importSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  expect(dispatched).toBe(false);
  expect(await Bun.file(receiptPath).json()).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: "partial-or-unknown", errorCode: "INCOMPLETE_IMPORT", confirmedRows: { games: 0 } });
  expect((await inventorySource(target)).tables.every((table) => table.rowCount === 0)).toBe(true);
  await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
});

test("sequence cancellation during actual preparation stops dispatch after durable unknown-outcome fencing", async () => {
  const sourceBinding = await preparedBinding();
  await sourceBinding.batch([
    sourceBinding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (950,42,'Synthetic deleted allocation')"),
    sourceBinding.prepare("DELETE FROM games"),
  ]);
  const source = createD1TransferSource(sourceBinding, { id: "prepare-cancel-source", freezeRecord: freeze("prepare-cancel-source") });
  const snapshot = await exportSnapshot(source, await artifactPath("prepare-cancel"), source.freezeRecord);
  const binding = await preparedBinding();
  const controller = new AbortController();
  const receiptPath = await artifactPath("prepare-cancel.json");
  let dispatched = false;
  const monitored = new Proxy(binding, { get(native, key) {
    if (key === "prepare") return (sql: string) => {
      const statement = native.prepare(sql);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      if (receipt.phase === "sequence" && receipt.writeOutcome === "partial-or-unknown") controller.abort();
      return statement;
    };
    if (key === "batch") return (statements: Parameters<typeof binding.batch>[0]) => { dispatched = true; return native.batch(statements); };
    const value = Reflect.get(native, key, native);
    return typeof value === "function" ? value.bind(native) : value;
  } });
  const target = createD1TransferTarget(monitored, { id: "prepare-cancel-target", intent: "empty", freezeRecord: freeze("prepare-cancel-target"), receiptPath, signal: controller.signal });
  await expect(importSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  expect(dispatched).toBe(false);
  expect(await Bun.file(receiptPath).json()).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: "partial-or-unknown", errorCode: "INCOMPLETE_IMPORT" });
  expect((await inventorySource(target)).sequence).toEqual([]);
  await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
});

test("sequence-phase cancellation retains confirmed nonempty legacy rows and every committed typed cell", async () => {
  const source = await populatedLegacy();
  const snapshot = await exportSnapshot(source, await artifactPath("nonempty-cancel"), source.freezeRecord);
  const binding = await preparedBinding();
  const controller = new AbortController();
  const receiptPath = await artifactPath("nonempty-cancel.json");
  const cancelledReply = new Proxy(binding, { get(native, key) {
    if (key === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => {
      const result = await native.batch(statements);
      if ((await Bun.file(receiptPath).json()).phase === "sequence") controller.abort();
      return result;
    };
    const value = Reflect.get(native, key, native);
    return typeof value === "function" ? value.bind(native) : value;
  } });
  const target = createD1TransferTarget(cancelledReply, { id: "nonempty-cancel-target", intent: "empty", freezeRecord: freeze("nonempty-cancel-target"), receiptPath, signal: controller.signal });
  await expect(importSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  expect(await Bun.file(receiptPath).json()).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: "partial-or-unknown", errorCode: "INCOMPLETE_IMPORT", confirmedRows: { __drizzle_migrations: 3, games: 2, sync_state: 3 } });
  expect(await inventorySource(target)).toMatchObject({ tables: snapshot.manifest.tables, sequence: [{ name: "games", seq: 950 }] });
  await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
});

test("bounded native restore preserves mixed storage at full-game and SERIAL-ledger parameter boundaries with row-accurate progress", async () => {
  const source = await populatedLegacy();
  const binding = source.binding;
  for (let offset = 0; offset < 65; offset += 16) {
    const rows = Array.from({ length: Math.min(16,65-offset) }, (_, index) => {
      const value = offset + index;
      return [3000+value, `Synthetic bulk β ${value}`, value % 2 ? null : 12.25, value % 2 ? 1 : null, '[ "β", "quote\\\"" ]', 1700000000+value];
    });
    await binding.prepare(`INSERT INTO games (steam_app_id,name,hltb_main,is_owned,is_early_access,tags,created_at) VALUES ${rows.map(() => "(?, ?, ?, ?, NULL, ?, ?)").join(",")}`).bind(...rows.flat()).run();
  }
  for (let offset = 0; offset < 27; offset += 25) {
    const rows = Array.from({ length: Math.min(25,27-offset) }, (_, index) => {
      const value = offset + index;
      return [200+value, value % 3 === 0 ? null : value % 3 === 1 ? value + 0.25 : `synthetic-${value}`, `Synthetic ledger ${value}`, value % 3 === 0 ? null : value % 3 === 1 ? value + 0.5 : "Synthetic numeric text"];
    });
    await binding.prepare(`INSERT INTO __drizzle_migrations (rowid,id,hash,created_at) VALUES ${rows.map(() => "(?, ?, ?, ?)").join(",")}`).bind(...rows.flat()).run();
  }
  const snapshot = await exportSnapshot(source, await artifactPath("bulk"), source.freezeRecord);
  const target = createD1TransferTarget(await preparedBinding(), { id: "bulk-target", intent: "empty", freezeRecord: freeze("bulk-target"), receiptPath: await artifactPath("bulk.json") });
  expect((await importSnapshot(target, snapshot)).confirmedRows).toMatchObject({ games: 67, __drizzle_migrations: 30 });
  expect(await inventorySource(target)).toMatchObject({ tables: snapshot.manifest.tables, sequence: [{ name: "games", seq: 1015 }] });
  const lines = (await Bun.file(join(snapshot.directory, "__drizzle_migrations.jsonl")).text()).trim().split("\n").map((line) => JSON.parse(line));
  expect(lines.find((row) => row.rowid === 225)).toEqual({ rowid: 225, values: [["real",25.25],["text","Synthetic ledger 25"],["real",25.5]] });
});
