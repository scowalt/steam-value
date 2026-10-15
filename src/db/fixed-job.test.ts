import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, open, rename, rm, stat, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { isDbValue, isRecord, type DbValue } from "./access";
import { Miniflare } from "miniflare";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectReleasedD1Owners, createLocalD1, disposeD1Runtime, type LocalD1Owner } from "./local-d1";
import { applyMigrations, loadMigrations, migrationChecksum } from "./migrations";
import { legacySchemaStatements } from "./schema-profile";
import { createLocalFixedD1JobRunner, prepareFixedD1Job } from "./fixed-job-host";
import { createD1TransferSource, createD1TransferTarget, createProtectedImportReceiptPublisher, exportSnapshot, importSnapshot, inventorySource, openLocalTransferHandle, validateSnapshot, type SnapshotRow, type TypedValue } from "./transfer";

function ownedUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Native ownership fixtures require a Unix UID");
  return uid;
}

async function reply(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error("Invalid fixed-job object response");
  return value;
}

function typedValue(value: unknown): value is TypedValue {
  if (!Array.isArray(value) || value.length !== 2) return false;
  return value[0] === "null" ? value[1] === null
    : value[0] === "text" ? typeof value[1] === "string"
    : value[0] === "integer" ? typeof value[1] === "number" && Number.isSafeInteger(value[1])
    : value[0] === "real" && typeof value[1] === "number" && Number.isFinite(value[1]);
}

function snapshotRow(value: unknown): value is SnapshotRow {
  return isRecord(value) && typeof value.rowid === "number" && Number.isSafeInteger(value.rowid) && Array.isArray(value.values) && value.values.every(typedValue);
}

interface PageReply {
  ok: true;
  columns: string[];
  rows: SnapshotRow[];
  cursor: number | null;
  complete: boolean;
}

async function pageReply(response: Response): Promise<PageReply> {
  const value = await reply(response);
  if (value.ok !== true || !Array.isArray(value.columns) || !value.columns.every((column): column is string => typeof column === "string") ||
    !Array.isArray(value.rows) || !value.rows.every(snapshotRow) || !(value.cursor === null || (typeof value.cursor === "number" && Number.isSafeInteger(value.cursor))) || typeof value.complete !== "boolean") throw new Error("Invalid fixed-job page response");
  return { ...value, ok: true, columns: value.columns, rows: value.rows, cursor: value.cursor, complete: value.complete };
}

interface TableReply { name: string; rowCount: number }
function tableReply(value: unknown): value is TableReply {
  return isRecord(value) && typeof value.name === "string" && typeof value.rowCount === "number" && Number.isSafeInteger(value.rowCount) && value.rowCount >= 0;
}

async function contentReply(response: Response): Promise<Record<string, unknown> & { tables: TableReply[] }> {
  const value = await reply(response);
  if (!Array.isArray(value.tables) || !value.tables.every(tableReply)) throw new Error("Invalid fixed-job content response");
  return { ...value, tables: value.tables };
}

interface ColumnReply { name: string; notnull: number; dflt_value: DbValue }
interface SchemaTableReply { name: string; columns: ColumnReply[] }
interface SchemaObjectReply { name: string; type: string }
function columnReply(value: unknown): value is ColumnReply {
  return isRecord(value) && typeof value.name === "string" && typeof value.notnull === "number" && isDbValue(value.dflt_value);
}
function schemaTableReply(value: unknown): value is SchemaTableReply {
  return isRecord(value) && typeof value.name === "string" && Array.isArray(value.columns) && value.columns.every(columnReply);
}
function schemaObjectReply(value: unknown): value is SchemaObjectReply {
  return isRecord(value) && typeof value.name === "string" && typeof value.type === "string";
}
async function inventoryReply(response: Response): Promise<Record<string, unknown> & { tables: TableReply[]; schema: { objects: SchemaObjectReply[]; tables: SchemaTableReply[] } }> {
  const value = await contentReply(response);
  if (!isRecord(value.schema) || !Array.isArray(value.schema.objects) || !value.schema.objects.every(schemaObjectReply) ||
    !Array.isArray(value.schema.tables) || !value.schema.tables.every(schemaTableReply)) throw new Error("Invalid fixed-job schema response");
  return { ...value, schema: { ...value.schema, objects: value.schema.objects, tables: value.schema.tables } };
}

let owner: LocalD1Owner;
let next = 0;
const directories: string[] = [];

beforeAll(async () => {
  owner = await createLocalD1({ databaseNames: Array.from({ length: 100 }, (_, index) => `FIXED_JOB_${index}`) });
});

afterAll(async () => {
  await owner.dispose();
  for (const directory of directories) await rm(directory, { recursive: true });
});

function freeze(sourceId: string) {
  return {
    mode: "frozen-writers" as const, sourceId, recordId: "local-native-job-fixture", frozenAt: 1700000000,
    evidence: "synthetic isolated fixture without other writers", writersPaused: ["fixture"], writersDrained: ["fixture"],
    manualWritersDrained: true as const, holdsUntilRelease: true as const,
  };
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "steam-value-fixed-job-"));
  directories.push(path);
  return path;
}

type FixtureTable = "__drizzle_migrations" | "catalog_refresh_failures" | "catalog_refresh_state" | "deal_refresh_state" | "game_deal_cache" | "games" | "itad_game_map" | "sync_state";
const literalRows: Record<FixtureTable, SnapshotRow[]> & Record<string, SnapshotRow[]> = {
  __drizzle_migrations: [
    { rowid: -3, values: [["null", null], ["text", "synthetic-ledger-ü"], ["real", 12.5]] },
    { rowid: 8, values: [["null", null], ["text", "synthetic-ledger-2"], ["text", "not-a-time"]] },
  ],
  catalog_refresh_failures: [{ rowid: 800, values: [["integer", 800], ["text", "Orphan"], ["text", "fixture failure"], ["integer", 4], ["integer", 1700000004]] }],
  catalog_refresh_state: [{ rowid: 1, values: [["text", "steam_official_catalog"], ["integer", 42], ["integer", 1700000000], ["null", null], ["integer", 100], ["integer", 7], ["integer", 6], ["integer", 1], ["integer", 2], ["integer", 3], ["integer", 0], ["integer", 4], ["null", null], ["integer", 1700000004]] }],
  deal_refresh_state: [{ rowid: -2, values: [["text", "GB"], ["null", null], ["integer", 1700000001], ["text", "fixture deal error"], ["text", "synthetic-lock"], ["integer", 1700000900], ["integer", 2]] }],
  game_deal_cache: [
    { rowid: 1, values: [["integer", 42], ["text", "US"], ["text", "retail"], ["integer", 1700000000], ["text", "[]"]] },
    { rowid: 9, values: [["integer", 800], ["text", "GB"], ["text", "bundle"], ["integer", 1700000001], ["text", '[ {"priceCents":null,"validUntil":1700086400} ]']] },
  ],
  games: [{ rowid: 7, values: [
    ["integer", 7], ["integer", 42], ["text", "Native ü; fixture"], ["integer", 95], ["integer", 1234], ["integer", 23],
    ["real", 12.5], ["null", null], ["real", 40.25], ["real", 9.75], ["integer", 0], ["integer", 1], ["null", null],
    ["text", "full"], ["text", "2020-01-02"], ["integer", 1], ["integer", 0], ["integer", 0], ["integer", 1], ["integer", 0],
    ["integer", 1], ["integer", 0], ["integer", 1], ["integer", 0], ["integer", 1], ["integer", 0], ["integer", 1], ["null", null],
    ["text", '[ "City Builder", "é" ]'], ["integer", 1700000000], ["integer", 1700000001],
  ] }],
  itad_game_map: [
    { rowid: 42, values: [["integer", 42], ["text", "synthetic-itad"], ["integer", 1700000000]] },
    { rowid: 800, values: [["integer", 800], ["null", null], ["integer", 1700000001]] },
  ],
  sync_state: [
    { rowid: -1, values: [["null", null], ["null", null], ["null", null], ["null", null], ["integer", 0], ["null", null], ["integer", 0], ["integer", 0], ["integer", 0], ["integer", 0], ["integer", 0], ["integer", 1700000002]] },
    { rowid: 4, values: [["null", null], ["null", null], ["null", null], ["text", "fixture sync error"], ["integer", 0], ["null", null], ["integer", 0], ["integer", 0], ["integer", 0], ["integer", 0], ["integer", 0], ["integer", 1700000003]] },
    { rowid: 8, values: [["text", "steam_status"], ["integer", 1700000004], ["integer", 1700000001], ["null", null], ["integer", 1], ["integer", 1700000900], ["integer", 2], ["integer", 3], ["integer", 4], ["integer", 5], ["integer", 6], ["integer", 1700000004]] },
  ],
};

