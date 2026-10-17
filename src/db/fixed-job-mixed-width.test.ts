import { expect, test } from "bun:test";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { byteLength } from "./access";
import { createLocalD1 } from "./local-d1";
import { applyMigrations, loadMigrations, migrationChecksum } from "./migrations";
import { createFixedD1JobWorker, type FixedD1Job } from "./fixed-job-worker";
import { estimateFixedD1Verification } from "./fixed-job-native";
import { createD1TransferSource, inventorySource, reviewedSchema } from "./transfer";
import { scalar } from "./transfer-native";
import { recordReply } from "./fixed-job-test-protocol";

function observe(binding: D1Database, afterRaw?: (sql: string) => Promise<void>) {
  let queries = 0, batches = 0, pages = 0, maxRows = 0, maxBytes = 0, emptyPages = 0, shortPages = 0;
  const statement = (value: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(value, {
    get(target, key) {
      if (key === "bind") return (...args: Parameters<D1PreparedStatement["bind"]>) => statement(target.bind(...args), sql);
      if (key === "raw") return async (...args: Parameters<D1PreparedStatement["raw"]>) => {
        queries++;
        const result = await target.raw(...args);
        if (sql.startsWith("WITH candidate")) {
          const [header, ...rows] = result;
          if (!Array.isArray(header)) throw new Error("Missing actual native columns");
          const records = rows.map((row) => Object.fromEntries(header.map((column, index) => [String(column), row[index]])));
          pages++;
          if (!rows.length) emptyPages++;
          else if (rows.length < 256) shortPages++;
          maxRows = Math.max(maxRows, rows.length);
          maxBytes = Math.max(maxBytes, byteLength(JSON.stringify(records)));
        }
        await afterRaw?.(sql);
        return result;
      };
      return Reflect.get(target, key);
    },
  });
  return {
    binding: new Proxy(binding, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => statement(target.prepare(sql), sql);
        if (key === "batch") return (values: D1PreparedStatement[]) => { batches++; queries += values.length; return target.batch(values); };
        return Reflect.get(target, key);
      },
    }),
    reset() { queries = 0; batches = 0; pages = 0; maxRows = 0; maxBytes = 0; emptyPages = 0; shortPages = 0; },
    result() { return { queries, batches, pages, maxRows, maxBytes, emptyPages, shortPages }; },
  };
}

async function actualJob(binding: D1Database) {
  const migrations = await loadMigrations();
  const source = createD1TransferSource(binding, { id: "synthetic-mixed-width", freezeRecord: {
    mode: "frozen-writers", sourceId: "synthetic-mixed-width", recordId: "mixed-width-fixture", frozenAt: 1700000000,
    evidence: "isolated synthetic rows only", writersPaused: ["fixture"], writersDrained: ["fixture"], manualWritersDrained: true, holdsUntilRelease: true,
  } });
  const reviewed = await reviewedSchema();
  const groups: FixedD1Job["groups"] = [];
  const inventory = await inventorySource({ ...source, async query(sql, args) {
    const rows = await source.query(sql, args);
    if (sql.startsWith("SELECT rowid AS transfer_rowid,")) {
      const table = reviewed.schema.tables.find((table) => sql.includes(`FROM "${table.name}"`));
      if (!table || rows.length > 64) throw new Error("Public fixture page changed");
      if (rows.length) {
        const values = rows.map((row) => {
          if (typeof row.transfer_rowid !== "number") throw new Error("Invalid native fixture rowid");
          return { rowid: row.transfer_rowid, values: table.columns.map((_, index) => scalar(row[`t${index}`], row[`c${index}`])) };
        });
        const payload = { index: groups.length, table: table.name, rows: values };
        groups.push({ index: payload.index, table: table.name, rowCount: values.length, lastRowid: values.at(-1)!.rowid, digest: await migrationChecksum(JSON.stringify(payload)) });
      }
    }
    return rows;
  } });
  const capability = "synthetic-mixed-width-capability";
  const job: FixedD1Job = {
    version: 1, runId: "10000000-0000-4000-8000-000000000033", expiresAt: Math.floor(Date.now() / 1000) + 600,
    target: { id: "synthetic-mixed-width", binding: "DB", intent: "staging" }, capabilityDigest: await migrationChecksum(capability),
    snapshotId: "20000000-0000-4000-8000-000000000033", snapshotDigest: await migrationChecksum(JSON.stringify(inventory)),
    sourceSchemaFingerprint: inventory.schemaFingerprint, sourceProfile: inventory.schemaCompatibility.profile,
    targetSchemaFingerprint: inventory.schemaCompatibility.targetSchemaFingerprint,
    schemaObjectsDigest: await migrationChecksum(JSON.stringify(reviewed.schema.objects)), excludedMetadataDigest: await migrationChecksum(JSON.stringify(reviewed.excluded)),
    ledgerDigest: await migrationChecksum(JSON.stringify(reviewed.ledger)), migrationFingerprint: inventory.migrationFingerprint, migrations: inventory.migrationHistory,
    tables: inventory.tables, sequence: inventory.sequence, groups,
  };
  const worker = createFixedD1JobWorker(job, migrations);
  return { job, async request(binding: D1Database, op: string) {
    return worker.fetch(new Request("https://fixed-job.invalid/job", { method: "POST", headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, runId: job.runId, targetId: job.target.id, intent: job.target.intent, snapshotDigest: job.snapshotDigest, op }),
    }), { DB: binding });
  } };
}

