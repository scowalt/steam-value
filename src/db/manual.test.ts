import { afterEach, beforeEach, expect, test } from "bun:test";
import { asc, desc, eq, isNull } from "drizzle-orm";
import { createD1WorkerTestHarness, type D1WorkerTestHarness } from "./testing";
import { createHttpClient } from "./http";
import { createDrizzleDb } from "./drizzle";
import { games } from "./schema";
import { deleteGames, findGame, insertGames, readAllGames, readAllRows, recalculateScores, syncManualWishlist, updateGame } from "./manual";
import { DbError, toDbError } from "./access";
import { inspectDatabase } from "./admin";

let harness: D1WorkerTestHarness;
beforeEach(async () => { harness = await createD1WorkerTestHarness(); });
afterEach(async () => { await harness?.dispose(); });

async function seedCatalog(count: number) {
  const client = createHttpClient(harness.clientConfig);
  const statements = [];
  for (let start = 1; start <= count; start += 50) {
    const ids = Array.from({ length: Math.min(50, count - start + 1) }, (_, index) => start + index);
    statements.push({
      sql: `INSERT INTO games (steam_app_id, name) VALUES ${ids.map(() => "(?, ?)").join(",")}`,
      args: ids.flatMap((id) => [id, `Synthetic ${String(id).padStart(5, "0")}`]),
    });
  }
  await client.batch(statements, "write");
}

test("manual reports read the complete Game Catalog beyond the per-result cap in stable SQL order", async () => {
  await seedCatalog(10001);
  const db = createDrizzleDb(createHttpClient(harness.clientConfig));
  const catalog = await readAllGames(db, { orderBy: desc(games.name) });
  expect(catalog.length).toBe(10001);
  expect(new Set(catalog.map((game) => game.steamAppId)).size).toBe(10001);
  expect(catalog[0]?.name).toBe("Synthetic 10001");
  expect(catalog.at(-1)?.name).toBe("Synthetic 00001");
});

test("manual multi-chunk insertion returns every typed game and preserves relational and projected reads", async () => {
  const db = createDrizzleDb(createHttpClient(harness.clientConfig));
  const createdAt = new Date("2024-01-02T03:04:05.999Z");
  const inserted = await insertGames(db, Array.from({ length: 205 }, (_, index) => ({
    steamAppId: index + 1, name: `Inserted ${index + 1}`, isOwned: true, isIgnored: null,
    tags: '["City Builder","Co-op"]', createdAt, updatedAt: null,
  })));
  expect(inserted.length).toBe(205);
  expect(new Set(inserted.map((game) => game.id)).size).toBe(205);
  expect(inserted.at(-1)).toMatchObject({ steamAppId: 205, isOwned: true, isIgnored: null, isEndless: false, tags: '["City Builder","Co-op"]', createdAt: new Date("2024-01-02T03:04:05Z"), updatedAt: null });
  expect(await db.query.games.findFirst({ where: eq(games.steamAppId, 205) })).toEqual(inserted.at(-1));
  expect(await db.select({ zName: games.name, aAppId: games.steamAppId, owned: games.isOwned }).from(games).where(eq(games.steamAppId, 205))).toEqual([{ zName: "Inserted 205", aAppId: 205, owned: true }]);
});

test("manual wishlist sets and clears more than 98 IDs including the flag and automatic timestamp binds", async () => {
  await seedCatalog(235);
  const db = createDrizzleDb(createHttpClient(harness.clientConfig));
  await db.update(games).set({ isOnWishlist: true, updatedAt: new Date("2000-01-01T00:00:00Z") });
  const wishlist = new Set(Array.from({ length: 123 }, (_, index) => index + 1));
  const result = await syncManualWishlist(db, wishlist);
  const catalog = await readAllGames(db);
  expect(result.wishlisted.length).toBe(123);
  expect(result.notWishlisted.length).toBe(112);
  expect(catalog.filter((game) => game.isOnWishlist).map((game) => game.steamAppId)).toEqual([...wishlist]);
  expect(catalog.filter((game) => game.updatedAt && game.updatedAt > new Date("2000-01-01T00:00:00Z")).length).toBe(235);
});

test("explicit manual cleanup deletes all selected IDs across chunks and retains every unselected game", async () => {
  await seedCatalog(235);
  const db = createDrizzleDb(createHttpClient(harness.clientConfig));
  const removed = await deleteGames(db, [...Array.from({ length: 205 }, (_, index) => index + 1), 1, 100, 9999]);
  expect(removed).toBe(205);
  expect((await readAllGames(db)).map((game) => game.steamAppId)).toEqual(Array.from({ length: 30 }, (_, index) => index + 206));
  expect(await deleteGames(db, [])).toBe(0);
});