async function syntheticSnapshot(profile: "prepared" | "legacy") {
  const binding = await owner.getBinding(`FIXED_JOB_${next++}`);
  if (profile === "prepared") await applyMigrations(binding, await loadMigrations());
  else await binding.batch((await legacySchemaStatements()).map((sql) => binding.prepare(sql)));
  await binding.batch([
    binding.prepare("INSERT INTO __drizzle_migrations (rowid,id,hash,created_at) VALUES (-3,NULL,'synthetic-ledger-ü',12.5),(8,NULL,'synthetic-ledger-2','not-a-time')"),
    binding.prepare("INSERT INTO catalog_refresh_failures VALUES (800,'Orphan','fixture failure',4,1700000004)"),
    binding.prepare("INSERT INTO catalog_refresh_state VALUES ('steam_official_catalog',42,1700000000,NULL,100,7,6,1,2,3,0,4,NULL,1700000004)"),
    binding.prepare("INSERT INTO deal_refresh_state (rowid,country,last_success_at,last_error,lock_token,lock_expires_at,games_checked) VALUES (-2,'GB',1700000001,'fixture deal error','synthetic-lock',1700000900,2)"),
    binding.prepare(`INSERT INTO game_deal_cache (rowid,steam_app_id,country,kind,checked_at,offers_json) VALUES (1,42,'US','retail',1700000000,'[]'),(9,800,'GB','bundle',1700000001,'[ {"priceCents":null,"validUntil":1700086400} ]')`),
    binding.prepare(`INSERT INTO games (id,steam_app_id,name,steam_review_score,steam_review_count,hltb_id,hltb_main,hltb_main_extra,hltb_completionist,value_score,is_endless,is_on_wishlist,is_early_access,controller_support,release_date,is_owned,is_ignored,playtime_minutes,has_single_player,has_multiplayer,has_co_op,has_online_co_op,has_local_co_op,has_pvp,has_online_pvp,has_local_pvp,has_crossplatform,is_mmo,tags,created_at,updated_at) VALUES (7,42,'Native ü; fixture',95,1234,23,12.5,NULL,40.25,9.75,0,1,NULL,'full','2020-01-02',1,0,0,1,0,1,0,1,0,1,0,1,NULL,'[ "City Builder", "é" ]',1700000000,1700000001)`),
    binding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (950,99,'Deleted fixture allocation')"),
    binding.prepare("DELETE FROM games WHERE id=950"),
    binding.prepare("INSERT INTO itad_game_map VALUES (42,'synthetic-itad',1700000000),(800,NULL,1700000001)"),
    binding.prepare("INSERT INTO sync_state (rowid,key,updated_at) VALUES (-1,NULL,1700000002)"),
    binding.prepare("INSERT INTO sync_state (rowid,key,last_error,updated_at) VALUES (4,NULL,'fixture sync error',1700000003)"),
    binding.prepare("INSERT INTO sync_state (rowid,key,last_attempt_at,last_success_at,is_running,lock_expires_at,ignored_count,wishlist_count,owned_count,games_updated,games_removed,updated_at) VALUES (8,'steam_status',1700000004,1700000001,1,1700000900,2,3,4,5,6,1700000004)"),
  ]);
  const source = createD1TransferSource(binding, { id: "synthetic-fixed-source", freezeRecord: freeze("synthetic-fixed-source") });
  return exportSnapshot(source, join(await directory(), "snapshot"), source.freezeRecord);
}

const runOptions = (capability: string) => ({
  runId: "10000000-0000-4000-8000-000000000031", targetId: "synthetic-fixed-target", intent: "staging" as const,
  expiresAt: Math.floor(Date.now() / 1000) + 600, capabilityDigest: migrationChecksum(capability),
});

async function preparedJob(profile: "prepared" | "legacy" = "legacy") {
  const capability = "synthetic-fixed-run-only-capability";
  const options = runOptions(capability);
  const snapshot = await syntheticSnapshot(profile);
  const packet = await prepareFixedD1Job(snapshot, join(await directory(), "job"), { ...options, capabilityDigest: await options.capabilityDigest });
  return { packet, snapshot, capability };
}

test("host preparation fixes reviewed identity and ordered group digests without putting full rows in the Worker input", async () => {
  const { packet, snapshot } = await preparedJob();
  const text = await Bun.file(join(packet.directory, "job.json")).text();
  const job = JSON.parse(text);
  expect(job).toMatchObject({ version: 1, runId: "10000000-0000-4000-8000-000000000031", target: { id: "synthetic-fixed-target", binding: "DB", intent: "staging" }, snapshotId: snapshot.manifest.snapshotId,
    sourceSchemaFingerprint: snapshot.manifest.schemaFingerprint, sourceProfile: "observed-legacy-v1", targetSchemaFingerprint: snapshot.manifest.schemaCompatibility.targetSchemaFingerprint });
  expect(job.groups.map((group: { table: string; index: number; rowCount: number }) => [group.index, group.table, group.rowCount])).toEqual([
    [0, "__drizzle_migrations", 2], [1, "catalog_refresh_failures", 1], [2, "catalog_refresh_state", 1], [3, "deal_refresh_state", 1],
    [4, "game_deal_cache", 2], [5, "games", 1], [6, "itad_game_map", 2], [7, "sync_state", 3],
  ]);
  for (const [index, table] of Object.keys(literalRows).entries()) {
    expect(await Bun.file(join(packet.directory, `${index}.json`)).json()).toEqual({ index, table, rows: literalRows[table] });
    expect((await stat(join(packet.directory, `${index}.json`))).mode & 0o777).toBe(0o600);
  }
  expect(text.includes("Native ü; fixture")).toBe(false);
  expect(text.includes("synthetic-ledger-ü")).toBe(false);
  expect(text.length).toBeLessThan(100000);
  expect((await stat(packet.directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(packet.directory, "job.json"))).mode & 0o777).toBe(0o600);
  await expect(prepareFixedD1Job(snapshot, packet.directory, { ...runOptions("synthetic-other-capability"), capabilityDigest: await migrationChecksum("synthetic-other-capability") })).rejects.toMatchObject({ code: "ARTIFACT_UNSAFE" });
}, 15000);