test("observed mixed-width all-table native verification admits a wide offer outlier and completes within the unchanged budget", async () => {
  const owner = await createLocalD1({ databaseNames: ["EMPTY"] });
  try {
    await applyMigrations(owner.binding, await loadMigrations());
    const offers = JSON.stringify([{ shop: "Synthetic", url: "https://example.invalid/offer", title: '界🌐"\u0000'.repeat(800), price: 12.5 }]);
    expect(byteLength(offers)).toBeGreaterThanOrEqual(7184);
    expect(Array.isArray(JSON.parse(offers))).toBe(true);
    await owner.binding.batch([
      owner.binding.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<84249) INSERT INTO games (id,steam_app_id,name,hltb_main,value_score,is_owned,tags,created_at,updated_at) SELECT 2*x,100000+x,'Synthetic ゲーム '||x,12.5,9.75,NULL,'[\"é\",\"City Builder\"]',1700000000,1700000001 FROM n"),
      owner.binding.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<26377) INSERT INTO game_deal_cache (rowid,steam_app_id,country,kind,checked_at,offers_json) SELECT 3*x-10,100000+x,'US','retail',1700000000,CASE WHEN x=13001 THEN ? ELSE '[]' END FROM n").bind(offers),
      owner.binding.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<13575) INSERT INTO itad_game_map SELECT 3*x,CASE WHEN x%2=0 THEN NULL ELSE 'synthetic-'||x END,1700000000 FROM n"),
      owner.binding.prepare("INSERT INTO __drizzle_migrations (rowid,id,hash,created_at) VALUES (-3,NULL,'保留 é',12.5),(8,NULL,'typed','not-a-time')"),
      owner.binding.prepare("INSERT INTO catalog_refresh_failures VALUES (999999,'Orphan','synthetic',4,1700000004)"),
      owner.binding.prepare("INSERT INTO catalog_refresh_state (key,updated_at) VALUES ('steam_official_catalog',1700000004)"),
      owner.binding.prepare("INSERT INTO deal_refresh_state (rowid,country,last_error) VALUES (-2,'GB','synthetic')"),
      owner.binding.prepare("INSERT INTO sync_state (rowid,key,updated_at) VALUES (-1,NULL,1700000002),(4,NULL,1700000003)"),
      owner.binding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (950000,999999,'Deleted allocation')"),
      owner.binding.prepare("DELETE FROM games WHERE id=950000"),
    ]);
    const { job, request } = await actualJob(owner.binding);
    const estimate = estimateFixedD1Verification(job.tables);
    console.log(JSON.stringify({ observation: "mixed-width-canonical-admission", estimate, tables: job.tables.map(({ name, rowCount, bytes, maxRowBytes, maxScalarBytes }) => ({ name, rowCount, bytes, maxRowBytes, maxScalarBytes })) }));
    expect(estimate).toBeLessThanOrEqual(960);
    expect(job.tables.map((table) => [table.name, table.rowCount])).toEqual([
      ["__drizzle_migrations", 2], ["catalog_refresh_failures", 1], ["catalog_refresh_state", 1], ["deal_refresh_state", 1],
      ["game_deal_cache", 26377], ["games", 84249], ["itad_game_map", 13575], ["sync_state", 2],
    ]);
    expect(job.tables.find((table) => table.name === "game_deal_cache")!.maxScalarBytes).toBeGreaterThanOrEqual(7184);
    expect(job.sequence).toEqual([{ name: "games", seq: 950000 }]);
    const empty = observe(await owner.getBinding("EMPTY"));
    const bootstrap = await request(empty.binding, "bootstrap");
    const prepared = await recordReply(bootstrap);
    console.log(JSON.stringify({ observation: "mixed-width-bootstrap", status: bootstrap.status, result: prepared, ...empty.result() }));
    expect(bootstrap.status).toBe(200);
    expect(prepared).toMatchObject({ ok: true, state: "prepared" });
    await owner.binding.prepare("UPDATE sqlite_sequence SET seq=168498 WHERE name='games'").run();
    const meter = observe(owner.binding);
    for (const op of ["inventory", "sequence", "validate"]) {
      meter.reset();
      const response = await request(meter.binding, op);
      const value = await recordReply(response);
      console.log(JSON.stringify({ observation: "mixed-width-native-query-count", op, status: response.status, ...meter.result() }));
      expect(response.status).toBe(200);
      if (op !== "sequence") expect(value).toMatchObject({ tables: job.tables, sequence: [{ name: "games", seq: op === "inventory" ? 168498 : 950000 }] });
      else expect(value).toEqual({ ok: true, phase: "sequence", changed: true });
      expect(meter.result().queries).toBeLessThanOrEqual(960);
      expect(meter.result().pages).toBeGreaterThan(0);
      expect(meter.result().maxRows).toBeLessThanOrEqual(256);
      expect(meter.result().maxBytes).toBeLessThanOrEqual(2097152);
      expect(meter.result().emptyPages).toBe(8);
    }
  } finally { await owner.dispose(); }
}, 120000);

