#!/usr/bin/env bun
import { DB_LIMITS, DbError, toDbError, type DbClient, type DbStatement } from "../src/db/access";
import { createExternalClient } from "../src/db/http";

const STATE_KEY = "steam_official_catalog";
const DEFAULT_MIN_REVIEWS = 10;
const DEFAULT_APP_LIST_PAGE_SIZE = 50_000;
const DEFAULT_APP_LIST_DELAY_MS = 1000;
const DEFAULT_REVIEW_DELAY_MS = 500;
const DEFAULT_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 5000;
const DEFAULT_REVIEW_TIMEOUT_MS = 20_000;
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_CHECKPOINT_EVERY = 50;
const CATALOG_READ_PAGE_SIZE = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SteamAppListEntry {
  appid: number;
  name: string;
  last_modified?: number;
}

export interface RefreshOptions {
  minReviews: number;
  appListPageSize: number;
  appListDelayMs: number;
  reviewDelayMs: number;
  retries: number;
  retryDelayMs: number;
  reviewTimeoutMs: number;
  batchSize: number;
  checkpointEvery: number;
  dryRun: boolean;
  restart: boolean;
  limitApps?: number;
  startAfterAppId?: number;
}

interface ExistingCatalogRow extends CatalogRow {}

interface CatalogRow {
  steamAppId: number;
  name: string;
  steamReviewScore: number | null;
  steamReviewCount: number;
}

interface CatalogChange {
  kind: "insert" | "update";
  row: CatalogRow;
}

interface SteamReviewSummary {
  totalPositive: number;
  totalNegative: number;
  totalReviews: number;
}

export interface SteamCatalogProvider {
  fetchAppList(options: RefreshOptions, startAfterAppId: number): Promise<SteamAppListEntry[]>;
  fetchReviewSummary(app: SteamAppListEntry, options: RefreshOptions): Promise<SteamReviewSummary>;
}

export interface RefreshDependencies {
  client: DbClient;
  provider: SteamCatalogProvider;
}