async function jobRequests(job: object, withBinding = true) {
  const entry = join(await directory(), "fixed-worker.ts");
  const file = await open(entry, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.() || info.nlink !== 1) throw new Error("Unsafe fixture build input");
    await file.writeFile(`import { createFixedD1JobWorker } from ${JSON.stringify(new URL("./fixed-job-worker.ts", import.meta.url).pathname)}; export default createFixedD1JobWorker(${JSON.stringify(job)},${JSON.stringify(await loadMigrations())});`);
  } finally { await file.close(); }
  const build = await Bun.build({ entrypoints: [entry], target: "browser", minify: true, plugins: [{
    name: "native-worker-crypto", setup(build) {
      build.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: "node:crypto", external: true }));
    },
  }] });
  if (!build.success || build.outputs.length !== 1 || !build.outputs[0]) throw new Error("Actual fixed-job Worker build failed");
  const script = await build.outputs[0].text();
  collectReleasedD1Owners();
  const sharedDatabase = `fixed-job-${crypto.randomUUID()}`;
  const runtime = new Miniflare({
    workers: ["first", "second"].map((name) => ({
      name, modules: true, script, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
      d1Databases: withBinding ? { DB: sharedDatabase } : {},
    })),
    d1Persist: false, cf: false, host: "127.0.0.1", port: 0,
  });
  return {
    async request(body: unknown, capability?: string, lifecycle = "first") {
      const worker = await runtime.getWorker(lifecycle);
      const response = await worker.fetch("https://fixed-job.invalid/job", {
        method: "POST", headers: { "Content-Type": "application/json", ...(capability === undefined ? {} : { Authorization: `Bearer ${capability}` }) },
        body: JSON.stringify(body),
      });
      return new Response(await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) });
    },
    async dispose() { await disposeD1Runtime(runtime); },
  };
}

test("fixed-job requests require a distinct capability before any configured or absent native binding", async () => {
  const capability = "synthetic-fixed-run-only-capability";
  const { packet } = await preparedJob();
  const job = packet.job;
  for (const withBinding of [false, true]) {
    const requests = await jobRequests(job, withBinding);
    try {
      for (const supplied of [undefined, "synthetic-viewer-cookie", "synthetic-existing-machine-token"]) {
        const response = await requests.request({ op: "bootstrap" }, supplied);
        expect(response.status).toBe(401);
        expect(await reply(response)).toEqual({ ok: false, code: "UNAUTHORIZED", outcome: "not-applied" });
      }
      if (!withBinding) expect((await requests.request({ op: "bootstrap" }, capability)).status).toBe(503);
    } finally { await requests.dispose(); }
  }
}, 15000);

function identity(job: { runId: string; target: { id: string; intent: string }; snapshotDigest: string }) {
  return { version: 1, runId: job.runId, targetId: job.target.id, intent: job.target.intent, snapshotDigest: job.snapshotDigest };
}

test("fixed-job identity and expiry refuse before bootstrap while a valid fixed bootstrap retains immutable schema", async () => {
  const { packet, capability } = await preparedJob();
  const requests = await jobRequests(packet.job);
  const common = identity(packet.job);
  try {
    for (const body of [
      { ...common, op: "bootstrap", runId: "20000000-0000-4000-8000-000000000031" },
      { ...common, op: "bootstrap", targetId: "another-target" },
      { ...common, op: "bootstrap", intent: "empty" },
      { ...common, op: "bootstrap", snapshotDigest: "0".repeat(64) },
      { ...common, op: "reset" },
      { ...common, op: "bootstrap", sql: "DELETE FROM games" },
      { ...common, op: "bootstrap", database: "another-binding" },
    ]) {
      const response = await requests.request(body, capability);
      expect(response.status).toBe(400);
      expect(await reply(response)).toEqual({ ok: false, code: "ARTIFACT_INVALID", outcome: "not-applied" });
    }
    expect(await reply(await requests.request({ ...common, op: "inventory" }, capability))).toEqual({ ok: true, state: "uninitialized" });
    const bootstrap = await requests.request({ ...common, op: "bootstrap" }, capability);
    expect(bootstrap.status).toBe(200);
    expect(await reply(bootstrap)).toMatchObject({ ok: true, state: "prepared", schemaFingerprint: packet.job.targetSchemaFingerprint });
    const inventory = await inventoryReply(await requests.request({ ...common, op: "inventory" }, capability, "second"));
    expect(inventory).toMatchObject({ ok: true, state: "prepared", tables: [
      { name: "__drizzle_migrations", rowCount: 0 }, { name: "catalog_refresh_failures", rowCount: 0 }, { name: "catalog_refresh_state", rowCount: 0 },
      { name: "deal_refresh_state", rowCount: 0 }, { name: "game_deal_cache", rowCount: 0 }, { name: "games", rowCount: 0 }, { name: "itad_game_map", rowCount: 0 }, { name: "sync_state", rowCount: 0 },
    ], sequence: [] });
    expect((await requests.request({ ...common, op: "bootstrap" }, capability, "second")).status).toBe(409);
  } finally { await requests.dispose(); }
  const expired = await jobRequests({ ...packet.job, expiresAt: 1700000000 }, false);
  try {
    const response = await expired.request({ ...common, op: "bootstrap" }, capability);
    expect(response.status).toBe(410);
    expect(await reply(response)).toEqual({ ok: false, code: "EXPIRED", outcome: "not-applied" });
  } finally { await expired.dispose(); }
}, 15000);

