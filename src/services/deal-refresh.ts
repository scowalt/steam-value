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
const LEASE_SECONDS = 15 * 60;
const MAPPING_MAX_AGE = 7 * 24 * 60 * 60;
const BATCH_SIZE = 200;
type WriteStatement = { sql: string; args: DbValue[] };
interface WriteEntry { statement: WriteStatement; requireOne: boolean }
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
  const renew = async () => {
    const result = await client.execute({
      sql: "UPDATE deal_refresh_state SET lock_expires_at=?, games_checked=? WHERE country=? AND lock_token=? AND lock_expires_at>?",
      args: [now() + LEASE_SECONDS, checked, DEAL_COUNTRY, token, now()],
    });
    if (result.rowsAffected !== 1) throw new OfferRefreshError("Offer refresh lease expired or was replaced");
  };

  try {
    const rows = await loadRankedGames(client, options.limit ?? -1);
    options.onProgress?.(`Loading active US bundles for ${rows.length} ranked games`);
    const bundles = await providerRequest(() => source.bundles(DEAL_COUNTRY));
    await renew();

    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const batch = rows.slice(offset, offset + BATCH_SIZE);
      const lookupIds = batch.filter((row) => row.checked_at === null || Number(row.checked_at) <= now() - MAPPING_MAX_AGE)
        .map((row) => Number(row.steam_app_id));
      const mappings = lookupIds.length ? await providerRequest(() => source.lookup(lookupIds)) : new Map<number, string | null>();
      await renew();
      const mappingWrites: WriteGroup[] = [];
      for (const row of batch) {
        const appId = Number(row.steam_app_id);
        if (lookupIds.includes(appId) && !mappings.has(appId)) throw new OfferRefreshError("Incomplete ITAD mapping batch");
        if (!mappings.has(appId)) mappings.set(appId, row.itad_id === null ? null : String(row.itad_id));
        else {
          const g = guard();
          const id = mappings.get(appId)!;
          const entries: WriteGroup = [];
          if (id !== row.itad_id) {
            entries.push({ statement: { sql: `DELETE FROM game_deal_cache WHERE steam_app_id=? AND ${g.sql}`, args: [appId, ...g.args] }, requireOne: false });
          }
          entries.push({
            statement: {
              sql: `INSERT INTO itad_game_map (steam_app_id, itad_id, checked_at)
              SELECT ?, ?, ? WHERE ${g.sql}
              ON CONFLICT(steam_app_id) DO UPDATE SET itad_id=excluded.itad_id, checked_at=excluded.checked_at`,
              args: [appId, id, now(), ...g.args],
            },
            requireOne: true,
          });
          mappingWrites.push(entries);
        }
      }
      await writeGroups(client, mappingWrites, "Offer refresh lost mapping lease");
      const ids = [...new Set([...mappings.values()].filter((id): id is string => id !== null))];
      const priceFetchedAt = now();
      const prices = ids.length ? await providerRequest(() => source.prices(ids, DEAL_COUNTRY)) : new Map<string, DealOffer[]>();
      await renew();
      const writes: WriteGroup[] = [];
      const save = (appId: number, kind: string, fetchedAt: number, offers: DealOffer[]): WriteStatement => {
        const g = guard();
        return {
          sql: `INSERT INTO game_deal_cache (steam_app_id, country, kind, checked_at, offers_json)
            SELECT ?, ?, ?, ?, ? WHERE ${g.sql}
            ON CONFLICT(steam_app_id,country,kind) DO UPDATE SET checked_at=excluded.checked_at, offers_json=excluded.offers_json`,
          args: [appId, DEAL_COUNTRY, kind, fetchedAt, JSON.stringify(offers), ...g.args],
        };
      };
      for (const row of batch) {
        const appId = Number(row.steam_app_id);
        const id = mappings.get(appId)!;
        if (id === null) { unmapped++; continue; }
        const offers = prices.get(id);
        const entries: WriteGroup = [];
        if (offers === undefined) missingPrices++;
        else entries.push({ statement: save(appId, "retail", priceFetchedAt, offers), requireOne: true });
        entries.push({ statement: save(appId, "bundle", bundles.fetchedAt, bundles.games.get(id) ?? []), requireOne: true });
        writes.push(entries);
      }
      await writeGroups(client, writes, "Offer refresh lost publication lease");
      checked += batch.length;
      await renew();
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
    const size = Math.min(1000, remaining);
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

async function writeGroups(client: DbClient, groups: WriteGroup[], leaseError: string): Promise<void> {
  const baseBytes = byteLength(encodeDbRequest({ version: 1, op: "batch", mode: "write", statements: [] }));
  const batches: WriteGroup[] = [];
  let batch: WriteGroup = [];
  let bytes = baseBytes;
  for (const group of groups) {
    const entries = validateBatch(group.map(({ statement }) => statement)).map(({ sql, args }, index) => ({
      statement: { sql, args }, requireOne: group[index]!.requireOne,
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
    if (results.some((result, index) => group[index]!.requireOne && result.rowsAffected !== 1)) throw new OfferRefreshError(leaseError);
  }
}
