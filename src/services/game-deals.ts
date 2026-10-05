import type { Client, InValue } from "@libsql/client/web";
import { DEAL_COUNTRY, DEAL_MAX_AGE_SECONDS, type DealOffer, type DealRefreshStatus, type GameDeals } from "./deal-types";

export { DEAL_COUNTRY, DEAL_MAX_AGE_SECONDS } from "./deal-types";
export type { DealOffer, DealRefreshStatus, GameDeals } from "./deal-types";

export async function ensureDealTables(client: Client): Promise<void> {
  await client.batch([
    `CREATE TABLE IF NOT EXISTS itad_game_map (
      steam_app_id INTEGER PRIMARY KEY, itad_id TEXT, checked_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS game_deal_cache (
      steam_app_id INTEGER NOT NULL, country TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('retail','bundle')),
      checked_at INTEGER NOT NULL, offers_json TEXT NOT NULL CHECK(json_valid(offers_json)),
      PRIMARY KEY(steam_app_id, country, kind)
    )`,
    `CREATE TABLE IF NOT EXISTS deal_refresh_state (
      country TEXT PRIMARY KEY, last_attempt_at INTEGER, last_success_at INTEGER, last_error TEXT,
      lock_token TEXT, lock_expires_at INTEGER, games_checked INTEGER NOT NULL DEFAULT 0
    )`,
  ], "write");
}

export const ON_SALE_SQL = `EXISTS (
  SELECT 1 FROM game_deal_cache dc, json_each(dc.offers_json) offer
  WHERE dc.steam_app_id = games.steam_app_id AND dc.country = ?
    AND dc.checked_at > ? AND json_extract(offer.value, '$.validUntil') > ?
)`;

export function onSaleArgs(now: number): InValue[] {
  return [DEAL_COUNTRY, now - DEAL_MAX_AGE_SECONDS, now];
}

export async function getGameDeals(client: Client, appIds: number[], now = unixNow()): Promise<Map<number, GameDeals>> {
  const result = new Map<number, GameDeals>(appIds.map((id) => [id, { status: "unknown", checkedAt: null, offers: [] }]));
  if (!appIds.length) return result;
  const placeholders = appIds.map(() => "?").join(",");
  const [mapped, cached] = await client.batch([
    { sql: `SELECT * FROM itad_game_map WHERE steam_app_id IN (${placeholders})`, args: appIds },
    { sql: `SELECT * FROM game_deal_cache WHERE country = ? AND steam_app_id IN (${placeholders})`, args: [DEAL_COUNTRY, ...appIds] },
  ], "read");
  for (const row of mapped!.rows) {
    if (row.itad_id === null) result.set(Number(row.steam_app_id), { status: "unmapped", checkedAt: Number(row.checked_at), offers: [] });
  }
  const scopes = new Map<number, { checkedAt: number; fresh: boolean; offers: DealOffer[] }[]>();
  for (const row of cached!.rows) {
    const checkedAt = Number(row.checked_at);
    const fresh = checkedAt > now - DEAL_MAX_AGE_SECONDS;
    const offers = JSON.parse(String(row.offers_json)) as DealOffer[];
    const id = Number(row.steam_app_id);
    const entries = scopes.get(id) ?? [];
    entries.push({ checkedAt, fresh, offers: fresh ? offers.filter((offer) => offer.validUntil > now) : [] });
    scopes.set(id, entries);
  }
  for (const [id, entries] of scopes) {
    const freshCount = entries.filter((entry) => entry.fresh).length;
    result.set(id, {
      status: freshCount === 2 ? "fresh" : freshCount > 0 ? "partial" : "stale",
      checkedAt: Math.min(...entries.map((entry) => entry.checkedAt)),
      offers: entries.flatMap((entry) => entry.offers).sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "retail" ? -1 : 1;
        return (a.priceCents ?? Infinity) - (b.priceCents ?? Infinity) || a.id.localeCompare(b.id);
      }),
    });
  }
  return result;
}

export async function getDealRefreshStatus(client: Client, now = unixNow()): Promise<DealRefreshStatus> {
  const result = await client.execute({ sql: "SELECT * FROM deal_refresh_state WHERE country = ?", args: [DEAL_COUNTRY] });
  const row = result.rows[0];
  const counts = await client.execute({
    sql: `SELECT COUNT(*) AS total,
      SUM((SELECT COUNT(*) FROM game_deal_cache dc WHERE dc.steam_app_id = games.steam_app_id
        AND dc.country = ? AND dc.checked_at > ?) = 2) AS fresh
      FROM games WHERE value_score IS NOT NULL AND is_endless = 0`,
    args: [DEAL_COUNTRY, now - DEAL_MAX_AGE_SECONDS],
  });
  return {
    country: DEAL_COUNTRY, currency: "USD", maxAgeSeconds: DEAL_MAX_AGE_SECONDS,
    lastAttemptAt: nullableNumber(row?.last_attempt_at), lastSuccessAt: nullableNumber(row?.last_success_at),
    lastError: row?.last_error == null ? null : String(row.last_error),
    isRunning: row?.lock_token != null && Number(row.lock_expires_at) > now,
    gamesChecked: Number(row?.games_checked ?? 0), totalGames: Number(counts.rows[0]?.total ?? 0),
    freshGames: Number(counts.rows[0]?.fresh ?? 0),
  };
}

function nullableNumber(value: unknown): number | null { return value == null ? null : Number(value); }
export function unixNow(): number { return Math.floor(Date.now() / 1000); }
