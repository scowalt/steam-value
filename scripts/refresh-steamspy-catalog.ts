#!/usr/bin/env bun
/**
 * Refresh the Steam catalog from SteamSpy.
 *
 * Fetches all SteamSpy pages, filters by total review count, and upserts
 * catalog rows in Turso. Safe to run repeatedly.
 */
import { createClient, type Client } from "@libsql/client";

const DEFAULT_MIN_REVIEWS = 10;
const DEFAULT_PAGE_DELAY_MS = 1500;
const DEFAULT_PAGE_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 5000;
const DEFAULT_BATCH_SIZE = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SteamSpyAllEntry {
  appid: number;
  name: string;
  positive: number;
  negative: number;
}

export interface RefreshOptions {
  minReviews: number;
  pageDelayMs: number;
  pageRetries: number;
  retryDelayMs: number;
  batchSize: number;
  dryRun: boolean;
  limitPages?: number;
}

interface CatalogRow {
  steamAppId: number;
  name: string;
  steamReviewScore: number | null;
  steamReviewCount: number;
}

interface ExistingCatalogRow extends CatalogRow {}

interface CatalogChange {
  kind: "insert" | "update";
  row: CatalogRow;
}

interface ChangePlan {
  changes: CatalogChange[];
  unchanged: number;
  belowThreshold: number;
  invalid: number;
  candidates: number;
}

interface ApplyResult {
  inserted: number;
  updated: number;
  failed: number;
}

export function parseArgs(argv = process.argv.slice(2)): RefreshOptions {
  const options: RefreshOptions = {
    minReviews: DEFAULT_MIN_REVIEWS,
    pageDelayMs: DEFAULT_PAGE_DELAY_MS,
    pageRetries: DEFAULT_PAGE_RETRIES,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
    batchSize: DEFAULT_BATCH_SIZE,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case "--min-reviews":
        options.minReviews = parseNonNegativeInt(readValue(argv, ++i, arg), arg);
        break;
      case "--page-delay-ms":
        options.pageDelayMs = parseNonNegativeInt(readValue(argv, ++i, arg), arg);
        break;
      case "--page-retries":
        options.pageRetries = parseNonNegativeInt(readValue(argv, ++i, arg), arg);
        break;
      case "--retry-delay-ms":
        options.retryDelayMs = parseNonNegativeInt(readValue(argv, ++i, arg), arg);
        break;
      case "--batch-size":
        options.batchSize = parsePositiveInt(readValue(argv, ++i, arg), arg);
        break;
      case "--limit-pages":
        options.limitPages = parsePositiveInt(readValue(argv, ++i, arg), arg);
        break;
      case "--dry-run":
        options.dryRun = true;
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
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
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
  console.log(`Refresh Steam catalog from SteamSpy.

Usage:
  bun scripts/refresh-steamspy-catalog.ts [options]

Options:
  --min-reviews N     Minimum total Steam reviews to import/update (default: ${DEFAULT_MIN_REVIEWS})
  --page-delay-ms N   Delay between SteamSpy page requests (default: ${DEFAULT_PAGE_DELAY_MS})
  --page-retries N    Retry count for transient SteamSpy page failures (default: ${DEFAULT_PAGE_RETRIES})
  --retry-delay-ms N  Base delay between page retries (default: ${DEFAULT_RETRY_DELAY_MS})
  --batch-size N      Number of Turso writes per batch (default: ${DEFAULT_BATCH_SIZE})
  --limit-pages N     Fetch only the first N SteamSpy pages, useful for testing
  --dry-run           Fetch and compare, but do not write to Turso
  -h, --help          Show this help
`);
}

async function fetchSteamSpyPage(
  page: number,
  options: RefreshOptions
): Promise<SteamSpyAllEntry[]> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.pageRetries; attempt++) {
    try {
      const response = await fetch(`https://steamspy.com/api.php?request=all&page=${page}`, {
        headers: { "User-Agent": "steam-value catalog refresh" },
      });
      const text = await response.text();

      if (!response.ok) {
        throw new Error(`SteamSpy returned HTTP ${response.status}: ${text.slice(0, 120)}`);
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(`SteamSpy returned non-JSON response: ${text.slice(0, 120)}`);
      }

      return Object.values(data).filter(isSteamSpyAllEntry);
    } catch (error) {
      lastError = error;
      if (attempt === options.pageRetries) break;

      const delayMs = options.retryDelayMs * (attempt + 1);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`    Page ${page} attempt ${attempt + 1} failed: ${message}`);
      console.warn(`    Retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Failed to fetch SteamSpy page ${page}: ${message}`);
}

