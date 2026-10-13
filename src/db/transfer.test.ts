import { afterAll, beforeAll, expect, test } from "bun:test";
import { createLocalD1, type LocalD1Owner } from "./local-d1";
import type { Client as LibsqlClient, InArgs, InStatement } from "@libsql/client";
import { isDbValue, type DbValue } from "./access";
import { chmod, link, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations, loadMigrations } from "./migrations";
import { createD1WorkerTestHarness, type D1WorkerTestHarness } from "./testing";
import { createHttpClient } from "./http";
import { createDrizzleDb } from "./drizzle";
import type { TransferTarget } from "./transfer";
import { createD1TransferSource, createD1TransferTarget, createLegacyTransferSource, exportSnapshot, importSnapshot, inventorySource, prepareRollback, validateSnapshot } from "./transfer";

let runtime: LocalD1Owner;
let nextDatabase = 0;
const directories: string[] = [];

beforeAll(async () => {
  runtime = await createLocalD1({ databaseNames: Array.from({ length: 100 }, (_, index) => `TRANSFER_${index}`) });
});

afterAll(async () => {
  await runtime.dispose();
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function isolatedD1() {
  const binding = await runtime.getBinding(`TRANSFER_${nextDatabase++}`);
  await applyMigrations(binding, await loadMigrations());
  return binding;
}

function freeze(sourceId = "synthetic-source") {
  return {
    mode: "frozen-writers" as const, sourceId, recordId: "synthetic-freeze",
    frozenAt: 1700000000, evidence: "synthetic isolated fixture; no other writers",
    writersPaused: ["fixture"], writersDrained: ["fixture"], manualWritersDrained: true as const,
    holdsUntilRelease: true as const,
  };
}

async function artifactPath(name = "snapshot") {
  const parent = await mkdtemp(join(tmpdir(), "steam-value-d1-transfer-"));
  directories.push(parent);
  return join(parent, name);
}

async function syntheticSource() {
  const binding = await isolatedD1();
  await binding.batch([
    binding.prepare(`INSERT INTO games VALUES (7,42,'Synthetic ü; game',95,1234,23,12.5,NULL,40.25,9.75,0,1,NULL,'full','2020-01-02',1,0,0,1,0,1,0,1,0,1,0,1,NULL,'["City Builder", "é"]',1700000000,1700000001)`),
    binding.prepare("INSERT INTO games (id, steam_app_id, name, is_on_wishlist, is_owned, tags) VALUES (12, 43, 'Defaults', NULL, 0, '')"),
    binding.prepare("INSERT INTO games (id, steam_app_id, name) VALUES (900, 99, 'Deleted high-water')"),
    binding.prepare("DELETE FROM games WHERE id = 900"),
    binding.prepare("INSERT INTO sync_state VALUES ('steam_status',1700000010,1700000009,'synthetic failure',1,1700000910,2,3,4,5,6,1700000010)"),
    binding.prepare("INSERT INTO sync_state (key,updated_at) VALUES (NULL,1700000011)"),
    binding.prepare("INSERT INTO sync_state (key,updated_at) VALUES (NULL,1700000012)"),
    binding.prepare("INSERT INTO catalog_refresh_state VALUES ('steam_official_catalog',43,1700000000,NULL,100,12,11,3,4,1,2,1,NULL,1700000010)"),
    binding.prepare("INSERT INTO catalog_refresh_failures VALUES (999,'Orphan Catalog Facts','synthetic retry',3,1700000010)"),
    binding.prepare("INSERT INTO itad_game_map VALUES (42,'synthetic-itad',1700000000)"),
    binding.prepare("INSERT INTO itad_game_map VALUES (999,NULL,1700000001)"),
    binding.prepare("INSERT INTO game_deal_cache VALUES (42,'US','retail',1700000000,'[]')"),
    binding.prepare(`INSERT INTO game_deal_cache VALUES (999,'GB','bundle',1700000001,'[{"validUntil":1700086400,"priceCents":null}]')`),
    binding.prepare("INSERT INTO deal_refresh_state VALUES ('US',1700000010,1700000000,NULL,'synthetic-lock',1700000910,2)"),
    binding.prepare("INSERT INTO deal_refresh_state VALUES ('GB',NULL,NULL,'synthetic error',NULL,NULL,0)"),
  ]);
  return { binding, source: createD1TransferSource(binding, { id: "synthetic-source", freezeRecord: freeze() }) };
}

test("source inventory identifies every reviewed schema object and separates only known metadata", async () => {
  const source = createD1TransferSource(await isolatedD1(), { id: "synthetic-source", freezeRecord: freeze() });
  const inventory = await inventorySource(source);
  expect(inventory.schema.tables.map((table) => table.name)).toEqual([
    "catalog_refresh_failures", "catalog_refresh_state", "deal_refresh_state", "game_deal_cache", "games", "itad_game_map", "sync_state",
  ]);
  expect(inventory.schema.objects.filter((object) => object.type === "index").map((object) => object.name)).toEqual([
    "games_steam_app_id_unique", "idx_games_browse_default", "idx_games_browse_owned_playtime", "idx_games_steam_app_id",
    "sqlite_autoindex_catalog_refresh_state_1", "sqlite_autoindex_deal_refresh_state_1", "sqlite_autoindex_game_deal_cache_1", "sqlite_autoindex_sync_state_1",
  ]);
  expect(inventory.schema.tables.find((table) => table.name === "games")?.columns).toHaveLength(31);
  expect(inventory.schema.tables.find((table) => table.name === "sync_state")?.columns.at(-1)).toMatchObject({
    name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: "unixepoch()",
  });
  expect(inventory.excludedMetadata.map((object) => object.name)).toEqual([
    "_cf_METADATA", "sqlite_autoindex_steam_value_migrations_1", "steam_value_migrations",
  ]);
  expect(inventory.schemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(inventory.migrationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(inventory.schemaStatus).toBe("provisional-source-schema");
});

test("the explicit legacy source adapter uses SDK projection labels without a legacy constructor or live access", async () => {
  const { source } = await syntheticSource();
  const sdk: Pick<LibsqlClient, "execute"> = {
    async execute(statement: InStatement, inArgs?: InArgs) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      const args = typeof statement === "string" ? inArgs ?? [] : statement.args ?? [];
      if (!Array.isArray(args) || !args.every(isDbValue)) throw new Error("Unsupported synthetic SDK args");
      const raw = await source.query(sql, args.filter(isDbValue));
      const columns = Object.keys(raw[0] ?? {});
      const rows = raw.map((values) => {
        const row: Record<string, DbValue> & { length: number } = { length: columns.length };
        columns.forEach((column, index) => {
          const value = values[column];
          if (!isDbValue(value)) throw new Error("Unsupported synthetic SDK value");
          row[index] = value;
          Object.defineProperty(row, column, { value, enumerable: false });
        });
        return row;
      });
      return { columns, columnTypes: columns.map(() => ""), rows, rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({ columns, rows }) };
    },
  };
  const legacy = createLegacyTransferSource(sdk, { id: "synthetic-source", freezeRecord: freeze() });
  const actual = await inventorySource(legacy);
  const expected = await inventorySource(source);
  expect({ schema: actual.schema, tables: actual.tables, sequence: actual.sequence }).toEqual({ schema: expected.schema, tables: expected.tables, sequence: [{ name: "games", seq: 900 }] });
});

test("frozen export preserves typed all-table contents, nullable keys, orphan rows and deleted high-water in private artifacts", async () => {
  const { source } = await syntheticSource();
  const destination = await artifactPath();
  const snapshot = await exportSnapshot(source, destination, freeze());
  expect(snapshot.manifest.tables.map((table) => [table.name, table.rowCount])).toEqual([
    ["catalog_refresh_failures", 1], ["catalog_refresh_state", 1], ["deal_refresh_state", 2], ["game_deal_cache", 2], ["games", 2], ["itad_game_map", 2], ["sync_state", 3],
  ]);
  expect(snapshot.manifest.sequence).toEqual([{ name: "games", seq: 900 }]);
  expect(snapshot.manifest.freezeRecord).toEqual(freeze());
  expect(snapshot.manifest.tables.find((table) => table.name === "games")?.storageTypes[12]).toEqual({ null: 1, integer: 1 });
  const rows = (await Bun.file(join(destination, "games.jsonl")).text()).trim().split("\n").map((line) => JSON.parse(line));
  expect(rows[0]).toEqual({ rowid: 7, values: [
    ["integer",7],["integer",42],["text","Synthetic ü; game"],["integer",95],["integer",1234],["integer",23],
    ["real",12.5],["null",null],["real",40.25],["real",9.75],["integer",0],["integer",1],["null",null],
    ["text","full"],["text","2020-01-02"],["integer",1],["integer",0],["integer",0],["integer",1],["integer",0],
    ["integer",1],["integer",0],["integer",1],["integer",0],["integer",1],["integer",0],["integer",1],["null",null],
    ["text",'["City Builder", "é"]'],["integer",1700000000],["integer",1700000001],
  ] });
  expect((await stat(destination)).mode & 0o777).toBe(0o700);
  for (const file of ["manifest.json", "export-receipt.json", ...snapshot.manifest.tables.map((table) => table.file)]) {
    expect((await stat(join(destination, file))).mode & 0o777).toBe(0o600);
  }
  expect(await inventorySource(source)).toMatchObject({ tables: snapshot.manifest.tables, sequence: [{ name: "games", seq: 900 }] });
});

test("explicit pristine-target import restores every typed cell and sequence and refuses an append replay", async () => {
  const { source } = await syntheticSource();
  const snapshot = await exportSnapshot(source, await artifactPath(), freeze());
  const receiptPath = await artifactPath("import-receipt.json");
  const target = createD1TransferTarget(await isolatedD1(), {
    id: "synthetic-target", intent: "staging", freezeRecord: freeze("synthetic-target"), receiptPath,
  });
  const receipt = await importSnapshot(target, snapshot);
  expect(receipt).toMatchObject({ status: "imported", phase: "complete", confirmedRows: {
    catalog_refresh_failures: 1, catalog_refresh_state: 1, deal_refresh_state: 2, game_deal_cache: 2, games: 2, itad_game_map: 2, sync_state: 3,
  } });
  expect(await inventorySource(target)).toMatchObject({ tables: snapshot.manifest.tables, sequence: snapshot.manifest.sequence });
  expect(JSON.parse(await Bun.file(receiptPath).text())).toEqual(receipt);
  expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
  const replayTarget = createD1TransferTarget(target.binding, {
    id: "synthetic-target", intent: "empty", freezeRecord: freeze("synthetic-target"), receiptPath: await artifactPath("replay-receipt.json"),
  });
  await expect(importSnapshot(replayTarget, snapshot)).rejects.toMatchObject({ code: "TARGET_NOT_EMPTY" });
  expect(JSON.parse(await Bun.file(replayTarget.receiptPath).text())).toMatchObject({ status: "incomplete", errorCode: "TARGET_NOT_EMPTY" });
});

test("full validation requires representative native Worker/client behavior and allocation beyond deleted IDs", async () => {
  const { source } = await syntheticSource();
  const snapshot = await exportSnapshot(source, await artifactPath(), freeze());
  const receiptPath = await artifactPath("native-import.json");
  let target: TransferTarget | undefined;
  let harness: D1WorkerTestHarness;
  harness = await createD1WorkerTestHarness({
    operatorSetup: async (binding) => {
      target = createD1TransferTarget(binding, {
        id: "native-target", intent: "staging", freezeRecord: freeze("native-target"), receiptPath,
        verifyBehavior: async () => {
          const client = createHttpClient(harness.clientConfig);
          const viewer = await harness.fetch("https://d1-test.invalid/api/games");
          expect(viewer.status).toBe(200);
          const viewerRows: unknown = await viewer.json();
          expect(viewerRows).toEqual([expect.objectContaining({
            id: 7, steamAppId: 42, name: "Synthetic ü; game", hltbMain: 12.5, isOwned: true,
            createdAt: 1700000000, tags: '["City Builder", "é"]',
          })]);
          const db = createDrizzleDb(client);
          expect(await db.query.games.findFirst({ columns: { id: true, steamAppId: true, name: true, hltbMain: true, isOwned: true, isEarlyAccess: true, createdAt: true, tags: true } })).toEqual({
            id: 7, steamAppId: 42, name: "Synthetic ü; game", hltbMain: 12.5, isOwned: true, isEarlyAccess: null,
            createdAt: new Date("2023-11-14T22:13:20Z"), tags: '["City Builder", "é"]',
          });
          expect((await client.execute("SELECT steam_app_id FROM games WHERE value_score IS NOT NULL AND is_endless = 0 AND is_ignored = 0 ORDER BY value_score DESC, id")).rows).toEqual([{ steam_app_id: 42 }]);
          expect((await client.execute("SELECT is_running, owned_count, lock_expires_at FROM sync_state WHERE key = 'steam_status'")).rows).toEqual([{ is_running: 1, owned_count: 4, lock_expires_at: 1700000910 }]);
          expect((await client.execute("SELECT last_app_id, completed_at, failed_count FROM catalog_refresh_state WHERE key = 'steam_official_catalog'")).rows).toEqual([{ last_app_id: 43, completed_at: null, failed_count: 1 }]);
          expect((await client.execute("SELECT m.steam_app_id, m.itad_id, c.offers_json, json_valid(c.offers_json) AS valid FROM itad_game_map m JOIN game_deal_cache c ON c.steam_app_id = m.steam_app_id AND c.country = 'GB'")).rows).toEqual([{ steam_app_id: 999, itad_id: null, offers_json: '[{"validUntil":1700086400,"priceCents":null}]', valid: 1 }]);
          return { passed: ["viewer", "steam-status", "catalog-facts", "offers"] };
        },
      });
      await importSnapshot(target, snapshot);
    },
  });
  try {
    if (!target) throw new Error("Missing explicit transfer target");
    expect(await validateSnapshot(target, snapshot)).toMatchObject({ status: "validated", tableCount: 7, behaviorChecks: ["viewer", "steam-status", "catalog-facts", "offers"] });
    expect(JSON.parse(await Bun.file(receiptPath).text())).toMatchObject({ status: "validated" });
    const client = createHttpClient(harness.clientConfig);
    await client.execute("UPDATE games SET name = 'Same count, different contents' WHERE id = 7");
    await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "CONTENT_MISMATCH" });
    await client.execute("UPDATE games SET name = 'Synthetic ü; game' WHERE id = 7");
    expect((await client.execute("INSERT INTO games (steam_app_id, name) VALUES (44, 'New allocation') RETURNING id")).rows).toEqual([{ id: 901 }]);
    await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "CONTENT_MISMATCH" });
    expect(JSON.parse(await Bun.file(receiptPath).text())).toMatchObject({ status: "imported", validation: { status: "failed", errorCode: "CONTENT_MISMATCH" } });
  } finally { await harness.dispose(); }
});