test("fixed-job native admission refuses wrong digest, order and replay across independent Worker lifecycles", async () => {
  const { packet, capability } = await preparedJob();
  const requests = await jobRequests(packet.job);
  const common = identity(packet.job);
  const first = await Bun.file(join(packet.directory, "0.json")).json();
  const second = await Bun.file(join(packet.directory, "1.json")).json();
  try {
    expect((await requests.request({ ...common, op: "bootstrap" }, capability)).status).toBe(200);
    const outOfOrder = await requests.request({ ...common, op: "rows", group: second }, capability, "second");
    expect(outOfOrder.status).toBe(409);
    expect(await reply(outOfOrder)).toEqual({ ok: false, code: "ORDER_REFUSED", outcome: "rolled-back" });
    const changed = structuredClone(first);
    changed.rows[0].values[1][1] = "not the reviewed group";
    const badDigest = await requests.request({ ...common, op: "rows", group: changed }, capability);
    expect(badDigest.status).toBe(400);
    expect(await reply(badDigest)).toEqual({ ok: false, code: "ARTIFACT_INVALID", outcome: "not-applied" });
    expect(await pageReply(await requests.request({ ...common, op: "page", table: "__drizzle_migrations", cursor: null }, capability))).toMatchObject({ ok: true, columns: ["rowid", "id", "hash", "created_at"], rows: [], complete: true });
    const admitted = await requests.request({ ...common, op: "rows", group: first }, capability);
    expect(admitted.status).toBe(200);
    expect(await reply(admitted)).toEqual({ ok: true, index: 0, rows: 2, digest: packet.job.groups[0]!.digest });
    const replay = await requests.request({ ...common, op: "rows", group: first }, capability, "second");
    expect(replay.status).toBe(409);
    expect(await reply(replay)).toEqual({ ok: false, code: "ORDER_REFUSED", outcome: "rolled-back" });
    expect(await pageReply(await requests.request({ ...common, op: "page", table: "__drizzle_migrations", cursor: null }, capability, "second"))).toEqual({
      ok: true, columns: ["rowid", "id", "hash", "created_at"], rows: literalRows.__drizzle_migrations, cursor: 8, complete: true,
    });
  } finally { await requests.dispose(); }
}, 15000);

test("concurrent fixed-job requests in independent isolates admit exactly one native group", async () => {
  const { packet, capability } = await preparedJob();
  const requests = await jobRequests(packet.job);
  const common = identity(packet.job);
  const group = await Bun.file(join(packet.directory, "0.json")).json();
  try {
    expect((await requests.request({ ...common, op: "bootstrap" }, capability)).status).toBe(200);
    const responses = await Promise.all(["first", "second"].map((lifecycle) => requests.request({ ...common, op: "rows", group }, capability, lifecycle)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const results = await Promise.all(responses.map(reply));
    expect(results.filter((result) => result.ok === false)).toEqual([{ ok: false, code: "ORDER_REFUSED", outcome: "rolled-back" }]);
    expect(await pageReply(await requests.request({ ...common, op: "page", table: "__drizzle_migrations", cursor: null }, capability, "second"))).toMatchObject({ rows: literalRows.__drizzle_migrations, complete: true });
  } finally { await requests.dispose(); }
}, 15000);

test("a reviewed synthetic constraint fault rolls back an earlier native statement and remains completely unreadable as imported data", async () => {
  const { packet, capability } = await preparedJob();
  const rows: SnapshotRow[] = Array.from({ length: 26 }, (_, index) => ({ rowid: index + 1, values: [["null", null], ["text", "synthetic-native-valid"], ["integer", 1700000000]] }));
  rows[25]!.values[1] = ["null", null];
  const group = { index: 0, table: "__drizzle_migrations", rows };
  const faultJob = { ...packet.job,
    tables: packet.job.tables.map((table) => ({ ...table, rowCount: table.name === "__drizzle_migrations" ? 26 : 0 })),
    groups: [{ index: 0, table: "__drizzle_migrations", rowCount: 26, lastRowid: 26, digest: await migrationChecksum(JSON.stringify(group)) }],
  };
  const requests = await jobRequests(faultJob);
  const common = identity(faultJob);
  try {
    expect((await requests.request({ ...common, op: "bootstrap" }, capability)).status).toBe(200);
    const response = await requests.request({ ...common, op: "rows", group }, capability);
    expect(response.status).toBe(422);
    expect(await reply(response)).toEqual({ ok: false, code: "GROUP_ROLLED_BACK", outcome: "rolled-back" });
    expect(await pageReply(await requests.request({ ...common, op: "page", table: "__drizzle_migrations", cursor: null }, capability, "second"))).toEqual({ ok: true, columns: ["rowid", "id", "hash", "created_at"], rows: [], cursor: null, complete: true });
    expect(await inventoryReply(await requests.request({ ...common, op: "inventory" }, capability))).toMatchObject({ sequence: [], tables: [
      { name: "__drizzle_migrations", rowCount: 0 }, { name: "catalog_refresh_failures", rowCount: 0 }, { name: "catalog_refresh_state", rowCount: 0 }, { name: "deal_refresh_state", rowCount: 0 },
      { name: "game_deal_cache", rowCount: 0 }, { name: "games", rowCount: 0 }, { name: "itad_game_map", rowCount: 0 }, { name: "sync_state", rowCount: 0 },
    ] });
  } finally { await requests.dispose(); }
}, 15000);

test.each(["prepared", "legacy"] as const)("fixed-job transfer validates every literal typed %s table and deleted sequence rather than counts alone", async (profile) => {
  const { packet, capability } = await preparedJob(profile);
  const requests = await jobRequests(packet.job);
  const common = identity(packet.job);
  try {
    expect((await requests.request({ ...common, op: "bootstrap" }, capability)).status).toBe(200);
    const early = await requests.request({ ...common, op: "sequence" }, capability, "second");
    expect(early.status).toBe(409);
    expect(await reply(early)).toEqual({ ok: false, code: "ORDER_REFUSED", outcome: "not-applied" });
    for (const group of packet.job.groups) {
      const response = await requests.request({ ...common, op: "rows", group: await Bun.file(join(packet.directory, `${group.index}.json`)).json() }, capability, group.index % 2 ? "first" : "second");
      expect(await reply(response)).toEqual({ ok: true, index: group.index, rows: group.rowCount, digest: group.digest });
    }
    const beforeSequence = await requests.request({ ...common, op: "validate" }, capability);
    expect(beforeSequence.status).toBe(409);
    expect(await reply(beforeSequence)).toEqual({ ok: false, code: "CONTENT_MISMATCH", outcome: "not-applied" });
    expect(await reply(await requests.request({ ...common, op: "sequence" }, capability, "second"))).toEqual({ ok: true, phase: "sequence", changed: true });
    for (const [table, rows] of Object.entries(literalRows)) {
      const page = await pageReply(await requests.request({ ...common, op: "page", table, cursor: null }, capability, "second"));
      expect(page.rows).toEqual(rows);
      expect(page.complete).toBe(true);
      if (table === "games") expect(page.columns).toEqual(["rowid", "id", "steam_app_id", "name", "steam_review_score", "steam_review_count", "hltb_id", "hltb_main", "hltb_main_extra", "hltb_completionist", "value_score", "is_endless", "is_on_wishlist", "is_early_access", "controller_support", "release_date", "is_owned", "playtime_minutes", "is_ignored", "has_single_player", "has_multiplayer", "has_co_op", "has_online_co_op", "has_local_co_op", "has_pvp", "has_online_pvp", "has_local_pvp", "has_crossplatform", "is_mmo", "tags", "created_at", "updated_at"]);
    }
    const validation = await contentReply(await requests.request({ ...common, op: "validate" }, capability));
    expect(validation).toMatchObject({ ok: true, status: "data-verified", schemaFingerprint: packet.job.targetSchemaFingerprint, sequence: [{ name: "games", seq: 950 }] });
    expect(validation.tables).toEqual(packet.job.tables);
    const inventory = await inventoryReply(await requests.request({ ...common, op: "inventory" }, capability));
    expect(inventory.schema.objects.filter((object: { type: string }) => object.type === "index").map((object: { name: string }) => object.name)).toEqual([
      "games_steam_app_id_unique", "idx_games_browse_default", "idx_games_browse_owned_playtime", "idx_games_status_filters", "idx_games_steam_app_id", "idx_games_value_score",
      "sqlite_autoindex___drizzle_migrations_1", "sqlite_autoindex_catalog_refresh_state_1", "sqlite_autoindex_deal_refresh_state_1", "sqlite_autoindex_game_deal_cache_1", "sqlite_autoindex_sync_state_1",
    ]);
    const games = inventory.schema.tables.find((table) => table.name === "games");
    const steamStatus = inventory.schema.tables.find((table) => table.name === "sync_state");
    if (!games || !steamStatus) throw new Error("Required fixed-job schema table is missing");
    expect(games.columns.filter((column: { dflt_value: unknown }) => column.dflt_value === "0")).toHaveLength(15);
    expect(steamStatus.columns.at(-1)).toMatchObject({ name: "updated_at", notnull: 1, dflt_value: "unixepoch()" });
    const repeatSequence = await requests.request({ ...common, op: "sequence" }, capability);
    expect(repeatSequence.status).toBe(409);
    expect(await reply(repeatSequence)).toEqual({ ok: false, code: "ORDER_REFUSED", outcome: "rolled-back" });
    expect(await contentReply(await requests.request({ ...common, op: "validate" }, capability, "second"))).toEqual(validation);
  } finally { await requests.dispose(); }
}, 15000);

test("the public local host runner publishes an actual protected complete receipt for a fully verified native target", async () => {
  const { packet, snapshot, capability } = await preparedJob();
  const root = await directory();
  const receiptPath = join(root, "import.json");
  const persistTo = join(root, "target");
  const runner = await createLocalFixedD1JobRunner({ jobDirectory: packet.directory, reviewedJobDigest: packet.digest, snapshot, persistTo, receiptPath, capability });
  try {
    const receipt = await runner.run();
    expect(receipt).toMatchObject({ status: "imported", phase: "complete", targetId: "synthetic-fixed-target", snapshotId: snapshot.manifest.snapshotId, manifestDigest: packet.job.snapshotDigest, writeOutcome: "imported", confirmedRows: {
      __drizzle_migrations: 2, catalog_refresh_failures: 1, catalog_refresh_state: 1, deal_refresh_state: 1, game_deal_cache: 2, games: 1, itad_game_map: 2, sync_state: 3,
    } });
    expect(await Bun.file(receiptPath).json()).toEqual(receipt);
    const info = await stat(receiptPath);
    expect([info.mode & 0o777, info.uid, info.nlink]).toEqual([0o600, ownedUid(), 1]);
    for (const [table, rows] of Object.entries(literalRows)) expect((await pageReply(await runner.read({ op: "page", table, cursor: null }))).rows).toEqual(rows);
    expect(await contentReply(await runner.read({ op: "validate" }))).toMatchObject({ status: "data-verified", sequence: [{ name: "games", seq: 950 }] });
  } finally { await runner.dispose(); }
  await expect(runner.read({ op: "inventory" })).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  expect((await stat(persistTo)).mode & 0o777).toBe(0o700);
  const retained = await openLocalTransferHandle(persistTo);
  try {
    const target = createD1TransferTarget(retained.binding, { id: "synthetic-fixed-target", intent: "staging", freezeRecord: freeze("synthetic-fixed-target"), receiptPath });
    expect((await inventorySource(target)).tables).toEqual(snapshot.manifest.tables);
    await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "BEHAVIOR_REQUIRED" });
  } finally { await retained.dispose(); }
}, 15000);

