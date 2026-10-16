import { expect, test } from "bun:test";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { createLocalD1 } from "./local-d1";
import { applyMigrations, loadMigrations, migrationChecksum } from "./migrations";
import { createFixedD1JobWorker, type FixedD1Job } from "./fixed-job-worker";
import { createD1TransferSource, inventorySource, reviewedSchema } from "./transfer";
import { scalar } from "./transfer-native";
import { pageReply, recordReply, type FixedD1TestPage } from "./fixed-job-test-protocol";

function observedBinding(binding: D1Database, afterRaw?: (sql: string) => Promise<void>) {
  let queries = 0;
  let batches = 0;
  const statement = (value: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(value, {
    get(target, key) {
      if (key === "bind") return (...args: Parameters<D1PreparedStatement["bind"]>) => statement(target.bind(...args), sql);
      if (key === "raw") return async (...args: Parameters<D1PreparedStatement["raw"]>) => { queries++; const result = await target.raw(...args); await afterRaw?.(sql); return result; };
      return Reflect.get(target, key);
    },
  });
  return {
    binding: new Proxy(binding, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => statement(target.prepare(sql), sql);
        if (key === "batch") return (statements: D1PreparedStatement[]) => { batches++; queries += statements.length; return target.batch(statements); };
        return Reflect.get(target, key);
      },
    }),
    reset() { queries = 0; batches = 0; },
    count() { return queries; },
    batches() { return batches; },
  };
}

async function productionFixture(binding: D1Database) {
  const migrations = await loadMigrations();
  await applyMigrations(binding, migrations);
  await binding.batch([
    binding.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<84249) INSERT INTO games (id,steam_app_id,name,hltb_main,value_score,is_owned,tags,created_at,updated_at) SELECT x,100000+x,'Native ゲーム '||x,12.5,9.75,NULL,'[\"é\",\"City Builder\"]',1700000000,1700000001 FROM n"),
    binding.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<26377) INSERT INTO game_deal_cache (rowid,steam_app_id,country,kind,checked_at,offers_json) SELECT x,100000+x,'US','retail',1700000000,'[]' FROM n"),
    binding.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<13575) INSERT INTO itad_game_map SELECT 100000+x,CASE WHEN x%2=0 THEN NULL ELSE 'native-'||x END,1700000000 FROM n"),
    binding.prepare("INSERT INTO __drizzle_migrations (rowid,id,hash,created_at) VALUES (-3,NULL,'保留 é',12.5),(8,NULL,'typed','not-a-time')"),
    binding.prepare("INSERT INTO catalog_refresh_failures VALUES (999999,'Orphan','synthetic failure',4,1700000004)"),
    binding.prepare("INSERT INTO catalog_refresh_state (key,updated_at) VALUES ('steam_official_catalog',1700000004)"),
    binding.prepare("INSERT INTO deal_refresh_state (rowid,country,last_error) VALUES (-2,'GB','synthetic')"),
    binding.prepare("INSERT INTO sync_state (rowid,key,updated_at) VALUES (-1,NULL,1700000002),(4,NULL,1700000003)"),
    binding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (950000,999999,'Deleted allocation')"),
    binding.prepare("DELETE FROM games WHERE id=950000"),
  ]);
  return jobFromBinding(binding);
}