type SteamFetch = (url: URL, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

class SteamProviderError extends Error {}

export function createSteamCatalogProvider(apiKey: string, send: SteamFetch = (url, init) => fetch(url, init)): SteamCatalogProvider {
  return {
    fetchAppList: (options, startAfterAppId) => fetchSteamAppList(apiKey, options, startAfterAppId, send),
    fetchReviewSummary: (app, options) => fetchReviewSummary(app, options, send),
  };
}

interface RunCounters {
  processed: number;
  inserted: number;
  updated: number;
  skippedBelowThreshold: number;
  skippedNoReviews: number;
  unchanged: number;
  failed: number;
}

export function parseArgs(argv = process.argv.slice(2)): RefreshOptions {
  const options: RefreshOptions = {
    minReviews: DEFAULT_MIN_REVIEWS,
    appListPageSize: DEFAULT_APP_LIST_PAGE_SIZE,
    appListDelayMs: DEFAULT_APP_LIST_DELAY_MS,
    reviewDelayMs: DEFAULT_REVIEW_DELAY_MS,
    retries: DEFAULT_RETRIES,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
    reviewTimeoutMs: DEFAULT_REVIEW_TIMEOUT_MS,
    batchSize: DEFAULT_BATCH_SIZE,
    checkpointEvery: DEFAULT_CHECKPOINT_EVERY,
    dryRun: false,
    restart: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case "--min-reviews":
        options.minReviews = parseNonNegativeInt(readValue(argv, ++i, arg), arg);
        break;
      case "--app-list-page-size":
        options.appListPageSize = parsePositiveInt(readValue(argv, ++i, arg), arg);
        break;
      case "--app-list-delay-ms":
        options.appListDelayMs = parseNonNegativeInt(readValue(argv, ++i, arg), arg);
        break;
      case "--review-delay-ms":
        options.reviewDelayMs = parseNonNegativeInt(readValue(argv, ++i, arg), arg);
        break;
      case "--retries":
        options.retries = parseNonNegativeInt(readValue(argv, ++i, arg), arg);
        break;
      case "--retry-delay-ms":
        options.retryDelayMs = parseNonNegativeInt(readValue(argv, ++i, arg), arg);
        break;
      case "--review-timeout-ms":
        options.reviewTimeoutMs = parsePositiveInt(readValue(argv, ++i, arg), arg);
        break;
      case "--batch-size":
        options.batchSize = parsePositiveInt(readValue(argv, ++i, arg), arg);
        if (options.batchSize > DB_LIMITS.maxStatements) {
          throw new Error(`--batch-size must be at most ${DB_LIMITS.maxStatements}`);
        }
        break;
      case "--checkpoint-every":
        options.checkpointEvery = parsePositiveInt(readValue(argv, ++i, arg), arg);
        break;
      case "--limit-apps":
        options.limitApps = parsePositiveInt(readValue(argv, ++i, arg), arg);
        break;
      case "--start-after-app-id":
        options.startAfterAppId = parseNonNegativeInt(readValue(argv, ++i, arg), arg);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--restart":
        options.restart = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseNonNegativeInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative safe integer`);
  }
  return parsed;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = parseNonNegativeInt(value, flag);
  if (parsed === 0) {
    throw new Error(`${flag} must be greater than 0`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Refresh Steam catalog and ratings from official Steam endpoints.

Usage:
  bun scripts/refresh-steam-catalog.ts [options]

Options:
  --min-reviews N          Minimum reviews required for new rows (default: ${DEFAULT_MIN_REVIEWS})
  --limit-apps N           Process only N apps, useful for verification/test runs
  --start-after-app-id N   Start after a specific Steam app ID
  --restart                Ignore prior checkpoint and start a fresh full run
  --dry-run                Fetch and compare, but do not write or checkpoint
  --review-delay-ms N      Delay between appreviews requests (default: ${DEFAULT_REVIEW_DELAY_MS})
  --retries N              Retry count for transient Steam failures (default: ${DEFAULT_RETRIES})
  --retry-delay-ms N       Base retry delay (default: ${DEFAULT_RETRY_DELAY_MS})
  --review-timeout-ms N    Per-review request timeout (default: ${DEFAULT_REVIEW_TIMEOUT_MS})
  --batch-size N           Atomic D1 write batch size, at most ${DB_LIMITS.maxStatements} (default: ${DEFAULT_BATCH_SIZE})
  --checkpoint-every N     Processed apps between checkpoints (default: ${DEFAULT_CHECKPOINT_EVERY})
  -h, --help               Show this help
`);
}

async function resolveStartAfterAppId(client: DbClient, options: RefreshOptions): Promise<number> {
  if (options.dryRun || options.restart) return options.startAfterAppId ?? 0;
  if (options.startAfterAppId !== undefined) return options.startAfterAppId;

  const result = await client.execute({
    sql: "SELECT last_app_id, completed_at FROM catalog_refresh_state WHERE key = ?",
    args: [STATE_KEY],
  });

  const row = result.rows[0];
  if (!row || row.completed_at !== null) return 0;

  return Number(row.last_app_id ?? 0);
}

async function initializeState(client: DbClient, options: RefreshOptions, startAfterAppId: number): Promise<void> {
  if (options.dryRun) return;

  const now = unixNow();
  await client.execute({
    sql: `INSERT INTO catalog_refresh_state (
        key,
        last_app_id,
        started_at,
        completed_at,
        min_reviews,
        apps_seen,
        processed_count,
        inserted_count,
        updated_count,
        skipped_count,
        unchanged_count,
        failed_count,
        last_error,
        updated_at
      ) VALUES (?, ?, ?, NULL, ?, 0, 0, 0, 0, 0, 0, 0, NULL, ?)
      ON CONFLICT(key) DO UPDATE SET
        last_app_id = ?,
        started_at = CASE WHEN catalog_refresh_state.completed_at IS NULL AND ? > 0 THEN catalog_refresh_state.started_at ELSE excluded.started_at END,
        completed_at = NULL,
        min_reviews = excluded.min_reviews,
        last_error = NULL,
        updated_at = excluded.updated_at,
        apps_seen = CASE WHEN ? > 0 THEN catalog_refresh_state.apps_seen ELSE 0 END,
        processed_count = CASE WHEN ? > 0 THEN catalog_refresh_state.processed_count ELSE 0 END,
        inserted_count = CASE WHEN ? > 0 THEN catalog_refresh_state.inserted_count ELSE 0 END,
        updated_count = CASE WHEN ? > 0 THEN catalog_refresh_state.updated_count ELSE 0 END,
        skipped_count = CASE WHEN ? > 0 THEN catalog_refresh_state.skipped_count ELSE 0 END,
        unchanged_count = CASE WHEN ? > 0 THEN catalog_refresh_state.unchanged_count ELSE 0 END,
        failed_count = CASE WHEN ? > 0 THEN catalog_refresh_state.failed_count ELSE 0 END`,
    args: [
      STATE_KEY,
      startAfterAppId,
      now,
      options.minReviews,
      now,
      startAfterAppId,
      startAfterAppId,
      startAfterAppId,
      startAfterAppId,
      startAfterAppId,
      startAfterAppId,
      startAfterAppId,
      startAfterAppId,
      startAfterAppId,
    ],
  });
}

async function fetchSteamAppList(
  apiKey: string,
  options: RefreshOptions,
  startAfterAppId: number,
  send: SteamFetch
): Promise<SteamAppListEntry[]> {
  const apps: SteamAppListEntry[] = [];
  let lastAppId = startAfterAppId;

  while (true) {
    const url = new URL("https://api.steampowered.com/IStoreService/GetAppList/v1/");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("include_games", "true");
    url.searchParams.set("max_results", String(options.appListPageSize));
    if (lastAppId > 0) url.searchParams.set("last_appid", String(lastAppId));

    const page = await fetchJsonWithRetries<{
      response?: {
        apps?: unknown[];
        have_more_results?: boolean;
        last_appid?: number;
      };
    }>(url, options, "Steam app list", send);

    const entries = (page.response?.apps ?? []).filter(isSteamAppListEntry);
    apps.push(...entries);
    console.log(`  App list page after ${lastAppId}: ${entries.length} apps`);

    if (options.limitApps && apps.length >= options.limitApps) {
      return apps.slice(0, options.limitApps);
    }

    if (!page.response?.have_more_results || entries.length === 0) {
      return apps;
    }

    lastAppId = Number(page.response.last_appid ?? entries[entries.length - 1]?.appid ?? lastAppId);
    await sleep(options.appListDelayMs);
  }
}

function isSteamAppListEntry(value: unknown): value is SteamAppListEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.appid === "number" && typeof entry.name === "string" && entry.name.trim().length > 0;
}