test.each(["rows", "sequence"] as const)("a real native %s commit followed by lost host acknowledgement retains an incomplete receipt and target", async (lostAt) => {
  const { packet, snapshot, capability } = await preparedJob();
  const root = await directory();
  const receiptPath = join(root, "unknown.json");
  const persistTo = join(root, "retained-target");
  const runner = await createLocalFixedD1JobRunner({ jobDirectory: packet.directory, reviewedJobDigest: packet.digest, snapshot, persistTo, receiptPath, capability,
    acknowledge: async (ack) => {
      if (ack.op !== lostAt || (ack.op === "rows" && ack.index !== 0)) return;
      if (lostAt === "rows") expect((await pageReply(await runner.read({ op: "page", table: "__drizzle_migrations", cursor: null }))).rows).toEqual(literalRows.__drizzle_migrations);
      else expect(await contentReply(await runner.read({ op: "validate" }))).toMatchObject({ status: "data-verified", sequence: [{ name: "games", seq: 950 }] });
      throw new Error("synthetic-lost-native-values-must-not-leak");
    },
  });
  try {
    await expect(runner.run()).rejects.toMatchObject({ code: "TRANSFER_FAILED" });
    const text = await Bun.file(receiptPath).text();
    const receipt = JSON.parse(text);
    expect(receipt).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: "partial-or-unknown", confirmedRows: { __drizzle_migrations: lostAt === "rows" ? 0 : 2 } });
    expect(text.includes("synthetic-lost-native-values")).toBe(false);
    expect((await pageReply(await runner.read({ op: "page", table: "__drizzle_migrations", cursor: null }))).rows).toEqual(literalRows.__drizzle_migrations);
    await expect(runner.run()).rejects.toMatchObject({ code: "TRANSFER_FAILED" });
    expect(await Bun.file(receiptPath).json()).toEqual(receipt);
  } finally { await runner.dispose(); }
  const retained = await openLocalTransferHandle(persistTo);
  try {
    const target = createD1TransferTarget(retained.binding, { id: "synthetic-fixed-target", intent: "staging", freezeRecord: freeze("synthetic-fixed-target"), receiptPath });
    expect((await inventorySource(target)).tables.find((table) => table.name === "__drizzle_migrations")?.rowCount).toBe(2);
    await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  } finally { await retained.dispose(); }
}, 15000);

test("host cancellation waits for the actual in-flight native acknowledgement and disposes its owner before acknowledging", async () => {
  const { packet, snapshot, capability } = await preparedJob();
  const root = await directory();
  const receiptPath = join(root, "cancelled.json");
  const committed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const runner = await createLocalFixedD1JobRunner({ jobDirectory: packet.directory, reviewedJobDigest: packet.digest, snapshot, persistTo: join(root, "target"), receiptPath, capability,
    acknowledge: async (ack) => {
      if (ack.op !== "rows" || ack.index !== 0) return;
      expect((await pageReply(await runner.read({ op: "page", table: "__drizzle_migrations", cursor: null }))).rows).toEqual(literalRows.__drizzle_migrations);
      committed.resolve();
      await release.promise;
    },
  });
  const result = runner.run();
  const settled = result.catch(() => {});
  try {
    await committed.promise;
    let acknowledged = false;
    const cancellation = runner.cancel().then((ack) => { acknowledged = true; return ack; });
    expect(await Bun.file(receiptPath).json()).toMatchObject({ status: "incomplete", phase: "rows", confirmedRows: { __drizzle_migrations: 0 }, writeOutcome: "partial-or-unknown" });
    expect(acknowledged).toBe(false);
    release.resolve();
    await expect(result).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
    expect(await cancellation).toEqual({ status: "cancelled", nativeDisposed: true });
    expect(await Bun.file(receiptPath).json()).toMatchObject({ status: "incomplete", phase: "failed", confirmedRows: { __drizzle_migrations: 0 }, writeOutcome: "partial-or-unknown", errorCode: "INCOMPLETE_IMPORT" });
    await expect(runner.read({ op: "inventory" })).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  } finally { release.resolve(); await settled; await runner.dispose(); }
}, 15000);

