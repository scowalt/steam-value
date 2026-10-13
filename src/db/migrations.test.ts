import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { applyMigrations, loadMigrations, migrationChecksum } from "./migrations";

type SchemaRow = Record<string, string | number | null>;

let runtime: Miniflare;
let nextDatabase = 0;
const databaseSlots = Array.from({ length: 100 }, (_, index) => `ISOLATED_${index}`);

beforeAll(() => {
  nextDatabase = 0;
  runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 404 }); } }",
    d1Databases: databaseSlots,
    d1Persist: false,
    cf: false,
    host: "127.0.0.1",
    port: 0,
  });
});

afterAll(async () => {
  await runtime.dispose();
});

async function isolatedD1() {
  const slot = databaseSlots[nextDatabase++];
  if (!slot) throw new Error("Isolated D1 test slots exhausted");
  return runtime.getD1Database(slot);
}

test("explicit bootstrap makes the Game Catalog usable on isolated D1", async () => {
  const binding = await isolatedD1();
  await applyMigrations(binding, await loadMigrations());
  await binding.prepare("INSERT INTO games (steam_app_id, name) VALUES (?, ?)").bind(42, "Synthetic game").run();
  expect(await binding.prepare("SELECT steam_app_id, name FROM games").all()).toMatchObject({
    results: [{ steam_app_id: 42, name: "Synthetic game" }],
  });
});

test("Game Catalog SQL defaults keep nullable booleans and client-only timestamps distinct", async () => {
  const binding = await isolatedD1();
  await applyMigrations(binding, await loadMigrations());
  await binding.prepare("INSERT INTO games (steam_app_id, name) VALUES (42, 'Defaults')").run();
  expect(await binding.prepare('SELECT "notnull" FROM pragma_table_info(\'games\') WHERE name = \'id\'').first<number>("notnull")).toBe(1);
  expect(await binding.prepare("SELECT * FROM games").first<SchemaRow>()).toEqual({
    id: 1, steam_app_id: 42, name: "Defaults", steam_review_score: null, steam_review_count: null,
    hltb_id: null, hltb_main: null, hltb_main_extra: null, hltb_completionist: null, value_score: null,
    is_endless: 0, is_on_wishlist: 0, is_early_access: 0, controller_support: null, release_date: null,
    is_owned: 0, playtime_minutes: null, is_ignored: 0, has_single_player: 0, has_multiplayer: 0,
    has_co_op: 0, has_online_co_op: 0, has_local_co_op: 0, has_pvp: 0, has_online_pvp: 0,
    has_local_pvp: 0, has_crossplatform: 0, is_mmo: 0, tags: null, created_at: null, updated_at: null,
  });
  await binding.prepare("UPDATE games SET is_owned = NULL, tags = 'not JSON', created_at = 1700000000 WHERE id = 1").run();
  expect(await binding.prepare("SELECT is_owned, tags, created_at, updated_at FROM games").first<SchemaRow>()).toEqual({
    is_owned: null, tags: "not JSON", created_at: 1700000000, updated_at: null,
  });
});