test("rollback preparation captures the complete frozen post-cutover state and reconciliation delta without reverting anything", async () => {
  const { source } = await syntheticSource();
  const baseline = await exportSnapshot(source, await artifactPath(), freeze());
  const binding = await isolatedD1();
  const target = createD1TransferTarget(binding, { id: "post-cutover", intent: "staging", freezeRecord: freeze("post-cutover"), receiptPath: await artifactPath("import.json") });
  await importSnapshot(target, baseline);
  await binding.batch([
    binding.prepare("UPDATE games SET name = 'Changed after cutover' WHERE id = 7"),
    binding.prepare("DELETE FROM games WHERE id = 12"),
    binding.prepare("INSERT INTO games (steam_app_id, name) VALUES (44, 'Added after cutover')"),
    binding.prepare("UPDATE catalog_refresh_failures SET attempts = attempts + 1 WHERE steam_app_id = 999"),
    binding.prepare("UPDATE itad_game_map SET itad_id = 'synthetic-new-mapping' WHERE steam_app_id = 999"),
  ]);
  const before = await inventorySource(target);
  const recoveryDirectory = await artifactPath("recovery");
  const receipt = await prepareRollback(target, baseline, recoveryDirectory);
  expect(receipt).toMatchObject({ status: "reconciliation-required", automaticReversion: false, sequenceChanged: true, delta: {
    games: { added: 1, deleted: 1, changed: 1 }, catalog_refresh_failures: { added: 0, deleted: 0, changed: 1 }, itad_game_map: { added: 0, deleted: 0, changed: 1 },
  } });
  expect(JSON.parse(await Bun.file(join(recoveryDirectory, "manifest.json")).text())).toMatchObject({ tables: before.tables, sequence: [{ name: "games", seq: 901 }] });
  const changes = (await Bun.file(join(recoveryDirectory, "reconciliation.jsonl")).text()).trim().split("\n").map((line) => JSON.parse(line));
  expect(changes.find((row) => row.table === "catalog_refresh_failures")).toMatchObject({ before: { values: [["integer",999],["text","Orphan Catalog Facts"],["text","synthetic retry"],["integer",3],["integer",1700000010]] }, after: { values: [["integer",999],["text","Orphan Catalog Facts"],["text","synthetic retry"],["integer",4],["integer",1700000010]] } });
  expect(await inventorySource(target)).toEqual(before);
  expect(JSON.parse(await Bun.file(join(recoveryDirectory, "rollback-receipt.json")).text())).toEqual(receipt);
  expect((await stat(join(recoveryDirectory, "reconciliation.jsonl"))).mode & 0o777).toBe(0o600);
});