async function fetchReviewSummary(app: SteamAppListEntry, options: RefreshOptions, send: SteamFetch): Promise<SteamReviewSummary> {
  const url = new URL(`https://store.steampowered.com/appreviews/${app.appid}`);
  url.searchParams.set("json", "1");
  url.searchParams.set("filter", "summary");
  url.searchParams.set("language", "all");
  url.searchParams.set("purchase_type", "all");
  url.searchParams.set("num_per_page", "0");

  const data = await fetchJsonWithRetries<{
    success?: number | boolean;
    query_summary?: {
      total_positive?: number;
      total_negative?: number;
      total_reviews?: number;
    };
  }>(url, options, `Steam reviews for ${app.appid}`, send);

  if (data.success !== 1 && data.success !== true) {
    return { totalPositive: 0, totalNegative: 0, totalReviews: 0 };
  }

  return {
    totalPositive: Math.max(0, Number(data.query_summary?.total_positive ?? 0)),
    totalNegative: Math.max(0, Number(data.query_summary?.total_negative ?? 0)),
    totalReviews: Math.max(0, Number(data.query_summary?.total_reviews ?? 0)),
  };
}

async function fetchJsonWithRetries<T>(
  url: URL,
  options: RefreshOptions,
  label: string,
  send: SteamFetch
): Promise<T> {
  let message = "request failed";

  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      const response = await send(url, {
        headers: { "User-Agent": "steam-value catalog refresh" },
        signal: AbortSignal.timeout(options.reviewTimeoutMs),
      });
      const text = await response.text();

      if (!response.ok) {
        throw new SteamProviderError(`HTTP ${response.status}`);
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new SteamProviderError("non-JSON response");
      }
    } catch (error) {
      message = error instanceof SteamProviderError ? error.message : "request failed";
      if (attempt === options.retries) break;

      const delayMs = options.retryDelayMs * (attempt + 1);
      console.warn(`    ${label} attempt ${attempt + 1} failed: ${message}`);
      console.warn(`    Retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  throw new SteamProviderError(`${label} failed after ${options.retries + 1} attempts: ${message}`);
}

async function loadExistingRows(client: DbClient): Promise<Map<number, ExistingCatalogRow>> {
  const rows = new Map<number, ExistingCatalogRow>();
  let afterAppId: number | undefined;
  while (true) {
    const result = await client.execute({
      sql: `SELECT steam_app_id, name, steam_review_score, steam_review_count FROM games
        ${afterAppId === undefined ? "" : "WHERE steam_app_id > ?"}
        ORDER BY steam_app_id LIMIT ?`,
      args: afterAppId === undefined ? [CATALOG_READ_PAGE_SIZE] : [afterAppId, CATALOG_READ_PAGE_SIZE],
    });
    for (const row of result.rows) {
      const steamAppId = Number(row.steam_app_id);
      rows.set(steamAppId, {
        steamAppId,
        name: String(row.name),
        steamReviewScore: row.steam_review_score === null ? null : Number(row.steam_review_score),
        steamReviewCount: Number(row.steam_review_count ?? 0),
      });
      afterAppId = steamAppId;
    }
    if (result.rows.length < CATALOG_READ_PAGE_SIZE) return rows;
  }
}

export function toCatalogRow(app: SteamAppListEntry, summary: SteamReviewSummary): CatalogRow {
  return {
    steamAppId: app.appid,
    name: app.name.trim(),
    steamReviewScore:
      summary.totalReviews > 0 ? Math.round((summary.totalPositive / summary.totalReviews) * 100) : null,
    steamReviewCount: summary.totalReviews,
  };
}

export function planCatalogChange(
  row: CatalogRow,
  existing: ExistingCatalogRow | undefined,
  minReviews: number
): CatalogChange | "unchanged" | "skip-below-threshold" | "skip-no-reviews" {
  if (!existing && row.steamReviewCount === 0) return "skip-no-reviews";
  if (!existing && row.steamReviewCount < minReviews) return "skip-below-threshold";

  if (!existing) {
    return { kind: "insert", row };
  }

  if (
    existing.name !== row.name ||
    existing.steamReviewScore !== row.steamReviewScore ||
    existing.steamReviewCount !== row.steamReviewCount
  ) {
    return { kind: "update", row };
  }

  return "unchanged";
}

function upsertStatement(change: CatalogChange): DbStatement {
  return {
    sql: `INSERT INTO games (
        steam_app_id,
        name,
        steam_review_score,
        steam_review_count,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
      ON CONFLICT(steam_app_id) DO UPDATE SET
        name = excluded.name,
        steam_review_score = excluded.steam_review_score,
        steam_review_count = excluded.steam_review_count,
        updated_at = unixepoch()`,
    args: [
      change.row.steamAppId,
      change.row.name,
      change.row.steamReviewScore,
      change.row.steamReviewCount,
    ],
  };
}

async function flushChanges(client: DbClient, changes: CatalogChange[], dryRun: boolean): Promise<void> {
  if (dryRun || changes.length === 0) return;
  await client.batch(changes.map(upsertStatement), "write");
}

async function checkpoint(
  client: DbClient,
  appId: number,
  appsSeen: number,
  counters: RunCounters,
  dryRun: boolean
): Promise<void> {
  if (dryRun) return;

  await client.execute({
    sql: `UPDATE catalog_refresh_state SET
      last_app_id = ?,
      apps_seen = ?,
      processed_count = ?,
      inserted_count = ?,
      updated_count = ?,
      skipped_count = ?,
      unchanged_count = ?,
      failed_count = ?,
      last_error = NULL,
      updated_at = unixepoch()
    WHERE key = ?`,
    args: [
      appId,
      appsSeen,
      counters.processed,
      counters.inserted,
      counters.updated,
      counters.skippedBelowThreshold + counters.skippedNoReviews,
      counters.unchanged,
      counters.failed,
      STATE_KEY,
    ],
  });
}

async function loadStateCounters(client: DbClient, dryRun: boolean): Promise<RunCounters> {
  const zero: RunCounters = {
    processed: 0,
    inserted: 0,
    updated: 0,
    skippedBelowThreshold: 0,
    skippedNoReviews: 0,
    unchanged: 0,
    failed: 0,
  };

  if (dryRun) return zero;

  const result = await client.execute({
    sql: `SELECT
      processed_count,
      inserted_count,
      updated_count,
      skipped_count,
      unchanged_count,
      failed_count
    FROM catalog_refresh_state WHERE key = ?`,
    args: [STATE_KEY],
  });

  const row = result.rows[0];
  if (!row) return zero;

  return {
    processed: Number(row.processed_count ?? 0),
    inserted: Number(row.inserted_count ?? 0),
    updated: Number(row.updated_count ?? 0),
    skippedBelowThreshold: Number(row.skipped_count ?? 0),
    skippedNoReviews: 0,
    unchanged: Number(row.unchanged_count ?? 0),
    failed: Number(row.failed_count ?? 0),
  };
}

async function markCompleted(client: DbClient, lastAppId: number, appsSeen: number, counters: RunCounters, dryRun: boolean): Promise<void> {
  if (dryRun) return;

  await client.execute({
    sql: `UPDATE catalog_refresh_state SET
      last_app_id = ?,
      completed_at = unixepoch(),
      apps_seen = ?,
      processed_count = ?,
      inserted_count = ?,
      updated_count = ?,
      skipped_count = ?,
      unchanged_count = ?,
      failed_count = ?,
      last_error = NULL,
      updated_at = unixepoch()
    WHERE key = ?`,
    args: [
      lastAppId,
      appsSeen,
      counters.processed,
      counters.inserted,
      counters.updated,
      counters.skippedBelowThreshold + counters.skippedNoReviews,
      counters.unchanged,
      counters.failed,
      STATE_KEY,
    ],
  });
}

async function recordFailure(client: DbClient, app: SteamAppListEntry, error: string, dryRun: boolean): Promise<void> {
  if (dryRun) return;

  await client.execute({
    sql: `INSERT INTO catalog_refresh_failures (steam_app_id, name, error, attempts, last_attempt_at)
      VALUES (?, ?, ?, 1, unixepoch())
      ON CONFLICT(steam_app_id) DO UPDATE SET
        name = excluded.name,
        error = excluded.error,
        attempts = catalog_refresh_failures.attempts + 1,
        last_attempt_at = unixepoch()`,
    args: [app.appid, app.name, error],
  });
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function officialSteamProvider(): SteamCatalogProvider {
  const apiKey = process.env.STEAM_API_KEY;
  if (!apiKey) throw new Error("Missing STEAM_API_KEY");
  return createSteamCatalogProvider(apiKey);
}

export async function main(argv = process.argv.slice(2), dependencies?: RefreshDependencies): Promise<void> {
  const options = parseArgs(argv);
  const provider = dependencies?.provider ?? officialSteamProvider();
  const client = dependencies?.client ?? createExternalClient(process.env);
  try {
    await refreshCatalog(client, provider, options);
  } catch (error) {
    const safe = error instanceof SteamProviderError ? error : toDbError(error);
    const knownFailure = safe instanceof SteamProviderError || (safe instanceof DbError && (safe.outcome === "not-applied" || safe.outcome === "rolled-back"));
    if (!options.dryRun && knownFailure) {
      await client.execute({
        sql: "UPDATE catalog_refresh_state SET last_error = ?, updated_at = unixepoch() WHERE key = ?",
        args: [safe.message, STATE_KEY],
      });
    }
    throw safe;
  } finally {
    client.close();
  }
}

async function refreshCatalog(client: DbClient, provider: SteamCatalogProvider, options: RefreshOptions): Promise<void> {
  const startAfterAppId = await resolveStartAfterAppId(client, options);
  await initializeState(client, options, startAfterAppId);

  console.log("Refreshing Steam catalog from official Steam endpoints...");
  console.log(`  Minimum reviews for new rows: ${options.minReviews}`);
  console.log(`  Dry run: ${options.dryRun ? "yes" : "no"}`);
  console.log(`  Starting after app ID: ${startAfterAppId}`);
  if (options.limitApps) console.log(`  Limit apps: ${options.limitApps}`);

  const [apps, existingRows] = await Promise.all([
    provider.fetchAppList(options, startAfterAppId),
    loadExistingRows(client),
  ]);

  const counters = await loadStateCounters(client, options.dryRun);
  const totalAppsForState = counters.processed + apps.length;
  const pendingChanges: CatalogChange[] = [];
  let lastProcessedAppId = startAfterAppId;

  console.log(`\nProcessing ${apps.length} apps...`);

  for (const app of apps) {
    try {
      const summary = await provider.fetchReviewSummary(app, options);
      const row = toCatalogRow(app, summary);
      const planned = planCatalogChange(row, existingRows.get(row.steamAppId), options.minReviews);

      if (planned === "unchanged") {
        counters.unchanged++;
      } else if (planned === "skip-below-threshold") {
        counters.skippedBelowThreshold++;
      } else if (planned === "skip-no-reviews") {
        counters.skippedNoReviews++;
      } else {
        pendingChanges.push(planned);
        if (planned.kind === "insert") counters.inserted++;
        else counters.updated++;
      }
    } catch (error) {
      counters.failed++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${app.appid} ${app.name}: ${message}`);
      await recordFailure(client, app, message, options.dryRun);
    }

    counters.processed++;
    lastProcessedAppId = app.appid;

    if (pendingChanges.length >= options.batchSize || counters.processed % options.checkpointEvery === 0) {
      await flushChanges(client, pendingChanges, options.dryRun);
      pendingChanges.length = 0;
      await checkpoint(client, lastProcessedAppId, totalAppsForState, counters, options.dryRun);
      console.log(
        `  Progress ${counters.processed}/${apps.length}: ${counters.inserted} inserts, ${counters.updated} updates, ${counters.unchanged} unchanged, ${counters.failed} failed`
      );
    }

    if (options.reviewDelayMs > 0) await sleep(options.reviewDelayMs);
  }

  await flushChanges(client, pendingChanges, options.dryRun);
  await markCompleted(client, lastProcessedAppId, totalAppsForState, counters, options.dryRun);

  console.log("\nDone!");
  console.log(`  Processed: ${counters.processed}`);
  console.log(`  Inserted: ${counters.inserted}`);
  console.log(`  Updated: ${counters.updated}`);
  console.log(`  Unchanged: ${counters.unchanged}`);
  console.log(`  Skipped below threshold: ${counters.skippedBelowThreshold}`);
  console.log(`  Skipped with no reviews: ${counters.skippedNoReviews}`);
  console.log(`  Failed: ${counters.failed}`);

  if (!options.dryRun && (counters.inserted > 0 || counters.updated > 0)) {
    console.log("\nNext: run `bun recalc` to refresh value scores after review changes.");
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