test("manual recalculation keeps raw and ORM Value Scores consistent across more than one 200-game group", async () => {
  await seedCatalog(405);
  const client = createHttpClient(harness.clientConfig);
  const db = createDrizzleDb(client);
  await db.update(games).set({ hltbMain: 1, steamReviewScore: 99, valueScore: 1 });
  await updateGame(db, eq(games.steamAppId, 1), { valueScore: 343000 });
  await updateGame(db, eq(games.steamAppId, 402), { steamReviewScore: 90, steamReviewCount: 500 });
  await updateGame(db, eq(games.steamAppId, 404), { hltbMain: null });
  await updateGame(db, eq(games.steamAppId, 405), { isEndless: true });
  const report = await recalculateScores(db, client);
  expect(report).toMatchObject({ updated: 404, unchanged: 1, failed: 0 });
  const catalog = await readAllGames(db);
  expect(catalog.filter((game) => game.valueScore === 343000).length).toBe(402);
  expect(catalog.find((game) => game.steamAppId === 402)?.valueScore).toBe(512000);
  expect(catalog.slice(-2).map((game) => game.valueScore)).toEqual([null, null]);
  expect((await client.execute("SELECT value_score AS score FROM games WHERE steam_app_id IN (402,404,405) ORDER BY steam_app_id")).rows).toEqual([{ score: 512000 }, { score: null }, { score: null }]);
});

test("an empty manual wishlist remains a no-change operation rather than clearing Steam Status", async () => {
  const db = createDrizzleDb(createHttpClient(harness.clientConfig));
  await insertGames(db, [{ steamAppId: 1, name: "Previously wishlisted", isOnWishlist: true }]);
  await syncManualWishlist(db, new Set());
  expect((await findGame(db, 1))?.isOnWishlist).toBe(true);
});