test("source inventory rejects altered migration receipts rather than certifying a broken immutable history", async () => {
  const { binding, source } = await syntheticSource();
  await binding.prepare("UPDATE steam_value_migrations SET schema_json = '[]'").run();
  await expect(inventorySource(source)).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
});

test("protected export never overwrites an existing artifact directory or emits unsafe filesystem errors", async () => {
  const { source } = await syntheticSource();
  const destination = await artifactPath();
  await exportSnapshot(source, destination, freeze());
  await expect(exportSnapshot(source, destination, freeze())).rejects.toMatchObject({ code: "ARTIFACT_UNSAFE" });
  const insideGit = join(process.cwd(), ".transfer-forbidden");
  await expect(exportSnapshot(source, insideGit, freeze())).rejects.toMatchObject({ code: "ARTIFACT_UNSAFE" });
  expect(await Bun.file(join(insideGit, "manifest.json")).exists()).toBe(false);
});

test.each([
  "CREATE TABLE extra_operational_data (id INTEGER)",
  "DROP TABLE sync_state",
  "DROP INDEX idx_games_browse_default",
  "CREATE TRIGGER unreviewed_trigger AFTER INSERT ON games BEGIN UPDATE games SET is_owned = 1 WHERE id = new.id; END",
  "CREATE VIEW unreviewed_view AS SELECT * FROM games",
  "ALTER TABLE sync_state ADD COLUMN extra_clock INTEGER",
])("source inventory fails closed on unresolved application/internal schema drift: %s", async (sql) => {
  const { binding, source } = await syntheticSource();
  await binding.prepare(sql).run();
  await expect(inventorySource(source)).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
});

