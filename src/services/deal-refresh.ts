import { DB_LIMITS, DbError, byteLength, encodeDbRequest, toDbError, validateBatch, type DbClient, type DbValue } from "../db/access.ts";
import { DEAL_COUNTRY } from "./deal-types.ts";
import type { DealOffer } from "./deal-types.ts";
import { ItadError } from "./itad-errors.ts";

export interface DealSource {
  lookup(appIds: number[]): Promise<Map<number, string | null>>;
  prices(ids: string[], country: string): Promise<Map<string, DealOffer[]>>;
  bundles(country: string): Promise<{ fetchedAt: number; games: Map<string, DealOffer[]> }>;
}
interface RefreshOptions {
  now?: () => number;
  limit?: number;
  onProgress?: (message: string) => void;
}
const LEASE_SECONDS = 30 * 60;
const MAPPING_MAX_AGE = 7 * 24 * 60 * 60;
const BATCH_SIZE = 200;
type WriteStatement = { sql: string; args: DbValue[] };
interface WriteEntry { statement: WriteStatement; changes: number | null }
type WriteGroup = WriteEntry[];
export class OfferRefreshError extends Error {}

export async function refreshGameDeals(client: DbClient, source: DealSource, options: RefreshOptions = {}) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const token = crypto.randomUUID();
  const started = now();
  const acquired = await client.execute({
    sql: `INSERT INTO deal_refresh_state (country, last_attempt_at, lock_token, lock_expires_at, games_checked)
      VALUES (?, ?, ?, ?, 0) ON CONFLICT(country) DO UPDATE SET
        last_attempt_at=excluded.last_attempt_at, lock_token=excluded.lock_token,
        lock_expires_at=excluded.lock_expires_at, games_checked=0, last_error=NULL
      WHERE deal_refresh_state.lock_expires_at IS NULL OR deal_refresh_state.lock_expires_at <= ?`,
    args: [DEAL_COUNTRY, started, token, started + LEASE_SECONDS, started],
  }).catch((error) => { throw toDbError(error); });
  if (acquired.rowsAffected === 0) return { skipped: true, gamesChecked: 0, missingPrices: 0, unmapped: 0 };

  let checked = 0;
  let missingPrices = 0;
  let unmapped = 0;
  const guard = () => ({
    sql: "EXISTS (SELECT 1 FROM deal_refresh_state WHERE country=? AND lock_token=? AND lock_expires_at>?)",
    args: [DEAL_COUNTRY, token, now()] satisfies DbValue[],
  });
  const renewal = (gamesChecked: number): WriteStatement => ({
    sql: "UPDATE deal_refresh_state SET lock_expires_at=?, games_checked=? WHERE country=? AND lock_token=? AND lock_expires_at>?",
    args: [now() + LEASE_SECONDS, gamesChecked, DEAL_COUNTRY, token, now()],
  });
  const guardedRows = (columns: number, rows: DbValue[][], statement: (values: string, guard: string) => string): WriteEntry[] => {
    const size = Math.floor((DB_LIMITS.maxParams - guard().args.length) / columns);
    return Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => {
      const chunk = rows.slice(index * size, (index + 1) * size);
      const g = guard();
      const values = `(VALUES ${chunk.map((row) => `(${row.map(() => "?").join(", ")})`).join(", ")})`;
      return { statement: { sql: statement(values, g.sql), args: [...chunk.flat(), ...g.args] }, changes: chunk.length };
    });
  };

  try {
    const rows = await loadRankedGames(client, options.limit ?? -1);
    options.onProgress?.(`Loading active US bundles for ${rows.length} ranked games`);
    const bundles = await providerRequest(() => source.bundles(DEAL_COUNTRY));
    const renewed = await client.execute(renewal(checked));
    if (renewed.rowsAffected !== 1) throw new OfferRefreshError("Offer refresh lease expired or was replaced");

    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const batch = rows.slice(offset, offset + BATCH_SIZE);
      const lookupIds = batch.filter((row) => row.checked_at === null || Number(row.checked_at) <= now() - MAPPING_MAX_AGE)
        .map((row) => Number(row.steam_app_id));
      const mappings = lookupIds.length ? await providerRequest(() => source.lookup(lookupIds)) : new Map<number, string | null>();
      const remapped: DbValue[][] = [];
      const mapped: DbValue[][] = [];
      for (const row of batch) {
        const appId = Number(row.steam_app_id);
        if (lookupIds.includes(appId) && !mappings.has(appId)) throw new OfferRefreshError("Incomplete ITAD mapping batch");
        if (!mappings.has(appId)) mappings.set(appId, row.itad_id === null ? null : String(row.itad_id));
        else {
          const id = mappings.get(appId)!;
          if (id !== row.itad_id) remapped.push([appId]);
          mapped.push([appId, id, now()]);
        }
      }
      const ids = [...new Set([...mappings.values()].filter((id): id is string => id !== null))];
      const priceFetchedAt = now();
      const prices = ids.length ? await providerRequest(() => source.prices(ids, DEAL_COUNTRY)) : new Map<string, DealOffer[]>();
      const mappingWrites: WriteGroup = [
        ...guardedRows(1, remapped, (values, guard) => `DELETE FROM game_deal_cache WHERE steam_app_id IN (SELECT column1 FROM ${values}) AND ${guard}`)
          .map(({ statement }) => ({ statement, changes: null })),
        ...guardedRows(3, mapped, (values, guard) => `INSERT INTO itad_game_map (steam_app_id, itad_id, checked_at)
          SELECT column1, column2, column3 FROM ${values} WHERE ${guard}
          ON CONFLICT(steam_app_id) DO UPDATE SET itad_id=excluded.itad_id, checked_at=excluded.checked_at`),
      ];
      const writes: WriteGroup[] = mappingWrites.length ? [mappingWrites] : [];
      for (const row of batch) {
        const appId = Number(row.steam_app_id);
        const id = mappings.get(appId)!;
        if (id === null) { unmapped++; continue; }
        const offers = prices.get(id);
        const scopes: DbValue[][] = [];
        if (offers === undefined) missingPrices++;
        else scopes.push([appId, DEAL_COUNTRY, "retail", priceFetchedAt, JSON.stringify(offers)]);
        scopes.push([appId, DEAL_COUNTRY, "bundle", bundles.fetchedAt, JSON.stringify(bundles.games.get(id) ?? [])]);
        writes.push(guardedRows(5, scopes, (values, guard) => `INSERT INTO game_deal_cache (steam_app_id, country, kind, checked_at, offers_json)
          SELECT column1, column2, column3, column4, column5 FROM ${values} WHERE ${guard}
          ON CONFLICT(steam_app_id,country,kind) DO UPDATE SET checked_at=excluded.checked_at, offers_json=excluded.offers_json`));
      }
      writes.push([{ statement: renewal(checked + batch.length), changes: 1 }]);
      await writeGroups(client, writes);
      checked += batch.length;
      options.onProgress?.(`Checked ${checked}/${rows.length}; ${unmapped} unmapped, ${missingPrices} missing retail responses`);
    }
    const g = guard();
    const result = await client.execute({
      sql: `UPDATE deal_refresh_state SET last_success_at=?, last_error=NULL, games_checked=?, lock_token=NULL, lock_expires_at=NULL
        WHERE country=? AND ${g.sql}`,
      args: [now(), checked, DEAL_COUNTRY, ...g.args],
    });
    if (result.rowsAffected !== 1) throw new OfferRefreshError("Offer refresh lost completion lease");
    return { skipped: false, gamesChecked: checked, missingPrices, unmapped };
  } catch (error) {
    const safe = error instanceof OfferRefreshError ? error : toDbError(error);
    if (safe instanceof DbError && (safe.outcome === "unknown" || safe.outcome === "committed")) throw safe;
    await client.execute({
      sql: "UPDATE deal_refresh_state SET last_error=?, games_checked=?, lock_token=NULL, lock_expires_at=NULL WHERE country=? AND lock_token=?",
      args: [safe.message, checked, DEAL_COUNTRY, token],
    }).catch((failure) => { throw toDbError(failure); });
    throw safe;
  }
}