function isSteamSpyAllEntry(value: unknown): value is SteamSpyAllEntry {
  if (!value || typeof value !== "object") return false;

  const entry = value as Record<string, unknown>;
  return (
    typeof entry.appid === "number" &&
    typeof entry.name === "string" &&
    typeof entry.positive === "number" &&
    typeof entry.negative === "number"
  );
}

async function fetchAllPages(options: RefreshOptions): Promise<SteamSpyAllEntry[]> {
  const allEntries = new Map<number, SteamSpyAllEntry>();
  let page = 0;

  while (true) {
    if (options.limitPages && page >= options.limitPages) {
      break;
    }

    console.log(`  Fetching page ${page}...`);
    const entries = await fetchSteamSpyPage(page, options);

    if (entries.length === 0) {
      break;
    }

    let newCount = 0;
    for (const entry of entries) {
      if (!allEntries.has(entry.appid)) {
        allEntries.set(entry.appid, entry);
        newCount++;
      }
    }

    console.log(`    Got ${entries.length} entries (${newCount} new)`);

    if (entries.length < 1000) {
      break;
    }

    page++;
    if (options.limitPages && page >= options.limitPages) {
      break;
    }
    await sleep(options.pageDelayMs);
  }

  return Array.from(allEntries.values());
}

async function loadExistingRows(client: Client): Promise<Map<number, ExistingCatalogRow>> {
  const result = await client.execute(
    "SELECT steam_app_id, name, steam_review_score, steam_review_count FROM games"
  );

  const rows = new Map<number, ExistingCatalogRow>();
  for (const row of result.rows) {
    rows.set(Number(row.steam_app_id), {
      steamAppId: Number(row.steam_app_id),
      name: String(row.name),
      steamReviewScore: row.steam_review_score === null ? null : Number(row.steam_review_score),
      steamReviewCount: Number(row.steam_review_count ?? 0),
    });
  }

  return rows;
}

export function toCatalogRow(entry: SteamSpyAllEntry): CatalogRow | null {
  const steamAppId = entry.appid;
  const name = entry.name.trim();
  const positive = Math.max(0, entry.positive);
  const negative = Math.max(0, entry.negative);
  const steamReviewCount = positive + negative;

  if (!Number.isInteger(steamAppId) || steamAppId <= 0 || name.length === 0) {
    return null;
  }

  return {
    steamAppId,
    name,
    steamReviewScore: steamReviewCount > 0 ? Math.round((positive / steamReviewCount) * 100) : null,
    steamReviewCount,
  };
}

export function planCatalogChanges(
  entries: SteamSpyAllEntry[],
  existingRows: Map<number, ExistingCatalogRow>,
  minReviews: number
): ChangePlan {
  const changes: CatalogChange[] = [];
  let unchanged = 0;
  let belowThreshold = 0;
  let invalid = 0;
  let candidates = 0;

  for (const entry of entries) {
    const row = toCatalogRow(entry);
    if (!row) {
      invalid++;
      continue;
    }

    if (row.steamReviewCount < minReviews) {
      belowThreshold++;
      continue;
    }

    candidates++;
    const existing = existingRows.get(row.steamAppId);

    if (!existing) {
      changes.push({ kind: "insert", row });
      continue;
    }

    if (catalogRowChanged(existing, row)) {
      changes.push({ kind: "update", row });
    } else {
      unchanged++;
    }
  }

  return { changes, unchanged, belowThreshold, invalid, candidates };
}