test("provisional Steam Status state defaults preserve seconds and zero counters", async () => {
  const binding = await isolatedD1();
  await applyMigrations(binding, await loadMigrations());
  const before = Math.floor(Date.now() / 1000);
  await binding.prepare("INSERT INTO sync_state (key) VALUES ('steam_status')").run();
  const row = await binding.prepare("SELECT * FROM sync_state").first<SchemaRow>();
  expect(row).toEqual({
    key: "steam_status", last_attempt_at: null, last_success_at: null, last_error: null,
    is_running: 0, lock_expires_at: null, ignored_count: 0, wishlist_count: 0, owned_count: 0,
    games_updated: 0, games_removed: 0, updated_at: expect.any(Number),
  });
  expect(row!.updated_at).toBeGreaterThanOrEqual(before);
  expect(row!.updated_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
});

test("Catalog Facts bootstrap preserves checkpoint defaults and persisted failure attempts", async () => {
  const binding = await isolatedD1();
  await applyMigrations(binding, await loadMigrations());
  const before = Math.floor(Date.now() / 1000);
  await binding.prepare("INSERT INTO catalog_refresh_state (key) VALUES ('steam_official_catalog')").run();
  await binding.prepare("INSERT INTO catalog_refresh_failures (steam_app_id, name, error) VALUES (42, 'Synthetic', 'Unavailable')").run();
  expect(await binding.prepare("SELECT * FROM catalog_refresh_state").first<SchemaRow>()).toEqual({
    key: "steam_official_catalog", last_app_id: 0, started_at: null, completed_at: null, min_reviews: 0,
    apps_seen: 0, processed_count: 0, inserted_count: 0, updated_count: 0, skipped_count: 0,
    unchanged_count: 0, failed_count: 0, last_error: null, updated_at: expect.any(Number),
  });
  expect(await binding.prepare("SELECT * FROM catalog_refresh_failures").first<SchemaRow>()).toEqual({
    steam_app_id: 42, name: "Synthetic", error: "Unavailable", attempts: 0, last_attempt_at: expect.any(Number),
  });
  for (const [table, column] of [["catalog_refresh_state", "updated_at"], ["catalog_refresh_failures", "last_attempt_at"]] as const) {
    const timestamp = await binding.prepare(`SELECT ${column} FROM ${table}`).first<number>(column);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  }
  await binding.prepare("UPDATE catalog_refresh_failures SET attempts = attempts + 1 WHERE steam_app_id = 42").run();
  expect(await binding.prepare("SELECT attempts FROM catalog_refresh_failures").first<number>("attempts")).toBe(1);
});

test("offer bootstrap retains checked-unmapped, successful-empty and country-specific records without foreign-key cascades", async () => {
  const binding = await isolatedD1();
  await applyMigrations(binding, await loadMigrations());
  await binding.batch([
    binding.prepare("INSERT INTO itad_game_map (steam_app_id, itad_id, checked_at) VALUES (42, NULL, 1700000000)"),
    binding.prepare("INSERT INTO game_deal_cache (steam_app_id, country, kind, checked_at, offers_json) VALUES (42, 'US', 'retail', 1700000000, '[]')"),
    binding.prepare("INSERT INTO game_deal_cache (steam_app_id, country, kind, checked_at, offers_json) VALUES (42, 'GB', 'bundle', 1700000001, '[{\"validUntil\":1700086400,\"priceCents\":null}]')"),
    binding.prepare("INSERT INTO deal_refresh_state (country) VALUES ('GB')"),
  ]);
  expect({
    mapping: await binding.prepare("SELECT * FROM itad_game_map").first<SchemaRow>(),
    cache: (await binding.prepare("SELECT * FROM game_deal_cache ORDER BY country").all()).results,
    state: await binding.prepare("SELECT * FROM deal_refresh_state").first<SchemaRow>(),
  }).toEqual({
    mapping: { steam_app_id: 42, itad_id: null, checked_at: 1700000000 },
    cache: [
      { steam_app_id: 42, country: "GB", kind: "bundle", checked_at: 1700000001, offers_json: '[{"validUntil":1700086400,"priceCents":null}]' },
      { steam_app_id: 42, country: "US", kind: "retail", checked_at: 1700000000, offers_json: "[]" },
    ],
    state: { country: "GB", last_attempt_at: null, last_success_at: null, last_error: null, lock_token: null, lock_expires_at: null, games_checked: 0 },
  });
});

test("bootstrap supplies both partial browse indexes and the independent Steam app lookup index", async () => {
  const binding = await isolatedD1();
  await applyMigrations(binding, await loadMigrations());
  expect((await binding.prepare("SELECT name, partial FROM pragma_index_list('games') WHERE origin = 'c' ORDER BY name").all()).results).toEqual([
    { name: "games_steam_app_id_unique", partial: 0 },
    { name: "idx_games_browse_default", partial: 1 },
    { name: "idx_games_browse_owned_playtime", partial: 1 },
    { name: "idx_games_status_filters", partial: 0 },
    { name: "idx_games_steam_app_id", partial: 0 },
    { name: "idx_games_value_score", partial: 0 },
  ]);
  expect((await binding.prepare("SELECT name, desc FROM pragma_index_xinfo('idx_games_browse_default') WHERE key = 1 ORDER BY seqno").all()).results)
    .toEqual([{ name: "value_score", desc: 1 }]);
  expect((await binding.prepare("SELECT name, desc FROM pragma_index_xinfo('idx_games_browse_owned_playtime') WHERE key = 1 ORDER BY seqno").all()).results)
    .toEqual([{ name: "playtime_minutes", desc: 0 }, { name: "value_score", desc: 1 }]);
  await binding.prepare("SELECT id FROM games INDEXED BY idx_games_browse_default WHERE value_score IS NOT NULL AND is_endless = 0 AND is_ignored = 0 ORDER BY value_score DESC").all();
  await binding.prepare("SELECT id FROM games INDEXED BY idx_games_browse_owned_playtime WHERE value_score IS NOT NULL AND is_endless = 0 ORDER BY playtime_minutes, value_score DESC").all();
});

test.each([false, true])("explicit bootstrap rejects untracked schema drift (already bootstrapped: %s)", async (bootstrapped) => {
  const binding = await isolatedD1();
  const migrations = await loadMigrations();
  if (bootstrapped) await applyMigrations(binding, migrations);
  await binding.prepare("CREATE TABLE unreviewed_drift (id INTEGER)").run();
  await expect(applyMigrations(binding, migrations)).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  expect(await binding.prepare("SELECT name FROM sqlite_schema WHERE name = 'unreviewed_drift'").first<string>("name")).toBe("unreviewed_drift");
});

test("migration receipts with a changed metadata schema are rejected, not adopted", async () => {
  const binding = await isolatedD1();
  const migrations = await loadMigrations();
  await applyMigrations(binding, migrations);
  await binding.prepare("ALTER TABLE steam_value_migrations ADD COLUMN unreviewed INTEGER").run();
  await expect(applyMigrations(binding, migrations)).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
});

test("a supplied checksum must describe its SQL even when the migration is already applied", async () => {
  const binding = await isolatedD1();
  const migrations = await loadMigrations();
  await applyMigrations(binding, migrations);
  await expect(applyMigrations(binding, [{ ...migrations[0]!, sql: "CREATE TABLE altered (id INTEGER);" }]))
    .rejects.toMatchObject({ code: "INVALID_MIGRATION" });
});

test("failed migration application rolls back its schema and receipt before an explicit restart", async () => {
  const binding = await isolatedD1();
  const sql = "CREATE TABLE staged (id INTEGER); INSERT INTO missing_table (id) VALUES (1);";
  await expect(applyMigrations(binding, [{ id: "0001_broken.sql", sql, checksum: await migrationChecksum(sql) }]))
    .rejects.toMatchObject({ code: "MIGRATION_FAILED" });
  expect((await binding.prepare("SELECT name FROM sqlite_schema WHERE name IN ('staged', 'steam_value_migrations')").all()).results).toEqual([]);
  expect(await applyMigrations(binding, await loadMigrations())).toMatchObject({ applied: ["0001_complete_schema.sql", "0002_retain_legacy_metadata.sql"], alreadyApplied: [] });
});

test("an explicit later migration preserves quoted SQL delimiters and ordered history", async () => {
  const binding = await isolatedD1();
  const migrations = await loadMigrations();
  await applyMigrations(binding, migrations);
  const sql = `CREATE TABLE "quoted;table" (value TEXT DEFAULT 'alpha;beta''s'); INSERT INTO "quoted;table" DEFAULT VALUES;`;
  const extended = [...migrations, { id: "0003_quoted_defaults.sql", sql, checksum: await migrationChecksum(sql) }];
  const report = await applyMigrations(binding, extended);
  expect({ report, value: await binding.prepare('SELECT value FROM "quoted;table"').first<string>("value") }).toMatchObject({
    report: { applied: ["0003_quoted_defaults.sql"], alreadyApplied: ["0001_complete_schema.sql", "0002_retain_legacy_metadata.sql"] },
    value: "alpha;beta's",
  });
  expect(await applyMigrations(binding, extended)).toEqual({
    applied: [], alreadyApplied: ["0001_complete_schema.sql", "0002_retain_legacy_metadata.sql", "0003_quoted_defaults.sql"], schemaFingerprint: report.schemaFingerprint,
  });
});

test("migration history must be nonempty, ordered, unique and named before any application", async () => {
  const binding = await isolatedD1();
  const migrations = await loadMigrations();
  const sql = "CREATE TABLE later (id INTEGER);";
  const later = { id: "0003_later.sql", sql, checksum: await migrationChecksum(sql) };
  for (const invalid of [[], [later, ...migrations], [migrations[0]!, migrations[0]!], [...migrations, { ...later, id: "0001_duplicate_version.sql" }], [{ ...later, id: "unsafe/name.sql" }]]) {
    await expect(applyMigrations(binding, invalid)).rejects.toMatchObject({ code: "INVALID_MIGRATION" });
  }
  expect(await applyMigrations(binding, migrations)).toMatchObject({ applied: ["0001_complete_schema.sql", "0002_retain_legacy_metadata.sql"], alreadyApplied: [] });
});

test("changed applied migrations are rejected before any schema or data changes", async () => {
  const binding = await isolatedD1();
  const migrations = await loadMigrations();
  const original = await applyMigrations(binding, migrations);
  const sql = migrations[0]!.sql + "\nCREATE TABLE unexpected (id INTEGER);";
  await expect(applyMigrations(binding, [{ id: migrations[0]!.id, sql, checksum: await migrationChecksum(sql) }]))
    .rejects.toMatchObject({ code: "MIGRATION_CHANGED" });
  expect(await applyMigrations(binding, migrations)).toEqual({
    applied: [], alreadyApplied: ["0001_complete_schema.sql", "0002_retain_legacy_metadata.sql"], schemaFingerprint: original.schemaFingerprint,
  });
});

test("bootstrap preserves required keys, NOT NULL columns, valid offer JSON and allowed kinds", async () => {
  const binding = await isolatedD1();
  await applyMigrations(binding, await loadMigrations());
  await binding.prepare("INSERT INTO games (steam_app_id, name) VALUES (42, 'Unique')").run();
  await binding.prepare("INSERT INTO game_deal_cache VALUES (42, 'US', 'retail', 1700000000, '[]')").run();
  for (const sql of [
    "INSERT INTO games (steam_app_id, name) VALUES (42, 'Duplicate')",
    "INSERT INTO games (steam_app_id, name) VALUES (43, NULL)",
    "INSERT INTO games (steam_app_id, name) VALUES (NULL, 'Missing app')",
    "INSERT INTO sync_state (key, is_running) VALUES ('invalid', NULL)",
    "INSERT INTO sync_state (key, updated_at) VALUES ('invalid', NULL)",
    "INSERT INTO catalog_refresh_state (key, processed_count) VALUES ('invalid', NULL)",
    "INSERT INTO catalog_refresh_failures (steam_app_id, name, error) VALUES (42, NULL, 'Failure')",
    "INSERT INTO catalog_refresh_failures (steam_app_id, name, error) VALUES (42, 'Failure', NULL)",
    "INSERT INTO itad_game_map (steam_app_id) VALUES (42)",
    "INSERT INTO game_deal_cache VALUES (42, 'US', 'retail', 1700000001, '[]')",
    "INSERT INTO game_deal_cache VALUES (42, 'US', 'invalid', 1700000000, '[]')",
    "INSERT INTO game_deal_cache VALUES (42, 'GB', 'retail', 1700000000, 'invalid JSON')",
    "INSERT INTO game_deal_cache VALUES (42, NULL, 'bundle', 1700000000, '[]')",
    "INSERT INTO deal_refresh_state (country, games_checked) VALUES ('US', NULL)",
  ]) {
    await expect(binding.prepare(sql).run()).rejects.toThrow(/constraint|NOT NULL|UNIQUE|CHECK/i);
  }
});

test("bootstrap retains SQLite TEXT-primary-key nullability rather than inventing NOT NULL", async () => {
  const binding = await isolatedD1();
  await applyMigrations(binding, await loadMigrations());
  for (const table of ["sync_state", "catalog_refresh_state", "deal_refresh_state"]) {
    await binding.prepare(`INSERT INTO ${table} DEFAULT VALUES`).run();
    await binding.prepare(`INSERT INTO ${table} DEFAULT VALUES`).run();
    expect(await binding.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<number>("count")).toBe(2);
  }
});

test("explicit reapplication preserves deleted-ID AUTOINCREMENT high-water state", async () => {
  const binding = await isolatedD1();
  const migrations = await loadMigrations();
  await applyMigrations(binding, migrations);
  await binding.prepare("INSERT INTO games (id, steam_app_id, name) VALUES (900, 42, 'Deleted high-water')").run();
  await binding.prepare("DELETE FROM games WHERE id = 900").run();
  await applyMigrations(binding, migrations);
  expect(await binding.prepare("INSERT INTO games (steam_app_id, name) VALUES (43, 'Next allocation') RETURNING id").first<number>("id")).toBe(901);
});

test("explicit bootstrap is repeatable without replacing catalog data or migration receipts", async () => {
  const binding = await isolatedD1();
  const migrations = await loadMigrations();
  const first = await applyMigrations(binding, migrations);
  await binding.batch([
    binding.prepare("INSERT INTO games (steam_app_id, name) VALUES (42, 'Retained')"),
    binding.prepare("INSERT INTO sync_state (key, last_success_at) VALUES ('steam_status', 1700000000)"),
    binding.prepare("INSERT INTO catalog_refresh_state (key, last_app_id) VALUES ('steam_official_catalog', 42)"),
    binding.prepare("INSERT INTO catalog_refresh_failures (steam_app_id, name, error, attempts) VALUES (43, 'Retry', 'Synthetic', 3)"),
    binding.prepare("INSERT INTO itad_game_map VALUES (42, NULL, 1700000000)"),
    binding.prepare("INSERT INTO game_deal_cache VALUES (42, 'US', 'retail', 1700000000, '[]')"),
    binding.prepare("INSERT INTO deal_refresh_state (country, games_checked) VALUES ('US', 12)"),
  ]);
  const repeated = await applyMigrations(binding, migrations);
  expect((await binding.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name != 'steam_value_migrations' ORDER BY name").all()).results).toEqual([
    { name: "__drizzle_migrations" }, { name: "catalog_refresh_failures" }, { name: "catalog_refresh_state" }, { name: "deal_refresh_state" },
    { name: "game_deal_cache" }, { name: "games" }, { name: "itad_game_map" }, { name: "sync_state" },
  ]);
  expect((await binding.batch([
    binding.prepare("SELECT 'catalog_refresh_failures' AS name, attempts AS value FROM catalog_refresh_failures"),
    binding.prepare("SELECT 'catalog_refresh_state' AS name, last_app_id AS value FROM catalog_refresh_state"),
    binding.prepare("SELECT 'deal_refresh_state' AS name, games_checked AS value FROM deal_refresh_state"),
    binding.prepare("SELECT 'game_deal_cache' AS name, checked_at AS value FROM game_deal_cache"),
    binding.prepare("SELECT 'itad_game_map' AS name, checked_at AS value FROM itad_game_map"),
    binding.prepare("SELECT 'sync_state' AS name, last_success_at AS value FROM sync_state"),
  ])).flatMap((result) => result.results)).toEqual([
    { name: "catalog_refresh_failures", value: 3 }, { name: "catalog_refresh_state", value: 42 },
    { name: "deal_refresh_state", value: 12 }, { name: "game_deal_cache", value: 1700000000 },
    { name: "itad_game_map", value: 1700000000 }, { name: "sync_state", value: 1700000000 },
  ]);
  expect({ first, repeated, catalog: await binding.prepare("SELECT name FROM games").all() }).toMatchObject({
    first: { applied: ["0001_complete_schema.sql", "0002_retain_legacy_metadata.sql"], alreadyApplied: [], schemaFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
    repeated: { applied: [], alreadyApplied: ["0001_complete_schema.sql", "0002_retain_legacy_metadata.sql"], schemaFingerprint: first.schemaFingerprint },
    catalog: { results: [{ name: "Retained" }] },
  });
});