async function jobFromBinding(binding: D1Database) {
  const migrations = await loadMigrations();
  const source = createD1TransferSource(binding, { id: "synthetic-production-size", freezeRecord: {
    mode: "frozen-writers", sourceId: "synthetic-production-size", recordId: "native-fixture", frozenAt: 1700000000,
    evidence: "isolated synthetic native fixture", writersPaused: ["fixture"], writersDrained: ["fixture"], manualWritersDrained: true, holdsUntilRelease: true,
  } });
  const reviewed = await reviewedSchema();
  const groups: FixedD1Job["groups"] = [];
  const inventory = await inventorySource({ ...source, async query(sql, args) {
    const rows = await source.query(sql, args);
    if (sql.startsWith("SELECT rowid AS transfer_rowid,")) {
      const table = reviewed.schema.tables.find((table) => sql.includes(`FROM "${table.name}"`));
      if (!table || rows.length > 64) throw new Error("Unexpected public native fixture page");
      if (rows.length) {
        const values = rows.map((row) => {
          if (typeof row.transfer_rowid !== "number") throw new Error("Invalid actual native fixture rowid");
          return { rowid: row.transfer_rowid, values: table.columns.map((_, index) => scalar(row[`t${index}`], row[`c${index}`])) };
        });
        const payload = { index: groups.length, table: table.name, rows: values };
        groups.push({ index: payload.index, table: table.name, rowCount: values.length, lastRowid: values.at(-1)!.rowid, digest: await migrationChecksum(JSON.stringify(payload)) });
      }
    }
    return rows;
  } });
  const capability = "synthetic-production-size-run-capability";
  const job: FixedD1Job = {
    version: 1, runId: "10000000-0000-4000-8000-000000000032", expiresAt: Math.floor(Date.now() / 1000) + 600,
    target: { id: "synthetic-production-size", binding: "DB", intent: "staging" }, capabilityDigest: await migrationChecksum(capability),
    snapshotId: "20000000-0000-4000-8000-000000000032", snapshotDigest: await migrationChecksum(JSON.stringify(inventory)),
    sourceSchemaFingerprint: inventory.schemaFingerprint, sourceProfile: inventory.schemaCompatibility.profile,
    targetSchemaFingerprint: inventory.schemaCompatibility.targetSchemaFingerprint,
    schemaObjectsDigest: await migrationChecksum(JSON.stringify(reviewed.schema.objects)), excludedMetadataDigest: await migrationChecksum(JSON.stringify(reviewed.excluded)),
    ledgerDigest: await migrationChecksum(JSON.stringify(reviewed.ledger)), migrationFingerprint: inventory.migrationFingerprint, migrations: inventory.migrationHistory,
    tables: inventory.tables, sequence: inventory.sequence, groups,
  };
  return { job, migrations, capability };
}

test("production-size all-table native verification stays below 1000 queries per invocation without changing public pages", async () => {
  const owner = await createLocalD1();
  try {
    const { job, migrations, capability } = await productionFixture(owner.binding);
    expect(job.tables.filter((table) => ["games", "game_deal_cache", "itad_game_map"].includes(table.name)).map((table) => [table.name, table.rowCount])).toEqual([["game_deal_cache", 26377], ["games", 84249], ["itad_game_map", 13575]]);
    await owner.binding.prepare("UPDATE sqlite_sequence SET seq=84249 WHERE name='games'").run();
    const meter = observedBinding(owner.binding);
    const worker = createFixedD1JobWorker(job, migrations);
    const request = (op: string, extra = {}) => worker.fetch(new Request("https://fixed-job.invalid/job", {
      method: "POST", headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, runId: job.runId, targetId: job.target.id, intent: job.target.intent, snapshotDigest: job.snapshotDigest, op, ...extra }),
    }), { DB: meter.binding });
    for (const op of ["inventory", "sequence", "validate"]) {
      meter.reset();
      const response = await request(op);
      expect(response.status).toBe(200);
      const value = await recordReply(response);
      if (op !== "sequence") expect(value).toMatchObject({ tables: job.tables, sequence: [{ name: "games", seq: op === "inventory" ? 84249 : 950000 }] });
      console.log(JSON.stringify({ observation: "local-real-native-query-count", op, queries: meter.count() }));
      expect(meter.count()).toBeLessThan(1000);
    }
    const page = await pageReply(await request("page", { table: "games", cursor: null }));
    expect(page.rows).toHaveLength(64);
    expect(page.complete).toBe(false);
    expect(page.rows[0]!.values.slice(0, 3)).toEqual([["integer", 1], ["integer", 100001], ["text", "Native ゲーム 1"]]);
  } finally { await owner.dispose(); }
}, 120000);

function nativeRequest(job: FixedD1Job, capability: string, op: string, extra = {}) {
  return new Request("https://fixed-job.invalid/job", { method: "POST", headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/json" }, body: JSON.stringify({
    version: 1, runId: job.runId, targetId: job.target.id, intent: job.target.intent, snapshotDigest: job.snapshotDigest, op, ...extra,
  }) });
}

async function unsupportedSource(budget: "row-byte-budget" | "invocation-query-budget") {
  const owner = await createLocalD1({ databaseNames: ["EMPTY"] });
  try {
    await applyMigrations(owner.binding, await loadMigrations());
    const count = budget === "row-byte-budget" ? 1 : 900;
    const name = budget === "row-byte-budget" ? "界".repeat(200000) : "w".repeat(180000);
    await owner.binding.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO games (steam_app_id,name,created_at,updated_at) SELECT x,?,1700000000,1700000001 FROM n").bind(count, name).run();
    const { job, migrations, capability } = await jobFromBinding(owner.binding);
    expect(job.tables.find((table) => table.name === "games")!.rowCount).toBe(count);
    if (budget === "row-byte-budget") expect(job.tables.find((table) => table.name === "games")!.maxRowBytes).toBeGreaterThan(600000);
    else expect(job.tables.find((table) => table.name === "games")!.maxRowBytes).toBeLessThan(200000);
    const meter = observedBinding(await owner.getBinding("EMPTY"));
    const response = await createFixedD1JobWorker(job, migrations).fetch(nativeRequest(job, capability, "bootstrap"), { DB: meter.binding });
    expect(response.status).toBe(400);
    expect(await recordReply(response)).toEqual({ ok: false, code: "UNSUPPORTED_DATA", outcome: "not-applied" });
    expect(meter.count()).toBe(0);
    expect(meter.batches()).toBe(0);
    expect(await (await owner.getBinding("EMPTY")).prepare("SELECT name FROM sqlite_schema WHERE name <> '_cf_METADATA'").raw()).toEqual([]);
  } finally { await owner.dispose(); }
}

