import { asc, eq, getTableColumns, inArray, type SQL } from "drizzle-orm";
import { DB_LIMITS, DbError, toDbError, type DbClient } from "./access";
import type { createDrizzleDb } from "./drizzle";
import { games, type NewGame } from "./schema";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { calculateGameValueScore } from "../formula";

export type ManualDb = ReturnType<typeof createDrizzleDb>;
export interface GameReadOptions {
  where?: SQL;
  orderBy?: SQL | SQL[];
  limit?: number;
}

export interface ScoreUpdate {
  id: number;
  name: string;
  oldScore: number | null;
  newScore: number | null;
}

export async function recalculateScores(db: ManualDb, client: DbClient, onBatch?: (batch: { number: number; updated: number; total: number; count: number; error?: DbError }) => void) {
  const catalog = await readAllGames(db);
  const updates: ScoreUpdate[] = [];
  let unchanged = 0;
  for (const game of catalog) {
    const newScore = calculateGameValueScore(game);
    if (newScore === game.valueScore) unchanged++;
    else updates.push({ id: game.id, name: game.name, oldScore: game.valueScore, newScore });
  }
  let updated = 0;
  let failed = 0;
  for (let start = 0; start < updates.length; start += 200) {
    const selected = updates.slice(start, start + 200);
    let failure: DbError | undefined;
    try {
      await dbOperation(() => client.batch(selected.map((update) => ({
        sql: "UPDATE games SET value_score = ?, updated_at = unixepoch() WHERE id = ?",
        args: [update.newScore, update.id],
      })), "write"));
      updated += selected.length;
    } catch (error) {
      failure = toDbError(error);
      recoverableManualError(failure);
      failed += selected.length;
    }
    onBatch?.({ number: Math.floor(start / 200) + 1, updated, total: updates.length, count: selected.length, error: failure });
  }
  return { updates, unchanged, updated, failed, total: catalog.length };
}

export function reportManualError(error: unknown) {
  const safe = toDbError(error);
  console.error(`${safe.code} (${safe.outcome}): ${safe.message}${safe.requestId ? ` [${safe.requestId}]` : ""}`);
  process.exitCode = 1;
}

export function recoverableManualError(error: unknown): Error {
  if (error instanceof DbError || error instanceof DrizzleQueryError) {
    const safe = toDbError(error);
    if (safe.outcome === "unknown" || safe.outcome === "committed") throw safe;
    return safe;
  }
  return error instanceof Error ? error : new Error("Manual operation failed");
}

export async function findGame(db: ManualDb, steamAppId: number) {
  return dbOperation(() => db.query.games.findFirst({ where: eq(games.steamAppId, steamAppId) }));
}

export async function updateGame(db: ManualDb, where: SQL, values: Partial<NewGame>) {
  return dbOperation(() => db.update(games).set(values).where(where));
}

export async function deleteGames(db: ManualDb, ids: readonly number[]) {
  const selected = [...new Set(ids)];
  const queries = [];
  for (let start = 0; start < selected.length; start += DB_LIMITS.maxParams) {
    queries.push(db.delete(games).where(inArray(games.id, selected.slice(start, start + DB_LIMITS.maxParams))).returning({ id: games.id }));
  }
  const [first, ...rest] = queries;
  if (!first) return 0;
  return (await dbOperation(() => db.batch([first, ...rest]))).flat().length;
}

export async function syncManualWishlist(db: ManualDb, wishlist: ReadonlySet<number>) {
  const catalog = await readAllGames(db);
  if (wishlist.size === 0) return { wishlisted: [], notWishlisted: [] };
  const wishlisted = catalog.filter((game) => wishlist.has(game.steamAppId));
  const notWishlisted = catalog.filter((game) => !wishlist.has(game.steamAppId));
  const fixedBinds = db.update(games).set({ isOnWishlist: true }).where(eq(games.id, 0)).toSQL().params.length - 1;
  const size = DB_LIMITS.maxParams - fixedBinds;
  const queries = [];
  for (const [selected, isOnWishlist] of [[wishlisted, true], [notWishlisted, false]] as const) {
    for (let start = 0; start < selected.length; start += size) {
      queries.push(db.update(games).set({ isOnWishlist }).where(inArray(games.id, selected.slice(start, start + size).map((game) => game.id))).returning({ id: games.id }));
    }
  }
  const [first, ...rest] = queries;
  if (first) await dbOperation(() => db.batch([first, ...rest]));
  return { wishlisted, notWishlisted };
}

export async function insertGames(db: ManualDb, values: NewGame[]) {
  const queries = [];
  const rowsPerStatement = Math.floor(DB_LIMITS.maxParams / Object.keys(getTableColumns(games)).length);
  for (let start = 0; start < values.length; start += rowsPerStatement) {
    queries.push(db.insert(games).values(values.slice(start, start + rowsPerStatement)).returning());
  }
  const [first, ...rest] = queries;
  if (!first) return [];
  return (await dbOperation(() => db.batch([first, ...rest]))).flat();
}

export async function dbOperation<T>(operation: () => PromiseLike<T>): Promise<T> {
  try { return await operation(); } catch (error) { throw toDbError(error); }
}

export async function readAllRows<T>(readPage: (page: { limit: number; offset: number }) => PromiseLike<T[]>, limit?: number): Promise<T[]> {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new DbError("INVALID_REQUEST", "not-applied");
  const rows: T[] = [];
  let pageSize = 500;
  while (limit === undefined || rows.length < limit) {
    const size = Math.min(pageSize, limit === undefined ? pageSize : limit - rows.length);
    let page: T[];
    try {
      page = await dbOperation(() => readPage({ limit: size, offset: rows.length }));
    } catch (error) {
      const safe = toDbError(error);
      if (safe.code !== "RESULT_LIMIT" || safe.outcome !== "not-applied" || size === 1) throw safe;
      pageSize = Math.max(1, Math.floor(size / 2));
      continue;
    }
    if (page.length > size) throw new DbError("PROTOCOL_ERROR", "not-applied");
    rows.push(...page);
    if (page.length < size) break;
  }
  return rows;
}

export async function readAllGames(db: ManualDb, options: GameReadOptions = {}) {
  const orderBy = options.orderBy === undefined ? [] : Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy];
  return readAllRows((page) => db.query.games.findMany({
    where: options.where, orderBy: [...orderBy, asc(games.id)], ...page,
  }), options.limit);
}