async function loadRankedGames(client: DbClient, limit: number): Promise<Record<string, DbValue>[]> {
  if (!Number.isSafeInteger(limit)) throw new DbError("INVALID_REQUEST", "not-applied");
  const rows: Record<string, DbValue>[] = [];
  let remaining = limit < 0 ? Infinity : limit;
  let cursor: { score: number; appId: number } | null = null;
  while (remaining > 0) {
    const size = Math.min(DB_LIMITS.maxRowsPerResult, remaining);
    const page = await client.execute({
      sql: `SELECT g.steam_app_id, g.value_score, m.itad_id, m.checked_at FROM games g
        LEFT JOIN itad_game_map m ON m.steam_app_id=g.steam_app_id
        WHERE g.value_score IS NOT NULL AND g.is_endless=0
        ${cursor === null ? "" : "AND (g.value_score < ? OR (g.value_score = ? AND g.steam_app_id > ?))"}
        ORDER BY g.value_score DESC, g.steam_app_id LIMIT ?`,
      args: cursor === null ? [size] : [cursor.score, cursor.score, cursor.appId, size],
    });
    rows.push(...page.rows);
    remaining -= page.rows.length;
    if (page.rows.length < size) break;
    const last = page.rows.at(-1)!;
    cursor = { score: Number(last.value_score), appId: Number(last.steam_app_id) };
  }
  return rows;
}

async function providerRequest<T>(request: () => Promise<T>): Promise<T> {
  try { return await request(); }
  catch (error) {
    throw new OfferRefreshError(ItadError.safeMessage(error) ?? "Offer provider request failed");
  }
}

async function writeGroups(client: DbClient, groups: WriteGroup[]): Promise<void> {
  const baseBytes = byteLength(encodeDbRequest({ version: 1, op: "batch", mode: "write", statements: [] }));
  const batches: WriteGroup[] = [];
  let batch: WriteGroup = [];
  let bytes = baseBytes;
  for (const group of groups) {
    const entries = validateBatch(group.map(({ statement }) => statement)).map(({ sql, args }, index) => ({
      statement: { sql, args }, changes: group[index]!.changes,
    }));
    const groupBytes = byteLength(encodeDbRequest({ version: 1, op: "batch", mode: "write", statements: entries.map(({ statement }) => statement) })) - baseBytes;
    const separator = batch.length ? 1 : 0;
    if (batch.length + entries.length > DB_LIMITS.maxStatements || bytes + separator + groupBytes > DB_LIMITS.maxRequestBytes) {
      batches.push(batch);
      batch = [];
      bytes = baseBytes;
    }
    bytes += groupBytes + (batch.length ? 1 : 0);
    batch.push(...entries);
  }
  if (batch.length) batches.push(batch);
  for (const group of batches) {
    const results = await client.batch(group.map(({ statement }) => statement), "write");
    if (results.some((result, index) => group[index]!.changes !== null && result.rowsAffected !== group[index]!.changes)) throw new OfferRefreshError("Offer refresh lost publication lease");
  }
}