test("manual insertion rolls back earlier chunks on a late duplicate and returns only safe normalized diagnostics", async () => {
  const db = createDrizzleDb(createHttpClient(harness.clientConfig));
  const records = Array.from({ length: 205 }, (_, index) => ({ steamAppId: index + 1, name: "private-game-parameter" }));
  records.push({ steamAppId: 1, name: "private-duplicate-parameter" });
  let failure: unknown;
  try { await insertGames(db, records); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(DbError);
  expect(toDbError(failure)).toMatchObject({ code: "SQL_ERROR", outcome: "rolled-back", message: "Database constraint violation" });
  expect(String(failure).includes("private-")).toBe(false);
  expect((await readAllGames(db)).length).toBe(0);
});

test("manual recalculation stops on a lost write response without replaying or processing later groups", async () => {
  await seedCatalog(405);
  const client = createHttpClient(harness.clientConfig);
  const db = createDrizzleDb(client);
  await db.update(games).set({ hltbMain: 1, steamReviewScore: 99, valueScore: 1 });
  const uncertain = createHttpClient({ ...harness.clientConfig, fetch: async (request) => {
    const body = await request.clone().json() as { op: string; mode?: string };
    const response = await harness.fetch(request);
    if (body.op === "batch" && body.mode === "write") throw new Error("private-lost-response");
    return response;
  } });
  let failure: unknown;
  try { await recalculateScores(createDrizzleDb(uncertain), uncertain); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(DbError);
  expect(toDbError(failure)).toMatchObject({ code: "OUTCOME_UNKNOWN", outcome: "unknown" });
  expect(String(failure).includes("private-lost-response")).toBe(false);
  const catalog = await readAllGames(db);
  expect(catalog.filter((game) => game.valueScore === 343000).length).toBe(200);
  expect(catalog.filter((game) => game.valueScore === 1).length).toBe(205);
});

test("filtered and limited manual reads preserve stable ties and complete projected field order", async () => {
  await seedCatalog(1201);
  const db = createDrizzleDb(createHttpClient(harness.clientConfig));
  await updateGame(db, eq(games.steamAppId, 1), { controllerSupport: "full" });
  const limited = await readAllGames(db, { where: isNull(games.controllerSupport), orderBy: desc(games.valueScore), limit: 1005 });
  expect(limited.map((game) => game.steamAppId)).toEqual(Array.from({ length: 1005 }, (_, index) => index + 2));
  const projected = await readAllRows(({ limit, offset }) => db.select({ zName: games.name, aAppId: games.steamAppId }).from(games).orderBy(asc(games.id)).limit(limit).offset(offset));
  expect(projected.length).toBe(1201);
  expect(projected.at(-1)).toEqual({ zName: "Synthetic 01201", aAppId: 1201 });
});

test("complete manual reads reduce read-only pages for wide JSON rather than truncating the catalog", async () => {
  await seedCatalog(205);
  const db = createDrizzleDb(createHttpClient(harness.clientConfig));
  const tags = JSON.stringify(["Wide catalog tag ".repeat(4500)]);
  await db.update(games).set({ tags });
  const catalog = await readAllGames(db);
  expect(catalog.length).toBe(205);
  expect(catalog.every((game) => game.tags === tags)).toBe(true);
  expect(catalog.at(-1)?.steamAppId).toBe(205);
});

test("manual enrichment preserves nullable ownership, Playtime, game-mode booleans, JSON text and Date updates", async () => {
  const db = createDrizzleDb(createHttpClient(harness.clientConfig));
  await insertGames(db, [{ steamAppId: 7, name: "Enrichment", createdAt: new Date("2000-01-01T00:00:00Z") }]);
  await updateGame(db, eq(games.steamAppId, 7), {
    isOwned: true, playtimeMinutes: 0, isEarlyAccess: true, controllerSupport: null, hasSinglePlayer: true,
    hasMultiplayer: false, hasCoOp: true, hasOnlineCoOp: false, hasLocalCoOp: null, hasPvP: false,
    hasOnlinePvP: true, hasLocalPvP: false, hasCrossplatform: true, isMMO: false,
    hltbId: 70, hltbMain: 12.5, hltbMainExtra: null, hltbCompletionist: 30,
    releaseDate: "2024-01-02", tags: '["Strategy","City Builder"]',
  });
  expect(await findGame(db, 7)).toMatchObject({
    isOwned: true, playtimeMinutes: 0, controllerSupport: null, hasSinglePlayer: true, hasLocalCoOp: null,
    hasOnlinePvP: true, hltbMain: 12.5, hltbMainExtra: null, tags: '["Strategy","City Builder"]',
    createdAt: new Date("2000-01-01T00:00:00Z"), updatedAt: expect.any(Date),
  });
  await updateGame(db, eq(games.steamAppId, 7), { isOwned: false, playtimeMinutes: null });
  expect(await findGame(db, 7)).toMatchObject({ isOwned: false, playtimeMinutes: null });
});

test("the shared ORM batch keeps relational first, absent first and projected arrays in their declared field order", async () => {
  const db = createDrizzleDb(createHttpClient(harness.clientConfig));
  await insertGames(db, [{ steamAppId: 8, name: "Batch projection", isOwned: true }]);
  const results = await db.batch([
    db.query.games.findFirst({ where: eq(games.steamAppId, 8), columns: { name: true, isOwned: true } }),
    db.query.games.findFirst({ where: eq(games.steamAppId, 999) }),
    db.select({ zName: games.name, aAppId: games.steamAppId }).from(games),
  ]);
  expect(results).toEqual([{ name: "Batch projection", isOwned: true }, undefined, [{ zName: "Batch projection", aAppId: 8 }]]);
});

test("application inspection uses the same Worker/client seam for schema, all-table counts and bounded samples", async () => {
  await seedCatalog(235);
  const report = await inspectDatabase(createHttpClient(harness.clientConfig), { table: "games", limit: 2, offset: 200 });
  expect(report.tables).toContainEqual({ name: "games", rowCount: 235 });
  expect(report.schemaObjects.some((object) => object.name === "games_steam_app_id_unique")).toBe(true);
  expect(report.sample?.rows.map((row) => row.steam_app_id)).toEqual([201, 202]);
});

test("manual cleanup rejects invalid IDs in a later chunk before deleting any earlier selection", async () => {
  await seedCatalog(235);
  const db = createDrizzleDb(createHttpClient(harness.clientConfig));
  await expect(deleteGames(db, [...Array.from({ length: 205 }, (_, index) => index + 1), NaN])).rejects.toMatchObject({ code: "INVALID_REQUEST", outcome: "not-applied" });
  expect((await readAllGames(db)).length).toBe(235);
});

test("manual insertion refuses an over-limit atomic group rather than silently splitting or committing a prefix", async () => {
  const db = createDrizzleDb(createHttpClient(harness.clientConfig));
  const records = Array.from({ length: 1201 }, (_, index) => ({ steamAppId: index + 1, name: `Atomic ${index + 1}` }));
  await expect(insertGames(db, records)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", outcome: "not-applied" });
  expect((await readAllGames(db)).length).toBe(0);
});