test.each(["preflight", "complete"] as const)("host cancellation at real %s receipt publication is fenced before publisher acknowledgement", async (phase) => {
  const { packet, snapshot, capability } = await preparedJob();
  const root = await directory();
  const receiptPath = join(root, "publication.json");
  const persistTo = join(root, "target");
  const real = createProtectedImportReceiptPublisher(receiptPath);
  const published = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const runner = await createLocalFixedD1JobRunner({ jobDirectory: packet.directory, reviewedJobDigest: packet.digest, snapshot, persistTo, receiptPath, capability,
    receiptPublisher: { async publish(receipt, create) {
      await real.publish(receipt, create);
      if ((phase === "preflight" && create) || (phase === "complete" && receipt.status === "imported")) {
        expect(await Bun.file(receiptPath).json()).toEqual(receipt);
        published.resolve();
        await release.promise;
      }
    } },
  });
  const result = runner.run();
  const settled = result.catch(() => {});
  try {
    await Promise.race([published.promise, result.then(() => { throw new Error("Required publisher acknowledgement was ignored"); })]);
    const cancellation = runner.cancel();
    release.resolve();
    await expect(result).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
    expect(await cancellation).toEqual({ status: "cancelled", nativeDisposed: true });
    expect(await Bun.file(receiptPath).json()).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: phase === "preflight" ? "not-started" : "partial-or-unknown", errorCode: "INCOMPLETE_IMPORT" });
  } finally { release.resolve(); await settled; await runner.dispose(); }
  if (phase === "preflight") expect(await stat(persistTo).catch(() => undefined)).toBeUndefined();
  else {
    const retained = await openLocalTransferHandle(persistTo);
    try {
      const target = createD1TransferTarget(retained.binding, { id: "synthetic-fixed-target", intent: "staging", freezeRecord: freeze("synthetic-fixed-target"), receiptPath });
      expect(await inventorySource(target)).toMatchObject({ tables: snapshot.manifest.tables, sequence: [{ name: "games", seq: 950 }] });
      await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
    } finally { await retained.dispose(); }
  }
}, 15000);

test("unknown host attempts cannot reopen or reset a retained target and recovery explicitly selects a fresh job and pristine target", async () => {
  const { packet, snapshot, capability } = await preparedJob();
  const root = await directory();
  const receiptPath = join(root, "unknown.json");
  const persistTo = join(root, "retained");
  const old = await createLocalFixedD1JobRunner({ jobDirectory: packet.directory, reviewedJobDigest: packet.digest, snapshot, persistTo, receiptPath, capability,
    acknowledge: async (ack) => { if (ack.op === "rows" && ack.index === 0) throw new Error("Synthetic lost response after native commit"); },
  });
  try {
    await expect(old.run()).rejects.toMatchObject({ code: "TRANSFER_FAILED" });
    const before = await Bun.file(receiptPath).json();
    const repeated = await createLocalFixedD1JobRunner({ jobDirectory: packet.directory, reviewedJobDigest: packet.digest, snapshot, persistTo, receiptPath: join(root, "refused-reopen.json"), capability });
    try { await expect(repeated.run()).rejects.toMatchObject({ code: "ARTIFACT_UNSAFE" }); }
    finally { await repeated.dispose(); }
    expect((await pageReply(await old.read({ op: "page", table: "__drizzle_migrations", cursor: null }))).rows).toEqual(literalRows.__drizzle_migrations);
    expect((await pageReply(await old.read({ op: "page", table: "games", cursor: null }))).rows).toEqual([]);
    const freshCapability = "synthetic-fresh-fixed-job-capability";
    const fresh = await prepareFixedD1Job(snapshot, join(await directory(), "fresh-job"), {
      ...runOptions(freshCapability), runId: "20000000-0000-4000-8000-000000000031", targetId: "synthetic-fresh-target", capabilityDigest: await migrationChecksum(freshCapability),
    });
    const recovery = await createLocalFixedD1JobRunner({ jobDirectory: fresh.directory, reviewedJobDigest: fresh.digest, snapshot, persistTo: join(root, "explicitly-pristine-target"), receiptPath: join(root, "fresh.json"), capability: freshCapability });
    try {
      expect(await recovery.run()).toMatchObject({ status: "imported", targetId: "synthetic-fresh-target" });
      for (const [table, rows] of Object.entries(literalRows)) expect((await pageReply(await recovery.read({ op: "page", table, cursor: null }))).rows).toEqual(rows);
      expect(await contentReply(await recovery.read({ op: "validate" }))).toMatchObject({ status: "data-verified", sequence: [{ name: "games", seq: 950 }] });
    } finally { await recovery.dispose(); }
    expect(await Bun.file(receiptPath).json()).toEqual(before);
    expect((await pageReply(await old.read({ op: "page", table: "games", cursor: null }))).rows).toEqual([]);
    expect((await stat(persistTo)).isDirectory()).toBe(true);
  } finally { await old.dispose(); }
}, 15000);

test.each(["misdirected", "stale", "exclusive-error"] as const)("host receipt acknowledgement refuses a real %s protected publication without promotion", async (fault) => {
  const { packet, snapshot, capability } = await preparedJob();
  const root = await directory();
  const receiptPath = join(root, "guarded.json");
  const persistTo = join(root, "target");
  const otherPath = join(root, "other.json");
  const real = createProtectedImportReceiptPublisher(fault === "misdirected" ? otherPath : receiptPath);
  const runner = await createLocalFixedD1JobRunner({ jobDirectory: packet.directory, reviewedJobDigest: packet.digest, snapshot, persistTo, receiptPath, capability,
    receiptPublisher: { async publish(receipt, create) {
      if (fault === "stale" && receipt.status === "imported") return;
      await real.publish(receipt, create);
      if (fault === "exclusive-error" && receipt.status === "imported") await real.publish(receipt, true);
    } },
  });
  try {
    await expect(runner.run()).rejects.toMatchObject({ code: fault === "stale" ? "ARTIFACT_INVALID" : "ARTIFACT_UNSAFE" });
    if (fault === "misdirected") {
      expect(await stat(persistTo).catch(() => undefined)).toBeUndefined();
      expect(await stat(receiptPath).catch(() => undefined)).toBeUndefined();
      expect(await Bun.file(otherPath).json()).toMatchObject({ status: "incomplete", phase: "preflight", writeOutcome: "not-started" });
    } else {
      expect(await Bun.file(receiptPath).json()).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: "partial-or-unknown" });
      expect(await contentReply(await runner.read({ op: "validate" }))).toMatchObject({ status: "data-verified", sequence: [{ name: "games", seq: 950 }] });
      expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
    }
  } finally { await runner.dispose(); }
}, 15000);

