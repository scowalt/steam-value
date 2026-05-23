import type { Client, InValue } from "@libsql/client/web";

export interface GameDto {
  id: number;
  steamAppId: number;
  name: string;
  steamReviewScore: number | null;
  steamReviewCount: number | null;
  hltbId: number | null;
  hltbMain: number | null;
  hltbMainExtra: number | null;
  hltbCompletionist: number | null;
  valueScore: number | null;
  isEndless: boolean;
  isOnWishlist: boolean;
  isEarlyAccess: boolean;
  controllerSupport: string | null;
  releaseDate: string | null;
  isOwned: boolean;
  playtimeMinutes: number | null;
  isIgnored: boolean;
  hasSinglePlayer: boolean;
  hasMultiplayer: boolean;
  hasCoOp: boolean;
  hasOnlineCoOp: boolean;
  hasLocalCoOp: boolean;
  hasPvP: boolean;
  hasOnlinePvP: boolean;
  hasLocalPvP: boolean;
  hasCrossplatform: boolean;
  isMMO: boolean;
  tags: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface CityBuilderGameDto {
  steam_app_id: number;
  name: string;
  steam_review_score: number | null;
  steam_review_count: number | null;
  hltb_main: number | null;
  controller_support: string | null;
  playtime_minutes: number | null;
  value_score: number | null;
  tag_rank: number;
  weighted_score: number | null;
}

export interface GameQueryParams {
  limit: number;
  offset: number;
  hideEa: boolean;
  hidePlayed: boolean;
  hideMMO: boolean;
  hideIgnored: boolean;
  singleOnly: boolean;
  coop: string;
  controller: string;
}

export function parseGameQuery(url: URL): GameQueryParams {
  return {
    limit: clampInteger(url.searchParams.get("limit"), 100, 1, 500),
    offset: clampInteger(url.searchParams.get("offset"), 0, 0, 100_000),
    hideEa: url.searchParams.get("hideEa") === "true",
    hidePlayed: url.searchParams.get("hidePlayed") === "true",
    hideMMO: url.searchParams.get("hideMMO") === "true",
    hideIgnored: url.searchParams.get("hideIgnored") === "true",
    singleOnly: url.searchParams.get("singleOnly") === "true",
    coop: url.searchParams.get("coop") ?? "any",
    controller: url.searchParams.get("controller") ?? "any",
  };
}

export async function listGames(client: Client, params: GameQueryParams): Promise<GameDto[]> {
  const conditions = ["value_score IS NOT NULL", "is_endless = 0"];
  const args: InValue[] = [];

  if (params.hideEa) conditions.push("is_early_access = 0");
  if (params.hidePlayed) conditions.push("(playtime_minutes = 0 OR playtime_minutes IS NULL)");
  if (params.hideMMO) conditions.push("is_mmo = 0");
  if (params.hideIgnored) conditions.push("is_ignored = 0");

  if (params.singleOnly) {
    conditions.push("has_single_player = 1");
    conditions.push("has_multiplayer = 0");
  }

  if (params.coop === "has-coop") {
    conditions.push("(has_co_op = 1 OR has_online_co_op = 1 OR has_local_co_op = 1)");
  } else if (params.coop === "online-coop") {
    conditions.push("has_online_co_op = 1");
  } else if (params.coop === "local-coop") {
    conditions.push("has_local_co_op = 1");
  }

  if (params.controller === "full") {
    conditions.push("controller_support = 'full'");
  } else if (params.controller === "partial") {
    conditions.push("controller_support IN ('full', 'partial')");
  }

  args.push(params.limit, params.offset);

  const result = await client.execute({
    sql: `
      SELECT
        id,
        steam_app_id,
        name,
        steam_review_score,
        steam_review_count,
        hltb_id,
        hltb_main,
        hltb_main_extra,
        hltb_completionist,
        value_score,
        is_endless,
        is_on_wishlist,
        is_early_access,
        controller_support,
        release_date,
        is_owned,
        playtime_minutes,
        is_ignored,
        has_single_player,
        has_multiplayer,
        has_co_op,
        has_online_co_op,
        has_local_co_op,
        has_pvp,
        has_online_pvp,
        has_local_pvp,
        has_crossplatform,
        is_mmo,
        tags,
        created_at,
        updated_at
      FROM games
      WHERE ${conditions.join(" AND ")}
      ORDER BY value_score DESC
      LIMIT ? OFFSET ?
    `,
    args,
  });

  return result.rows.map(mapGameRow);
}

export async function listCityBuilderGames(client: Client): Promise<CityBuilderGameDto[]> {
  const result = await client.execute(`
    SELECT
      steam_app_id,
      name,
      steam_review_score,
      steam_review_count,
      hltb_main,
      controller_support,
      playtime_minutes,
      value_score,
      tags
    FROM games
    WHERE tags LIKE '%City Builder%'
      AND controller_support IN ('full', 'partial')
      AND is_ignored = 0
      AND (playtime_minutes IS NULL OR playtime_minutes <= 60)
  `);

  const games = result.rows.map((row) => {
    const tagRank = getCityBuilderTagRank(row.tags);
    const tagMultiplier = 1.0 - (tagRank - 1) * (0.75 / 19);
    const valueScore = nullableNumber(row.value_score);

    return {
      steam_app_id: Number(row.steam_app_id),
      name: String(row.name),
      steam_review_score: nullableNumber(row.steam_review_score),
      steam_review_count: nullableNumber(row.steam_review_count),
      hltb_main: nullableNumber(row.hltb_main),
      controller_support: row.controller_support == null ? null : String(row.controller_support),
      playtime_minutes: nullableNumber(row.playtime_minutes),
      value_score: valueScore,
      tag_rank: tagRank,
      weighted_score: valueScore == null ? null : Math.round(valueScore * tagMultiplier),
    };
  });

  games.sort((a, b) => {
    if (a.weighted_score == null && b.weighted_score == null) return 0;
    if (a.weighted_score == null) return 1;
    if (b.weighted_score == null) return -1;
    return b.weighted_score - a.weighted_score;
  });

  return games;
}

function mapGameRow(row: Record<string, unknown>): GameDto {
  return {
    id: Number(row.id),
    steamAppId: Number(row.steam_app_id),
    name: String(row.name),
    steamReviewScore: nullableNumber(row.steam_review_score),
    steamReviewCount: nullableNumber(row.steam_review_count),
    hltbId: nullableNumber(row.hltb_id),
    hltbMain: nullableNumber(row.hltb_main),
    hltbMainExtra: nullableNumber(row.hltb_main_extra),
    hltbCompletionist: nullableNumber(row.hltb_completionist),
    valueScore: nullableNumber(row.value_score),
    isEndless: toBoolean(row.is_endless),
    isOnWishlist: toBoolean(row.is_on_wishlist),
    isEarlyAccess: toBoolean(row.is_early_access),
    controllerSupport: row.controller_support == null ? null : String(row.controller_support),
    releaseDate: row.release_date == null ? null : String(row.release_date),
    isOwned: toBoolean(row.is_owned),
    playtimeMinutes: nullableNumber(row.playtime_minutes),
    isIgnored: toBoolean(row.is_ignored),
    hasSinglePlayer: toBoolean(row.has_single_player),
    hasMultiplayer: toBoolean(row.has_multiplayer),
    hasCoOp: toBoolean(row.has_co_op),
    hasOnlineCoOp: toBoolean(row.has_online_co_op),
    hasLocalCoOp: toBoolean(row.has_local_co_op),
    hasPvP: toBoolean(row.has_pvp),
    hasOnlinePvP: toBoolean(row.has_online_pvp),
    hasLocalPvP: toBoolean(row.has_local_pvp),
    hasCrossplatform: toBoolean(row.has_crossplatform),
    isMMO: toBoolean(row.is_mmo),
    tags: row.tags == null ? null : String(row.tags),
    createdAt: nullableNumber(row.created_at),
    updatedAt: nullableNumber(row.updated_at),
  };
}

function getCityBuilderTagRank(value: unknown): number {
  if (typeof value !== "string") return 20;

  try {
    const tags = JSON.parse(value) as unknown;
    if (!Array.isArray(tags)) return 20;

    const index = tags.findIndex(
      (tag) => typeof tag === "string" && tag.toLowerCase().includes("city builder")
    );

    return index >= 0 ? index + 1 : 20;
  } catch {
    return 20;
  }
}

function clampInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}