function catalogRowChanged(existing: ExistingCatalogRow, next: CatalogRow): boolean {
  return (
    existing.name !== next.name ||
    existing.steamReviewScore !== next.steamReviewScore ||
    existing.steamReviewCount !== next.steamReviewCount
  );
}

function upsertStatement(change: CatalogChange) {
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

async function applyChanges(
  client: Client,
  changes: CatalogChange[],
  options: RefreshOptions
): Promise<ApplyResult> {
  const result: ApplyResult = { inserted: 0, updated: 0, failed: 0 };

  if (options.dryRun) {
    result.inserted = changes.filter((change) => change.kind === "insert").length;
    result.updated = changes.filter((change) => change.kind === "update").length;
    return result;
  }

  for (let i = 0; i < changes.length; i += options.batchSize) {
    const batch = changes.slice(i, i + options.batchSize);

    try {
      await client.batch(batch.map(upsertStatement), "write");
      addSuccessfulChanges(result, batch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Batch ${Math.floor(i / options.batchSize) + 1} failed: ${message}`);
      console.error("  Retrying rows individually to isolate failures...");

      for (const change of batch) {
        try {
          await client.execute(upsertStatement(change));
          addSuccessfulChanges(result, [change]);
        } catch (rowError) {
          result.failed++;
          const rowMessage = rowError instanceof Error ? rowError.message : String(rowError);
          console.error(`    ${change.row.steamAppId} ${change.row.name}: ${rowMessage}`);
        }
      }
    }

    const applied = result.inserted + result.updated + result.failed;
    if (applied % 1000 === 0 || applied === changes.length) {
      console.log(`  Applied ${applied}/${changes.length}`);
    }
  }

  return result;
}

function addSuccessfulChanges(result: ApplyResult, changes: CatalogChange[]): void {
  for (const change of changes) {
    if (change.kind === "insert") {
      result.inserted++;
    } else {
      result.updated++;
    }
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const startedAt = Date.now();

  console.log("Refreshing SteamSpy catalog...");
  console.log(`  Minimum reviews: ${options.minReviews}`);
  console.log(`  Dry run: ${options.dryRun ? "yes" : "no"}`);
  if (options.limitPages) {
    console.log(`  Limit pages: ${options.limitPages}`);
  }

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const [entries, existingRows] = await Promise.all([
    fetchAllPages(options),
    loadExistingRows(client),
  ]);

  const plan = planCatalogChanges(entries, existingRows, options.minReviews);
  const insertsPlanned = plan.changes.filter((change) => change.kind === "insert").length;
  const updatesPlanned = plan.changes.filter((change) => change.kind === "update").length;

  console.log("\nPlan:");
  console.log(`  SteamSpy entries fetched: ${entries.length}`);
  console.log(`  Existing DB rows: ${existingRows.size}`);
  console.log(`  Candidates above threshold: ${plan.candidates}`);
  console.log(`  Below threshold: ${plan.belowThreshold}`);
  console.log(`  Invalid entries: ${plan.invalid}`);
  console.log(`  Inserts planned: ${insertsPlanned}`);
  console.log(`  Updates planned: ${updatesPlanned}`);
  console.log(`  Unchanged: ${plan.unchanged}`);

  const applyResult = await applyChanges(client, plan.changes, options);
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log("\nDone!");
  console.log(`  Inserted: ${applyResult.inserted}`);
  console.log(`  Updated: ${applyResult.updated}`);
  console.log(`  Skipped unchanged: ${plan.unchanged}`);
  console.log(`  Skipped below threshold: ${plan.belowThreshold}`);
  console.log(`  Invalid: ${plan.invalid}`);
  console.log(`  Failed: ${applyResult.failed}`);
  console.log(`  Elapsed: ${elapsedSeconds}s`);

  if (!options.dryRun && (applyResult.inserted > 0 || applyResult.updated > 0)) {
    console.log("\nNext: run `bun recalc` to refresh value scores after review changes.");
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
