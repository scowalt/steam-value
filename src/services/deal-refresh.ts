import type { Client, InValue } from "@libsql/client/web";
import { DEAL_COUNTRY, ensureDealTables, unixNow } from "./game-deals";
import type { DealOffer } from "./deal-types";

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

export async function refreshGameDeals(client: Client, source: DealSource, options: RefreshOptions = {}) {
  const now = options.now ?? unixNow;
  await ensureDealTables(client);
  const token = crypto.randomUUID();
  const started = now();
  const acquired = await client.execute({
    sql: `INSERT INTO deal_refresh_state (country, last_attempt_at, lock_token, lock_expires_at, games_checked)
      VALUES (?, ?, ?, ?, 0) ON CONFLICT(country) DO UPDATE SET
        last_attempt_at=excluded.last_attempt_at, lock_token=excluded.lock_token,
        lock_expires_at=excluded.lock_expires_at, games_checked=0, last_error=NULL
      WHERE deal_refresh_state.lock_expires_at IS NULL OR deal_refresh_state.lock_expires_at <= ?`,
    args: [DEAL_COUNTRY, started, token, started + LEASE_SECONDS, started],
  });
  if (acquired.rowsAffected === 0) return { skipped: true, gamesChecked: 0, missingPrices: 0, unmapped: 0 };

  let checked = 0;
  let missingPrices = 0;
  let unmapped = 0;
  const guard = () => ({
    sql: "EXISTS (SELECT 1 FROM deal_refresh_state WHERE country=? AND lock_token=? AND lock_expires_at>?)",
    args: [DEAL_COUNTRY, token, now()] as InValue[],
  });
  const renew = async () => {
    const result = await client.execute({
      sql: "UPDATE deal_refresh_state SET lock_expires_at=?, games_checked=? WHERE country=? AND lock_token=? AND lock_expires_at>?",
      args: [now() + LEASE_SECONDS, checked, DEAL_COUNTRY, token, now()],
    });
    if (result.rowsAffected !== 1) throw new Error("Offer refresh lease expired or was replaced");
  };

  try {
    const { rows } = await client.execute({
      sql: `SELECT g.steam_app_id, m.itad_id, m.checked_at FROM games g
        LEFT JOIN itad_game_map m ON m.steam_app_id=g.steam_app_id
        WHERE g.value_score IS NOT NULL AND g.is_endless=0
        ORDER BY g.value_score DESC, g.steam_app_id LIMIT ?`,
      args: [options.limit ?? -1],
    });
    options.onProgress?.(`Loading active US bundles for ${rows.length} ranked games`);
    const bundles = await source.bundles(DEAL_COUNTRY);
    await renew();

    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const batch = rows.slice(offset, offset + BATCH_SIZE);
      const lookupIds = batch.filter((row) => row.checked_at === null || Number(row.checked_at) <= now() - MAPPING_MAX_AGE)
        .map((row) => Number(row.steam_app_id));
      const mappings = lookupIds.length ? await source.lookup(lookupIds) : new Map<number, string | null>();
      await renew();
      const mappingWrites: { sql: string; args: InValue[] }[] = [];
      for (const row of batch) {
        const appId = Number(row.steam_app_id);
        if (lookupIds.includes(appId) && !mappings.has(appId)) throw new Error("Incomplete ITAD mapping batch");
        if (!mappings.has(appId)) mappings.set(appId, row.itad_id === null ? null : String(row.itad_id));
        else {
          const g = guard();
          const id = mappings.get(appId)!;
          if (id !== row.itad_id) mappingWrites.push({
            sql: `DELETE FROM game_deal_cache WHERE steam_app_id=? AND ${g.sql}`, args: [appId, ...g.args],
          });
          mappingWrites.push({
            sql: `INSERT INTO itad_game_map (steam_app_id, itad_id, checked_at)
              SELECT ?, ?, ? WHERE ${g.sql}
              ON CONFLICT(steam_app_id) DO UPDATE SET itad_id=excluded.itad_id, checked_at=excluded.checked_at`,
            args: [appId, id, now(), ...g.args],
          });
        }
      }
      if (mappingWrites.length) await client.batch(mappingWrites, "write");
      const ids = [...new Set([...mappings.values()].filter((id): id is string => id !== null))];
      const priceFetchedAt = now();
      const prices = ids.length ? await source.prices(ids, DEAL_COUNTRY) : new Map<string, DealOffer[]>();
      await renew();
      const writes: { sql: string; args: InValue[] }[] = [];
      const save = (appId: number, kind: string, fetchedAt: number, offers: DealOffer[]) => {
        const g = guard();
        writes.push({
          sql: `INSERT INTO game_deal_cache (steam_app_id, country, kind, checked_at, offers_json)
            SELECT ?, ?, ?, ?, ? WHERE ${g.sql}
            ON CONFLICT(steam_app_id,country,kind) DO UPDATE SET checked_at=excluded.checked_at, offers_json=excluded.offers_json`,
          args: [appId, DEAL_COUNTRY, kind, fetchedAt, JSON.stringify(offers), ...g.args],
        });
      };
      for (const row of batch) {
        const appId = Number(row.steam_app_id);
        const id = mappings.get(appId)!;
        if (id === null) { unmapped++; continue; }
        const offers = prices.get(id);
        if (offers === undefined) missingPrices++;
        else save(appId, "retail", priceFetchedAt, offers);
        save(appId, "bundle", bundles.fetchedAt, bundles.games.get(id) ?? []);
      }
      if (writes.length) {
        const results = await client.batch(writes, "write");
        if (results.some((result) => result.rowsAffected !== 1)) throw new Error("Offer refresh lost publication lease");
      }
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
    if (result.rowsAffected !== 1) throw new Error("Offer refresh lost completion lease");
    return { skipped: false, gamesChecked: checked, missingPrices, unmapped };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Offer refresh failed";
    await client.execute({
      sql: "UPDATE deal_refresh_state SET last_error=?, games_checked=?, lock_token=NULL, lock_expires_at=NULL WHERE country=? AND lock_token=?",
      args: [message, checked, DEAL_COUNTRY, token],
    });
    throw error;
  }
}