test("private inventory retains unresolved extra schema for review without claiming a complete export", async () => {
  const { binding, source } = await syntheticSource();
  await binding.prepare("CREATE TABLE unreviewed_records (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)").run();
  const destination = await artifactPath("inventory-drift");
  await expect(inventorySource(source, destination)).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  const diagnostic = JSON.parse(await Bun.file(join(destination, "schema-drift.json")).text());
  expect(diagnostic.objects.find((object: { name: string }) => object.name === "unreviewed_records")).toMatchObject({ type: "table", sql: "CREATE TABLE unreviewed_records (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)" });
  expect(diagnostic.tables.find((table: { name: string }) => table.name === "unreviewed_records").columns[1]).toMatchObject({ name: "payload", type: "BLOB", notnull: 1 });
  expect(JSON.parse(await Bun.file(join(destination, "inventory-receipt.json")).text())).toMatchObject({ status: "incomplete", errorCode: "SCHEMA_DRIFT" });
  expect(await Bun.file(join(destination, "inventory.json")).exists()).toBe(false);
  expect((await stat(join(destination, "schema-drift.json"))).mode & 0o777).toBe(0o600);
});

test.each(["unknown", "altered"])("source adapter cannot hide %s internal metadata with an unchecked prefix exemption", async (kind) => {
  const { source } = await syntheticSource();
  const altered = { ...source, async query(sql: string, args?: readonly (string | number | null)[]) {
    const rows = await source.query(sql, args);
    if (rows.length && rows.every((row) => Object.hasOwn(row, "tbl_name"))) {
      if (kind === "unknown") return [...rows, { type: "table", name: "_cf_unreviewed", tbl_name: "_cf_unreviewed", sql: "CREATE TABLE _cf_unreviewed(value TEXT)" }];
      return rows.map((row) => row.name === "_cf_METADATA" ? { ...row, sql: "CREATE TABLE _cf_METADATA(key INTEGER PRIMARY KEY, value BLOB, unreviewed TEXT)" } : row);
    }
    return rows;
  } };
  await expect(inventorySource(altered)).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
});