test("byte-limited Unicode prefixes continue into full row-limited pages and a final empty page without losing typed rows", async () => {
  const owner = await createLocalD1();
  try {
    await applyMigrations(owner.binding, await loadMigrations());
    const wide = '界🌐"\u0000'.repeat(2000);
    await owner.binding.batch([
      owner.binding.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300) INSERT INTO games (id,steam_app_id,name,hltb_main,is_owned,created_at,updated_at) SELECT 2*x,x,CASE WHEN x<=40 THEN ? ELSE 'narrow' END,12.5,NULL,1700000000,1700000001 FROM n").bind(wide),
      owner.binding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (1200,1200,'deleted')"),
      owner.binding.prepare("DELETE FROM games WHERE id=1200"),
    ]);
    const { job, request } = await actualJob(owner.binding);
    expect(job.tables.find((table) => table.name === "games")).toMatchObject({ rowCount: 300, maxScalarBytes: 18000 });
    const meter = observe(owner.binding);
    const response = await request(meter.binding, "validate");
    expect(response.status).toBe(200);
    expect(await recordReply(response)).toMatchObject({ status: "data-verified", tables: job.tables, sequence: [{ name: "games", seq: 1200 }] });
    console.log(JSON.stringify({ observation: "mixed-width-byte-row-boundaries", ...meter.result() }));
    expect(meter.result().maxRows).toBe(256);
    expect(meter.result().shortPages).toBeGreaterThanOrEqual(3);
    expect(meter.result().emptyPages).toBe(8);
    expect(meter.result().maxBytes).toBeLessThanOrEqual(2097152);
    expect(meter.result().queries).toBeLessThanOrEqual(960);
    expect(meter.result().batches).toBe(0);
  } finally { await owner.dispose(); }
}, 15000);