test("cancellation after successful host import return is not retroactive", async () => {
  const { packet, snapshot, capability } = await preparedJob();
  const root = await directory();
  const receiptPath = join(root, "complete.json");
  const runner = await createLocalFixedD1JobRunner({ jobDirectory: packet.directory, reviewedJobDigest: packet.digest, snapshot, persistTo: join(root, "target"), receiptPath, capability });
  try {
    const receipt = await runner.run();
    expect(receipt.status).toBe("imported");
    expect(await runner.cancel()).toEqual({ status: "cancelled", nativeDisposed: true });
    expect(await Bun.file(receiptPath).json()).toEqual(receipt);
    await expect(runner.read({ op: "inventory" })).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
  } finally { await runner.dispose(); }
}, 15000);

test.each([false, true])("empty-table host transfer retains exact absent or deleted-only sequence, sequence=%s", async (sequenceOnly) => {
  const binding = await owner.getBinding(`FIXED_JOB_${next++}`);
  await applyMigrations(binding, await loadMigrations());
  if (sequenceOnly) await binding.batch([
    binding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (950,99,'Synthetic deleted-only allocation')"),
    binding.prepare("DELETE FROM games"),
  ]);
  const source = createD1TransferSource(binding, { id: "synthetic-empty", freezeRecord: freeze("synthetic-empty") });
  const snapshot = await exportSnapshot(source, join(await directory(), "empty-snapshot"), source.freezeRecord);
  const capability = "synthetic-empty-job-capability";
  const packet = await prepareFixedD1Job(snapshot, join(await directory(), "empty-job"), { ...runOptions(capability), capabilityDigest: await migrationChecksum(capability) });
  const root = await directory();
  const runner = await createLocalFixedD1JobRunner({ jobDirectory: packet.directory, reviewedJobDigest: packet.digest, snapshot, persistTo: join(root, "target"), receiptPath: join(root, "empty.json"), capability });
  try {
    expect((await runner.run()).status).toBe("imported");
    const validation = await contentReply(await runner.read({ op: "validate" }));
    expect(validation).toMatchObject({ status: "data-verified", sequence: sequenceOnly ? [{ name: "games", seq: 950 }] : [] });
    expect(validation.tables.map((table: { rowCount: number }) => table.rowCount)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect((await pageReply(await runner.read({ op: "page", table: "games", cursor: null }))).rows).toEqual([]);
  } finally { await runner.dispose(); }
}, 15000);

test("native host transfer keeps 64-statement groups, complete bounded pages and all full-game parameter-boundary rows", async () => {
  const binding = await owner.getBinding(`FIXED_JOB_${next++}`);
  await applyMigrations(binding, await loadMigrations());
  for (let offset = 0; offset < 389; offset += 64) await binding.batch(Array.from({ length: Math.min(64, 389 - offset) }, (_, index) => {
    const id = offset + index + 1;
    return binding.prepare(`INSERT INTO games (id,steam_app_id,name,hltb_main,value_score,is_owned,created_at,tags) VALUES (?,?,?,12.5,9.75,NULL,1700000000,'[ "synthetic" ]')`).bind(id, 10000 + id, `Bounded ${id}`);
  }));
  const source = createD1TransferSource(binding, { id: "synthetic-bounded", freezeRecord: freeze("synthetic-bounded") });
  const snapshot = await exportSnapshot(source, join(await directory(), "bounded-snapshot"), source.freezeRecord);
  const capability = "synthetic-bounded-job-capability";
  const packet = await prepareFixedD1Job(snapshot, join(await directory(), "bounded-job"), { ...runOptions(capability), capabilityDigest: await migrationChecksum(capability) });
  expect(packet.job.groups.map((group) => [group.table, group.rowCount])).toEqual([["games", 189], ["games", 189], ["games", 11]]);
  const root = await directory();
  const runner = await createLocalFixedD1JobRunner({ jobDirectory: packet.directory, reviewedJobDigest: packet.digest, snapshot, persistTo: join(root, "target"), receiptPath: join(root, "bounded.json"), capability });
  try {
    expect((await runner.run()).confirmedRows.games).toBe(389);
    const ids: number[] = [];
    let cursor: number | null = null;
    let pages = 0;
    for (;;) {
      const page: PageReply = await pageReply(await runner.read({ op: "page", table: "games", cursor }));
      expect(page.rows.length).toBeLessThanOrEqual(64);
      for (const row of page.rows) {
        ids.push(row.rowid);
        expect([row.values[0], row.values[1], row.values[2], row.values[6], row.values[15], row.values[28], row.values[29]]).toEqual([
          ["integer", row.rowid], ["integer", 10000 + row.rowid], ["text", `Bounded ${row.rowid}`], ["real", 12.5], ["null", null], ["text", '[ "synthetic" ]'], ["integer", 1700000000],
        ]);
      }
      pages++;
      if (page.complete) break;
      cursor = page.cursor;
    }
    expect(pages).toBe(7);
    expect(ids).toEqual(Array.from({ length: 389 }, (_, index) => index + 1));
    expect(await contentReply(await runner.read({ op: "validate" }))).toMatchObject({ status: "data-verified", tables: snapshot.manifest.tables });
    expect((await Bun.file(join(packet.directory, "worker.js")).text()).includes("Bounded 1")).toBe(false);
  } finally { await runner.dispose(); }
  const first = await Bun.file(join(packet.directory, "0.json")).json();
  const second = await Bun.file(join(packet.directory, "1.json")).json();
  const oversized = { index: 0, table: "games", rows: [...first.rows, second.rows[0]] };
  const fault = { ...packet.job, tables: packet.job.tables.map((table) => ({ ...table, rowCount: table.name === "games" ? 190 : 0 })), groups: [{ index: 0, table: "games", rowCount: 190, lastRowid: 190, digest: await migrationChecksum(JSON.stringify(oversized)) }] };
  const requests = await jobRequests(fault);
  try {
    const common = identity(fault);
    expect((await requests.request({ ...common, op: "bootstrap" }, capability)).status).toBe(200);
    expect(await reply(await requests.request({ ...common, op: "rows", group: oversized }, capability))).toEqual({ ok: false, code: "UNSUPPORTED_DATA", outcome: "not-applied" });
    expect((await pageReply(await requests.request({ ...common, op: "page", table: "games", cursor: null }, capability))).rows).toEqual([]);
  } finally { await requests.dispose(); }
}, 15000);

test("host capability authentication precedes source artifact or reference-database access", async () => {
  const { packet, capability } = await preparedJob();
  const root = await directory();
  const options = { jobDirectory: packet.directory, reviewedJobDigest: packet.digest, snapshot: join(root, "source-must-not-be-opened"), persistTo: join(root, "target"), receiptPath: join(root, "auth.json") };
  for (const invalid of ["", "synthetic-viewer-only", "synthetic-existing-machine-token"]) await expect(createLocalFixedD1JobRunner({ ...options, capability: invalid })).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  await expect(createLocalFixedD1JobRunner({ ...options, capability })).rejects.toMatchObject({ code: "ARTIFACT_UNSAFE" });
  expect(await stat(options.persistTo).catch(() => undefined)).toBeUndefined();
  expect(await stat(options.receiptPath).catch(() => undefined)).toBeUndefined();
}, 15000);

async function rewriteFixtureJson(path: string, value: unknown) {
  const file = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw new Error("Unsafe synthetic mutation fixture");
    await file.truncate(0);
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally { await file.close(); }
}

test.each(["reviewed-digest", "changed-group", "resigned-group", "group-mode", "manifest-mode", "group-symlink", "group-hardlink", "unknown-manifest", "expired-manifest", "existing-receipt", "existing-target", "git-receipt"] as const)("protected host artifacts refuse %s without adopting, overwriting or opening a native target", async (fault) => {
  const { packet, snapshot, capability } = await preparedJob();
  const root = await directory();
  const groupPath = join(packet.directory, "0.json");
  const jobPath = join(packet.directory, "job.json");
  const persistTo = join(root, "target");
  const receiptPath = fault === "git-receipt" ? join(process.cwd(), ".fixed-job-refused-receipt") : join(root, "receipt.json");
  let reviewedJobDigest = packet.digest;
  if (fault === "reviewed-digest") reviewedJobDigest = "0".repeat(64);
  if (fault === "changed-group" || fault === "resigned-group") {
    const group = await Bun.file(groupPath).json();
    group.rows[0].values[1][1] = "not the verified snapshot";
    await rewriteFixtureJson(groupPath, group);
    if (fault === "resigned-group") {
      const job = structuredClone(packet.job);
      job.groups[0]!.digest = await migrationChecksum(JSON.stringify(group));
      await rewriteFixtureJson(jobPath, job);
      reviewedJobDigest = await migrationChecksum(JSON.stringify(job));
    }
  }
  if (fault === "group-mode" || fault === "manifest-mode") await chmod(fault === "group-mode" ? groupPath : jobPath, 0o644);
  if (fault === "group-symlink") {
    await rename(groupPath, join(packet.directory, "saved-group.json"));
    await symlink(join(packet.directory, "saved-group.json"), groupPath);
  }
  if (fault === "group-hardlink") await link(groupPath, join(packet.directory, "group-alias.json"));
  if (fault === "unknown-manifest" || fault === "expired-manifest") {
    const job = fault === "unknown-manifest" ? { ...packet.job, sql: "DELETE FROM games" } : { ...packet.job, expiresAt: 1700000000 };
    await rewriteFixtureJson(jobPath, job);
    reviewedJobDigest = await migrationChecksum(JSON.stringify(job));
  }
  if (fault === "existing-receipt" || fault === "existing-target") {
    const path = fault === "existing-receipt" ? receiptPath : (await mkdir(persistTo, { mode: 0o700 }), join(persistTo, "retain.json"));
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile('{"synthetic":"retain"}\n'); } finally { await file.close(); }
  }
  const options = { jobDirectory: packet.directory, reviewedJobDigest, snapshot, persistTo, receiptPath, capability };
  const unsafe = ["group-mode", "manifest-mode", "group-symlink", "group-hardlink", "existing-receipt", "existing-target", "git-receipt"].includes(fault);
  const attempt = async () => {
    const runner = await createLocalFixedD1JobRunner(options);
    try { await runner.run(); } finally { await runner.dispose(); }
  };
  await expect(attempt()).rejects.toMatchObject({ code: unsafe ? "ARTIFACT_UNSAFE" : "ARTIFACT_INVALID" });
  if (fault === "group-mode" || fault === "manifest-mode") expect((await stat(fault === "group-mode" ? groupPath : jobPath)).mode & 0o777).toBe(0o644);
  if (fault === "group-hardlink") expect((await stat(groupPath)).nlink).toBe(2);
  if (fault === "existing-receipt") expect(await Bun.file(receiptPath).text()).toBe('{"synthetic":"retain"}\n');
  if (fault === "existing-target") expect(await Bun.file(join(persistTo, "retain.json")).text()).toBe('{"synthetic":"retain"}\n');
  else expect(await stat(persistTo).catch(() => undefined)).toBeUndefined();
  if (fault === "git-receipt") expect(await stat(receiptPath).catch(() => undefined)).toBeUndefined();
}, 15000);