test.each([
  "UPDATE games SET name = x'000102' WHERE id = 7",
  "UPDATE games SET steam_review_count = 9223372036854775807 WHERE id = 7",
  "UPDATE games SET name = hex(zeroblob(500001)) WHERE id = 7",
])("unsupported typed data never becomes a successful truncated/coerced snapshot: %s", async (sql) => {
  const { binding, source } = await syntheticSource();
  await binding.prepare(sql).run();
  const destination = await artifactPath();
  await expect(exportSnapshot(source, destination, freeze())).rejects.toMatchObject({ code: "UNSUPPORTED_DATA" });
  expect(JSON.parse(await Bun.file(join(destination, "export-receipt.json")).text())).toMatchObject({ status: "incomplete", errorCode: "UNSUPPORTED_DATA" });
  expect(await Bun.file(join(destination, "manifest.json")).exists()).toBe(false);
});

test("corruption with unchanged row counts is rejected before the first target write", async () => {
  const { source } = await syntheticSource();
  const snapshot = await exportSnapshot(source, await artifactPath(), freeze());
  const dataFile = join(snapshot.directory, "games.jsonl");
  const contents = await Bun.file(dataFile).text();
  await writeFile(dataFile, contents.replace("Synthetic", "Different"));
  const target = createD1TransferTarget(await isolatedD1(), { id: "corrupt-target", intent: "empty", freezeRecord: freeze("corrupt-target"), receiptPath: await artifactPath("import.json") });
  await expect(importSnapshot(target, snapshot)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  expect((await inventorySource(target)).tables.every((table) => table.rowCount === 0)).toBe(true);
  expect(JSON.parse(await Bun.file(target.receiptPath).text())).toMatchObject({ status: "incomplete", writeOutcome: "not-started" });
});

test("snapshot readers reject world-readable files, symlink paths and hardlink aliases", async () => {
  const { source } = await syntheticSource();
  const snapshot = await exportSnapshot(source, await artifactPath(), freeze());
  const target = () => isolatedD1().then(async (binding) => createD1TransferTarget(binding, { id: "unsafe-target", intent: "staging", freezeRecord: freeze("unsafe-target"), receiptPath: await artifactPath("import.json") }));
  const file = join(snapshot.directory, "games.jsonl");
  await chmod(file, 0o644);
  await expect(importSnapshot(await target(), snapshot)).rejects.toMatchObject({ code: "ARTIFACT_UNSAFE" });
  await chmod(file, 0o600);
  const alias = await artifactPath("snapshot-alias");
  await symlink(snapshot.directory, alias);
  await expect(importSnapshot(await target(), alias)).rejects.toMatchObject({ code: "ARTIFACT_UNSAFE" });
  await link(file, join(snapshot.directory, "hardlink"));
  await expect(importSnapshot(await target(), snapshot)).rejects.toMatchObject({ code: "ARTIFACT_UNSAFE" });
});

test("export refuses pages without a matching held writer freeze and drain attestation", async () => {
  const { binding } = await syntheticSource();
  const record = freeze();
  Reflect.set(record, "manualWritersDrained", false);
  const source = createD1TransferSource(binding, { id: "synthetic-source", freezeRecord: record });
  const destination = await artifactPath();
  await expect(exportSnapshot(source, destination, record)).rejects.toMatchObject({ code: "FREEZE_REQUIRED" });
  expect(await Bun.file(join(destination, "export-receipt.json")).exists()).toBe(false);
});

test("export detects a violated freeze when an already-read cell changes without changing counts or schema", async () => {
  const { source, binding } = await syntheticSource();
  let changed = false;
  const unsafeSource = { ...source, async query(sql: string, args?: readonly (string | number | null)[]) {
    const rows = await source.query(sql, args);
    if (!changed && rows.some((row) => row.transfer_rowid === 7 && row.c1 === 42)) {
      changed = true;
      await binding.prepare("UPDATE games SET name = 'Concurrent synthetic writer' WHERE id = 7").run();
    }
    return rows;
  } };
  const directory = await artifactPath();
  await expect(exportSnapshot(unsafeSource, directory, freeze())).rejects.toMatchObject({ code: "FREEZE_REQUIRED" });
  expect(JSON.parse(await Bun.file(join(directory, "export-receipt.json")).text())).toMatchObject({ status: "incomplete", errorCode: "FREEZE_REQUIRED" });
});

test("a lost native import reply leaves an incomplete unknown-outcome receipt and requires a fresh explicit restore", async () => {
  const { source } = await syntheticSource();
  const snapshot = await exportSnapshot(source, await artifactPath(), freeze());
  const binding = await isolatedD1();
  const uncertainBinding = new Proxy(binding, { get(native, key) {
    if (key === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => {
      await native.batch(statements);
      throw new Error("synthetic unsafe SQL and parameter detail");
    };
    const value = Reflect.get(native, key, native);
    return typeof value === "function" ? value.bind(native) : value;
  } });
  const target = createD1TransferTarget(uncertainBinding, { id: "lost-reply", intent: "staging", freezeRecord: freeze("lost-reply"), receiptPath: await artifactPath("import.json") });
  await expect(importSnapshot(target, snapshot)).rejects.toMatchObject({ code: "TRANSFER_FAILED" });
  const receiptText = await Bun.file(target.receiptPath).text();
  expect(receiptText.includes("synthetic unsafe")).toBe(false);
  expect(JSON.parse(receiptText)).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: "partial-or-unknown", confirmedRows: { catalog_refresh_failures: 0 } });
  const partial = await inventorySource(target);
  expect(partial.tables.map((table) => [table.name, table.rowCount])).toEqual([
    ["catalog_refresh_failures",1],["catalog_refresh_state",0],["deal_refresh_state",0],["game_deal_cache",0],["games",0],["itad_game_map",0],["sync_state",0],
  ]);
  await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  const restartOnPartial = createD1TransferTarget(binding, { id: "lost-reply", intent: "staging", freezeRecord: freeze("lost-reply"), receiptPath: await artifactPath("restart-partial.json") });
  await expect(importSnapshot(restartOnPartial, snapshot)).rejects.toMatchObject({ code: "TARGET_NOT_EMPTY" });
  const fresh = await isolatedD1();
  const restored = createD1TransferTarget(fresh, { id: "explicit-fresh-restore", intent: "empty", freezeRecord: freeze("explicit-fresh-restore"), receiptPath: await artifactPath("restore.json") });
  await applyMigrations(fresh, await loadMigrations());
  expect((await importSnapshot(restored, snapshot)).status).toBe("imported");
  await applyMigrations(fresh, await loadMigrations());
  expect(await inventorySource(restored)).toMatchObject({ tables: snapshot.manifest.tables, sequence: [{ name: "games", seq: 900 }] });
}, 15000);