test.each([
  { label: "near-budget single-wide rows", size: 340000, count: 2, accepted: true },
  { label: "over-budget single-wide row", size: 350000, count: 1, accepted: false },
])("canonical byte-boundary admission and real native completeness: $label", async ({ size, count, accepted }) => {
  const owner = await createLocalD1({ databaseNames: ["EMPTY"] });
  try {
    await applyMigrations(owner.binding, await loadMigrations());
    await owner.binding.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO games (steam_app_id,name,created_at,updated_at) SELECT x,?,1700000000,1700000001 FROM n").bind(count, "w".repeat(size)).run();
    const { job, request } = await actualJob(owner.binding);
    expect(job.tables.find((table) => table.name === "games")).toMatchObject({ rowCount: count, maxScalarBytes: size });
    const empty = observe(await owner.getBinding("EMPTY"));
    const bootstrap = await request(empty.binding, "bootstrap");
    if (!accepted) {
      expect(bootstrap.status).toBe(400);
      expect(await recordReply(bootstrap)).toEqual({ ok: false, code: "UNSUPPORTED_DATA", outcome: "not-applied" });
      expect(empty.result().queries).toBe(0);
      expect(empty.result().batches).toBe(0);
      expect(await (await owner.getBinding("EMPTY")).prepare("SELECT name FROM sqlite_schema WHERE name <> '_cf_METADATA'").raw()).toEqual([]);
    } else {
      expect(bootstrap.status).toBe(200);
      const meter = observe(owner.binding);
      const response = await request(meter.binding, "validate");
      expect(response.status).toBe(200);
      expect(await recordReply(response)).toMatchObject({ status: "data-verified", tables: job.tables, sequence: [{ name: "games", seq: 2 }] });
      console.log(JSON.stringify({ observation: "mixed-width-single-wide-boundary", size, ...meter.result() }));
      expect(meter.result().maxRows).toBe(1);
      expect(meter.result().shortPages).toBe(2);
      expect(meter.result().emptyPages).toBe(8);
      expect(meter.result().pages).toBe(10);
      expect(meter.result().maxBytes).toBeGreaterThan(340000);
      expect(meter.result().maxBytes).toBeLessThanOrEqual(2097152);
      expect(meter.result().queries).toBeLessThanOrEqual(960);
    }
  } finally { await owner.dispose(); }
}, 15000);

test("same-count scalar-byte growth during actual native paging stops before sequence reconciliation", async () => {
  const owner = await createLocalD1();
  try {
    await applyMigrations(owner.binding, await loadMigrations());
    await owner.binding.batch([
      owner.binding.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300) INSERT INTO games (id,steam_app_id,name,created_at,updated_at) SELECT 2*x,x,'narrow',1700000000,1700000001 FROM n"),
      owner.binding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (1200,1200,'deleted')"),
      owner.binding.prepare("DELETE FROM games WHERE id=1200"),
    ]);
    const { request } = await actualJob(owner.binding);
    await owner.binding.prepare("UPDATE sqlite_sequence SET seq=600 WHERE name='games'").run();
    let grew = false;
    const meter = observe(owner.binding, async (sql) => {
      if (!grew && sql.startsWith("WITH candidate") && sql.includes('FROM "games"')) {
        grew = true;
        await owner.binding.prepare("UPDATE games SET name=? WHERE id=600").bind("growth".repeat(5000)).run();
      }
    });
    const response = await request(meter.binding, "sequence");
    expect(response.status).toBe(400);
    expect(await recordReply(response)).toEqual({ ok: false, code: "TRANSFER_FAILED", outcome: "not-applied" });
    expect(grew).toBe(true);
    expect(meter.result().batches).toBe(0);
    expect(meter.result().queries).toBeLessThanOrEqual(960);
    expect(await owner.binding.prepare("SELECT COUNT(*) FROM games").raw()).toEqual([[300]]);
    expect(await owner.binding.prepare("SELECT seq FROM sqlite_sequence WHERE name='games'").raw()).toEqual([[600]]);
  } finally { await owner.dispose(); }
}, 15000);