test("fixed-job requests enforce the actual four-MiB body bound after capability authentication and before native access", async () => {
  const { packet, capability } = await preparedJob();
  const requests = await jobRequests(packet.job);
  const common = identity(packet.job);
  const oversized = { ...common, op: "inventory", padding: "x".repeat(4_194_304) };
  try {
    expect((await requests.request(oversized, "synthetic-viewer-only")).status).toBe(401);
    const response = await requests.request(oversized, capability);
    expect(response.status).toBe(413);
    expect(await reply(response)).toEqual({ ok: false, code: "LIMIT_EXCEEDED", outcome: "not-applied" });
    expect(await reply(await requests.request({ ...common, op: "inventory" }, capability))).toEqual({ ok: true, state: "uninitialized" });
  } finally { await requests.dispose(); }
}, 15000);

test.each(["prepared", "legacy"] as const)("unchanged public importer characterizes complete literal typed %s contents and deleted sequence", async (profile) => {
  const snapshot = await syntheticSnapshot(profile);
  const binding = await owner.getBinding(`FIXED_JOB_${next++}`);
  await applyMigrations(binding, await loadMigrations());
  const target = createD1TransferTarget(binding, {
    id: "synthetic-characterization-target", intent: "staging", freezeRecord: freeze("synthetic-characterization-target"),
    receiptPath: join(await directory(), "import.json"),
  });
  expect((await importSnapshot(target, snapshot)).status).toBe("imported");
  const restored = await exportSnapshot(target, join(await directory(), "restored"), target.freezeRecord);
  for (const [table, rows] of Object.entries(literalRows)) {
    const file = await Bun.file(join(restored.directory, `${table}.jsonl`)).text();
    expect(file.split("\n").filter(Boolean).map((line) => JSON.parse(line))).toEqual(rows);
  }
  expect(restored.manifest.sequence).toEqual([{ name: "games", seq: 950 }]);
  expect(restored.manifest.schemaCompatibility).toMatchObject({ profile: "prepared-d1-v2", rawDdlIdentical: true });
  expect(snapshot.manifest.schemaCompatibility).toMatchObject({ profile: profile === "legacy" ? "observed-legacy-v1" : "prepared-d1-v2", rawDdlIdentical: profile === "prepared" });
  expect((await inventorySource(target)).tables).toEqual(restored.manifest.tables);
  await expect(validateSnapshot(target, snapshot)).rejects.toMatchObject({ code: "BEHAVIOR_REQUIRED" });
  expect((await inventorySource(target)).sequence).toEqual([{ name: "games", seq: 950 }]);
}, 15000);
