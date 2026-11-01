import { DB_LIMITS, type DbClient, type DbStatement, type DbValue } from "../db/access";
import { activatesOnSteam } from "./deal-activation";
import { DEAL_COUNTRY, DEAL_MAX_AGE_SECONDS, type DealOffer, type DealRefreshStatus, type GameDeals } from "./deal-types";

export { DEAL_COUNTRY, DEAL_MAX_AGE_SECONDS } from "./deal-types";
export type { DealOffer, DealRefreshStatus, GameDeals } from "./deal-types";

export function onSaleSql(steamOnly = false): string {
  return `EXISTS (
    SELECT 1 FROM game_deal_cache dc, json_each(dc.offers_json) offer
    WHERE dc.steam_app_id = games.steam_app_id AND dc.country = ?
      AND dc.checked_at > ? AND json_extract(offer.value, '$.validUntil') > ?
      ${steamOnly ? `AND (
        (json_extract(offer.value, '$.kind') = 'retail' AND substr(json_extract(offer.value, '$.id'), 1, 8) = 'shop:61:')
        OR EXISTS (SELECT 1 FROM json_each(offer.value, '$.drm') drm WHERE drm.value = 'Steam')
      )` : ""}
  )`;
}

export function onSaleArgs(now: number): DbValue[] {
  return [DEAL_COUNTRY, now - DEAL_MAX_AGE_SECONDS, now];
}

export async function getGameDeals(client: DbClient, appIds: number[], now = unixNow(), steamOnly = false): Promise<Map<number, GameDeals>> {
  const result = new Map<number, GameDeals>(appIds.map((id) => [id, { status: "unknown", checkedAt: null, offers: [] }]));
  if (!appIds.length) return result;
  const statements: DbStatement[] = [];
  const chunkSize = DB_LIMITS.maxParams - 1;
  for (let offset = 0; offset < appIds.length; offset += chunkSize) {
    const ids = appIds.slice(offset, offset + chunkSize);
    const placeholders = ids.map(() => "?").join(",");
    statements.push(
      { sql: `SELECT * FROM itad_game_map WHERE steam_app_id IN (${placeholders})`, args: ids },
      { sql: `SELECT * FROM game_deal_cache WHERE country = ? AND steam_app_id IN (${placeholders})`, args: [DEAL_COUNTRY, ...ids] },
    );
  }
  const snapshots = await client.batch(statements, "read");
  const mapped = snapshots.filter((_, index) => index % 2 === 0).flatMap((snapshot) => snapshot.rows);
  const cached = snapshots.filter((_, index) => index % 2 === 1).flatMap((snapshot) => snapshot.rows);
  for (const row of mapped) {
    if (row.itad_id === null) result.set(Number(row.steam_app_id), { status: "unmapped", checkedAt: Number(row.checked_at), offers: [] });
  }
  const scopes = new Map<number, { checkedAt: number; fresh: boolean; offers: DealOffer[] }[]>();
  for (const row of cached) {
    const checkedAt = Number(row.checked_at);
    const fresh = checkedAt > now - DEAL_MAX_AGE_SECONDS;
    const offers = JSON.parse(String(row.offers_json)) as DealOffer[];
    const id = Number(row.steam_app_id);
    const entries = scopes.get(id) ?? [];
    entries.push({ checkedAt, fresh, offers: fresh ? offers.filter((offer) => offer.validUntil > now && (!steamOnly || activatesOnSteam(offer))) : [] });
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

export async function getDealRefreshStatus(client: DbClient, now = unixNow()): Promise<DealRefreshStatus> {
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