test("an actual unsupported wide source is refused before bootstrap or any target native query", () => unsupportedSource("row-byte-budget"), 15000);
test("an actual invocation-query overbudget source is refused before bootstrap or any target native query", () => unsupportedSource("invocation-query-budget"), 60000);

test("bounded native full verification preserves wide Unicode escapes, typed nulls and every public page", async () => {
  const owner = await createLocalD1();
  try {
    await applyMigrations(owner.binding, await loadMigrations());
    const wide = '界🌐"\u0000'.repeat(5000);
    await owner.binding.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<70) INSERT INTO games (id,steam_app_id,name,hltb_main,is_owned,created_at,updated_at) SELECT x,x,?,12.5,NULL,1700000000,1700000001 FROM n").bind(wide).run();
    const { job, migrations, capability } = await jobFromBinding(owner.binding);
    const meter = observedBinding(owner.binding);
    const worker = createFixedD1JobWorker(job, migrations);
    const response = await worker.fetch(nativeRequest(job, capability, "validate"), { DB: meter.binding });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "data-verified", tables: job.tables, sequence: [{ name: "games", seq: 70 }] });
    expect(meter.count()).toBeLessThan(1000);
    let cursor: number | null = null;
    const ids: number[] = [];
    let pages = 0;
    for (;;) {
      const page: FixedD1TestPage = await pageReply(await worker.fetch(nativeRequest(job, capability, "page", { table: "games", cursor }), { DB: meter.binding }));
      expect(page.rows.length).toBeLessThanOrEqual(64);
      for (const row of page.rows) {
        ids.push(row.rowid);
        expect([row.values[2], row.values[6], row.values[15]]).toEqual([["text", wide], ["real", 12.5], ["null", null]]);
      }
      pages++;
      if (page.complete) break;
      cursor = page.cursor;
    }
    expect(pages).toBeGreaterThan(1);
    expect(ids).toEqual(Array.from({ length: 70 }, (_, index) => index + 1));
  } finally { await owner.dispose(); }
}, 15000);

test("row growth during a real native verification scan stops before sequence mutation rather than reading an unbounded tail", async () => {
  const owner = await createLocalD1();
  try {
    await applyMigrations(owner.binding, await loadMigrations());
    await owner.binding.batch([
      owner.binding.prepare("INSERT INTO games (id,steam_app_id,name,created_at,updated_at) VALUES (1,1,'one',1700000000,1700000001),(2,2,'two',1700000000,1700000001),(950,950,'deleted',1700000000,1700000001)"),
      owner.binding.prepare("DELETE FROM games WHERE id=950"),
    ]);
    const { job, migrations, capability } = await jobFromBinding(owner.binding);
    await owner.binding.prepare("UPDATE sqlite_sequence SET seq=2 WHERE name='games'").run();
    let grew = false;
    const meter = observedBinding(owner.binding, async (sql) => {
      if (!grew && sql.startsWith("SELECT COUNT(*)") && sql.endsWith('FROM "games"')) {
        grew = true;
        await owner.binding.prepare("INSERT INTO games (id,steam_app_id,name,created_at,updated_at) VALUES (3,3,'new',1700000000,1700000001)").run();
      }
    });
    const response = await createFixedD1JobWorker(job, migrations).fetch(nativeRequest(job, capability, "sequence"), { DB: meter.binding });
    expect(response.status).toBe(400);
    expect(await recordReply(response)).toEqual({ ok: false, code: "FREEZE_REQUIRED", outcome: "not-applied" });
    expect(grew).toBe(true);
    expect(meter.batches()).toBe(0);
    expect(await owner.binding.prepare("SELECT seq FROM sqlite_sequence WHERE name='games'").raw()).toEqual([[3]]);
  } finally { await owner.dispose(); }
}, 15000);