test("a deliberately aborted import is incomplete and cannot validate even if every table would be empty", async () => {
  const source = createD1TransferSource(await isolatedD1(), { id: "synthetic-source", freezeRecord: freeze() });
  const snapshot = await exportSnapshot(source, await artifactPath(), freeze());
  const controller = new AbortController();
  controller.abort();
  const target = createD1TransferTarget(await isolatedD1(), { id: "aborted-target", intent: "empty", freezeRecord: freeze("aborted-target"), receiptPath: await artifactPath("import.json"), signal: controller.signal });
  await expect(importSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  expect(JSON.parse(await Bun.file(target.receiptPath).text())).toMatchObject({ status: "incomplete", writeOutcome: "not-started" });
});

test("cancellation between committed native groups preserves known progress but never completes a partial import", async () => {
  const { source } = await syntheticSource();
  const snapshot = await exportSnapshot(source, await artifactPath(), freeze());
  const binding = await isolatedD1();
  const controller = new AbortController();
  const cancelAfterCommit = new Proxy(binding, { get(native, key) {
    if (key === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => {
      const result = await native.batch(statements);
      controller.abort();
      return result;
    };
    const value = Reflect.get(native, key, native);
    return typeof value === "function" ? value.bind(native) : value;
  } });
  const target = createD1TransferTarget(cancelAfterCommit, { id: "cancelled-progress", intent: "staging", freezeRecord: freeze("cancelled-progress"), receiptPath: await artifactPath("import.json"), signal: controller.signal });
  await expect(importSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  expect(JSON.parse(await Bun.file(target.receiptPath).text())).toMatchObject({ status: "incomplete", writeOutcome: "partial-or-unknown", confirmedRows: { catalog_refresh_failures: 1, catalog_refresh_state: 0 } });
  await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  expect((await inventorySource(target)).tables.find((table) => table.name === "catalog_refresh_failures")?.rowCount).toBe(1);
});

test("bounded restore crosses every full-game page and native batch without omissions or excess binds", async () => {
  const { source, binding } = await syntheticSource();
  for (let offset = 0; offset < 257; offset += 64) {
    await binding.batch(Array.from({ length: Math.min(64, 257 - offset) }, (_, index) => binding.prepare("INSERT INTO games (steam_app_id,name,tags,created_at,is_owned) VALUES (?,?,'[\"synthetic\"]',1700000000,1)").bind(1000 + offset + index, `Paged game ${offset + index}`)));
  }
  const snapshot = await exportSnapshot(source, await artifactPath(), freeze());
  expect(snapshot.manifest.tables.find((table) => table.name === "games")?.rowCount).toBe(259);
  const target = createD1TransferTarget(await isolatedD1(), { id: "paged-restore", intent: "staging", freezeRecord: freeze("paged-restore"), receiptPath: await artifactPath("import.json") });
  expect((await importSnapshot(target, snapshot)).confirmedRows.games).toBe(259);
  expect(await inventorySource(target)).toMatchObject({ tables: snapshot.manifest.tables, sequence: [{ name: "games", seq: 1157 }] });
  const lines = (await Bun.file(join(snapshot.directory, "games.jsonl")).text()).trim().split("\n");
  const last = JSON.parse(lines.at(-1)!);
  expect({ rowid: last.rowid, values: last.values.slice(0, 3) }).toEqual({ rowid: 1157, values: [["integer",1157],["integer",1256],["text","Paged game 256"]] });
}, 15000);

test("inventory refuses ambiguous duplicate sequence state instead of publishing an unrestorable snapshot", async () => {
  const { binding, source } = await syntheticSource();
  await binding.prepare("INSERT INTO sqlite_sequence (name,seq) VALUES ('games',1000)").run();
  await expect(inventorySource(source)).rejects.toMatchObject({ code: "UNSUPPORTED_DATA" });
});

test("deleted-only Game Catalog state restores its high-water even when no game insert generated a sequence row", async () => {
  const { source, binding } = await syntheticSource();
  await binding.prepare("DELETE FROM games").run();
  const snapshot = await exportSnapshot(source, await artifactPath(), freeze());
  let target: TransferTarget | undefined;
  const receiptPath = await artifactPath("empty-catalog.json");
  const harness = await createD1WorkerTestHarness({ operatorSetup: async (native) => {
    target = createD1TransferTarget(native, { id: "empty-catalog", intent: "empty", freezeRecord: freeze("empty-catalog"), receiptPath });
    await importSnapshot(target, snapshot);
  } });
  try {
    if (!target) throw new Error("Missing transfer target");
    expect((await inventorySource(target)).sequence).toEqual([{ name: "games", seq: 900 }]);
    expect((await createHttpClient(harness.clientConfig).execute("INSERT INTO games (steam_app_id,name) VALUES (45,'Restored allocation') RETURNING id")).rows).toEqual([{ id: 901 }]);
  } finally { await harness.dispose(); }
});
