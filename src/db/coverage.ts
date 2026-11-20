import { DbError, type DbClient } from "./access";
import { dbOperation } from "./manual";

const nonEndless = "COALESCE(is_endless, 0) = 0";
const gameModeColumns = [
  "has_single_player", "has_multiplayer", "has_co_op", "has_online_co_op", "has_local_co_op",
  "has_pvp", "has_online_pvp", "has_local_pvp", "has_crossplatform", "is_mmo",
];
const hasGameModes = gameModeColumns.map((column) => `COALESCE(${column}, 0) = 1`).join(" OR ");
const missingTags = "tags IS NULL";
const missingReleaseDate = "(release_date IS NULL OR release_date = '')";
const missingControllerSupport = "controller_support IS NULL";
const missingGameModes = `NOT (${hasGameModes})`;
const missingReviews = "(steam_review_score IS NULL OR steam_review_count IS NULL)";

const fields = [
  { key: "reviewScore", label: "Review score", sql: "steam_review_score IS NOT NULL" },
  { key: "reviewCount", label: "Review count", sql: "steam_review_count IS NOT NULL" },
  { key: "tags", label: "Tags", sql: `NOT (${missingTags})` },
  { key: "releaseDate", label: "Release date", sql: `NOT ${missingReleaseDate}` },
  { key: "controllerSupport", label: "Controller support", sql: `NOT (${missingControllerSupport})` },
  { key: "gameModes", label: "Game modes", sql: hasGameModes },
  { key: "hltbId", label: "HowLongToBeat ID", sql: "hltb_id IS NOT NULL" },
  { key: "hltbMain", label: "HowLongToBeat main time", sql: "hltb_main IS NOT NULL" },
  { key: "valueScore", label: "Value Score", sql: "value_score IS NOT NULL" },
  { key: "owned", label: "Owned", sql: "COALESCE(is_owned, 0) = 1" },
  { key: "wishlist", label: "Wishlist", sql: "COALESCE(is_on_wishlist, 0) = 1" },
  { key: "ignored", label: "Ignored", sql: "COALESCE(is_ignored, 0) = 1" },
] as const;

const blockers = [
  { key: "missingReviews", label: "Missing reviews", sql: missingReviews },
  { key: "missingCatalogFacts", label: "Missing Catalog Facts", sql: `(${missingTags} OR ${missingReleaseDate} OR ${missingControllerSupport} OR ${missingGameModes})` },
  { key: "missingHltbNonEndless", label: "Missing HowLongToBeat Estimate (non-endless)", sql: `${nonEndless} AND hltb_main IS NULL` },
  { key: "missingValueScoreNonEndless", label: "Missing Value Score (non-endless)", sql: `${nonEndless} AND value_score IS NULL` },
] as const;

const buckets = [
  { key: "reviewsMissing", label: "Reviews missing", action: "scripts/refresh-steam-catalog.ts", sql: missingReviews },
  { key: "hltbPending", label: "HowLongToBeat pending", action: "scripts/hydrate-hltb.ts", sql: `${nonEndless} AND hltb_id IS NULL` },
  { key: "hltbMainMissing", label: "HowLongToBeat mapped without main time", action: "manual review", sql: `${nonEndless} AND hltb_id IS NOT NULL AND hltb_main IS NULL` },
  { key: "tagsMissing", label: "Catalog Facts missing tags", action: "scripts/hydrate-tags.ts", sql: missingTags },
  { key: "releaseDateMissing", label: "Catalog Facts missing release date", action: "scripts/hydrate-release-dates.ts", sql: missingReleaseDate },
  { key: "controllerSupportMissing", label: "Catalog Facts missing controller support", action: "scripts/hydrate-controller.ts", sql: missingControllerSupport },
  { key: "gameModesMissing", label: "Catalog Facts missing game modes", action: "scripts/hydrate-game-modes.ts", sql: missingGameModes },
  { key: "valueScorePending", label: "Value Score pending recalculation", action: "scripts/recalculate.ts", sql: `${nonEndless} AND steam_review_score IS NOT NULL AND hltb_main IS NOT NULL AND value_score IS NULL` },
] as const;

const counted = [...fields, ...blockers, ...buckets];
const coverageSql = `SELECT COUNT(*) AS total, COUNT(CASE WHEN NOT (${nonEndless}) THEN 1 END) AS endless, ${counted.map(({ key, sql }) => `COUNT(CASE WHEN ${sql} THEN 1 END) AS ${key}`).join(", ")} FROM games`;

export interface CoverageCount { key: string; label: string; count: number }
export interface CoverageBucket extends CoverageCount { action: string }
export interface CoverageReport {
  total: number;
  endless: number;
  coverage: CoverageCount[];
  blockers: CoverageCount[];
  nextBuckets: CoverageBucket[];
}

export async function readCoverage(client: DbClient): Promise<CoverageReport> {
  const row = (await dbOperation(() => client.execute(coverageSql))).rows[0];
  const count = (key: string) => {
    const value = row?.[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new DbError("PROTOCOL_ERROR", "not-applied");
    return value;
  };
  return {
    total: count("total"),
    endless: count("endless"),
    coverage: fields.map(({ key, label }) => ({ key, label, count: count(key) })),
    blockers: blockers.map(({ key, label }) => ({ key, label, count: count(key) })),
    nextBuckets: buckets.map(({ key, label, action }) => ({ key, label, action, count: count(key) }))
      .filter((bucket) => bucket.count > 0)
      .sort((a, b) => b.count - a.count),
  };
}

export function formatCoverage(report: CoverageReport): string {
  const share = (count: number) => report.total === 0 ? "n/a" : `${(count / report.total * 100).toFixed(1)}%`;
  const line = (label: string, count: number) => `${label.padEnd(46)}${String(count).padStart(8)}${share(count).padStart(8)}`;
  return [
    "DATA COVERAGE",
    `Total games: ${report.total} (${report.endless} endless)`,
    "",
    `${"Coverage".padEnd(46)}${"Games".padStart(8)}${"Share".padStart(8)}`,
    ...report.coverage.map(({ label, count }) => line(label, count)),
    "",
    `${"Key blockers".padEnd(46)}${"Games".padStart(8)}${"Share".padStart(8)}`,
    ...report.blockers.map(({ label, count }) => line(label, count)),
    "",
    "Next buckets",
    ...(report.nextBuckets.length === 0 ? ["Nothing pending."] : report.nextBuckets.map(({ label, count, action }, index) => `${index + 1}. ${label}: ${count} (${action})`)),
  ].join("\n");
}
