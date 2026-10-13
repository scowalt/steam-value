import type { Client } from "@libsql/client/web";
import type { DbClient } from "../db/access";

const SYNC_STATE_KEY = "steam_status";
const LOCK_TTL_SECONDS = 15 * 60;
const BATCH_SIZE = 200;

export interface SteamStatusEnv {
  STEAM_API_KEY?: string;
  STEAM_ID?: string;
  STEAM_LOGIN_SECURE?: string;
}

export interface SteamUserData {
  rgIgnoredApps?: Record<string, number>;
  rgWishlist?: number[];
  rgOwnedApps?: number[];
}

interface OwnedGame {
  appid: number;
  playtime_forever: number;
}

interface GetOwnedGamesResponse {
  response?: {
    game_count?: number;
    games?: OwnedGame[];
  };
}

interface SteamLibrarySnapshot {
  ownedGames: Map<number, number>;
  recentlyPlayedGames: Map<number, number>;
}

interface CurrentGameStatus {
  id: number;
  steamAppId: number;
  isIgnored: boolean;
  isOnWishlist: boolean;
  isOwned: boolean;
  playtimeMinutes: number | null;
}

export interface SteamStatusCounts {
  ignoredCount: number;
  wishlistCount: number;
  ownedCount: number;
  dynamicStoreOwnedCount: number;
}

export interface SyncState {
  key: string;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  isRunning: boolean;
  lockExpiresAt: number | null;
  ignoredCount: number;
  wishlistCount: number;
  ownedCount: number;
  gamesUpdated: number;
  gamesRemoved: number;
  updatedAt: number | null;
}

export interface SyncResult {
  success: boolean;
  ignoredCount: number;
  wishlistCount: number;
  ownedCount: number;
  gamesUpdated: number;
  gamesRemoved: number;
  error?: string;
  skipped?: boolean;
  state?: SyncState | null;
}

export async function ensureSyncStateTable(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    last_attempt_at INTEGER,
    last_success_at INTEGER,
    last_error TEXT,
    is_running INTEGER NOT NULL DEFAULT 0,
    lock_expires_at INTEGER,
    ignored_count INTEGER NOT NULL DEFAULT 0,
    wishlist_count INTEGER NOT NULL DEFAULT 0,
    owned_count INTEGER NOT NULL DEFAULT 0,
    games_updated INTEGER NOT NULL DEFAULT 0,
    games_removed INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
}

export async function getSyncState(client: DbClient): Promise<SyncState | null> {
  try {
    const result = await client.execute({
      sql: "SELECT * FROM sync_state WHERE key = ?",
      args: [SYNC_STATE_KEY],
    });

    const row = result.rows[0];
    if (!row) return null;

    return mapSyncState(row);
  } catch (error) {
    if (isMissingSyncStateTable(error)) return null;
    throw error;
  }
}

export async function syncSteamStatus(
  client: DbClient,
  env: SteamStatusEnv
): Promise<SyncResult> {
  return runSteamStatusSync(client, async () => {
    const [userData, library] = await Promise.all([
      fetchSteamUserData(env),
      fetchSteamLibrary(env),
    ]);

    return { userData, ...library };
  });
}

export async function syncSteamStatusFromUserData(
  client: DbClient,
  env: SteamStatusEnv,
  userData: SteamUserData
): Promise<SyncResult> {
  return runSteamStatusSync(client, async () => {
    const library = await fetchSteamLibrary(env);
    return { userData, ...library };
  });
}

async function runSteamStatusSync(
  client: DbClient,
  loadData: () => Promise<{ userData: SteamUserData } & SteamLibrarySnapshot>
): Promise<SyncResult> {
  const lockExpiresAt = await acquireSyncLock(client);
  if (!lockExpiresAt) {
    return {
      success: false,
      ignoredCount: 0,
      wishlistCount: 0,
      ownedCount: 0,
      gamesUpdated: 0,
      gamesRemoved: 0,
      skipped: true,
      error: "Steam Status refresh is already running",
      state: await getSyncState(client),
    };
  }

  try {
    const previousState = await getSyncState(client);
    const { userData, ownedGames, recentlyPlayedGames } = await loadData();
    const counts = getSteamStatusCounts(userData, ownedGames);
    const validationError = validateSteamStatusCounts(counts, previousState);
    if (validationError) throw new Error(validationError);

    const currentGames = await fetchCurrentGameStatuses(client);

    const ignoredSet = new Set(Object.keys(userData.rgIgnoredApps!).map(Number));
    const wishlistSet = new Set(userData.rgWishlist!);

    const updates: { sql: string; args: (number | null)[] }[] = [];

    for (const game of currentGames) {
      const isIgnored = ignoredSet.has(game.steamAppId);
      const isOnWishlist = wishlistSet.has(game.steamAppId);
      const ownedPlaytime = ownedGames.get(game.steamAppId);
      const recentPlaytime = recentlyPlayedGames.get(game.steamAppId);
      const isOwned = ownedPlaytime !== undefined;
      const playtimeMinutes = resolvePlaytimeMinutes(
        game.playtimeMinutes,
        ownedPlaytime,
        recentPlaytime
      );

      if (
        game.isIgnored !== isIgnored ||
        game.isOnWishlist !== isOnWishlist ||
        game.isOwned !== isOwned ||
        game.playtimeMinutes !== playtimeMinutes
      ) {
        updates.push({
          sql: `UPDATE games SET
            is_ignored = ?,
            is_on_wishlist = ?,
            is_owned = ?,
            playtime_minutes = ?,
            updated_at = unixepoch()
          WHERE id = ?`,
          args: [
            isIgnored ? 1 : 0,
            isOnWishlist ? 1 : 0,
            isOwned ? 1 : 0,
            playtimeMinutes,
            game.id,
          ],
        });
      }
    }

    await runBatches(client, updates);

    const result: SyncResult = {
      success: true,
      ignoredCount: ignoredSet.size,
      wishlistCount: wishlistSet.size,
      ownedCount: ownedGames.size,
      gamesUpdated: updates.length,
      gamesRemoved: 0,
    };

    await markSyncSuccess(client, result, lockExpiresAt);
    result.state = await getSyncState(client);

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Steam Status refresh error";
    await markSyncFailure(client, message, lockExpiresAt);

    return {
      success: false,
      ignoredCount: 0,
      wishlistCount: 0,
      ownedCount: 0,
      gamesUpdated: 0,
      gamesRemoved: 0,
      error: message,
      state: await getSyncState(client),
    };
  }
}

export function getSteamStatusCounts(
  userData: SteamUserData,
  ownedGames: Map<number, number>
): SteamStatusCounts {
  return {
    ignoredCount:
      userData.rgIgnoredApps && typeof userData.rgIgnoredApps === "object"
        ? Object.keys(userData.rgIgnoredApps).length
        : -1,
    wishlistCount: Array.isArray(userData.rgWishlist) ? userData.rgWishlist.length : -1,
    ownedCount: ownedGames.size,
    dynamicStoreOwnedCount: Array.isArray(userData.rgOwnedApps) ? userData.rgOwnedApps.length : -1,
  };
}

export function validateSteamStatusCounts(
  counts: SteamStatusCounts,
  previousState: SyncState | null
): string | null {
  if (counts.wishlistCount < 0 || counts.ignoredCount < 0 || counts.dynamicStoreOwnedCount < 0) {
    return "Steam Dynamic Store returned an incomplete response";
  }

  if (counts.dynamicStoreOwnedCount === 0) {
    return "Steam Dynamic Store session is not authenticated";
  }

  if (counts.ownedCount === 0) {
    return "Steam owned-games API returned no games";
  }

  if (!previousState) return null;

  const suspiciousDrops: string[] = [];
  if (isSuspiciousDrop(previousState.wishlistCount, counts.wishlistCount)) {
    suspiciousDrops.push(`wishlist ${previousState.wishlistCount} -> ${counts.wishlistCount}`);
  }
  if (isSuspiciousDrop(previousState.ignoredCount, counts.ignoredCount)) {
    suspiciousDrops.push(`ignored ${previousState.ignoredCount} -> ${counts.ignoredCount}`);
  }
  if (isSuspiciousDrop(previousState.ownedCount, counts.ownedCount)) {
    suspiciousDrops.push(`owned ${previousState.ownedCount} -> ${counts.ownedCount}`);
  }

  return suspiciousDrops.length > 0
    ? `Steam Status refresh rejected suspicious count drops: ${suspiciousDrops.join(", ")}`
    : null;
}

function isSuspiciousDrop(previous: number, current: number): boolean {
  return previous >= 10 && current < Math.floor(previous * 0.2);
}

async function acquireSyncLock(client: DbClient): Promise<number | null> {
  const now = unixNow();
  const lockExpiresAt = now + LOCK_TTL_SECONDS;

  const result = await client.execute({
    sql: `INSERT INTO sync_state (
        key,
        last_attempt_at,
        is_running,
        lock_expires_at,
        last_error,
        updated_at
      ) VALUES (?, ?, 1, ?, NULL, ?)
      ON CONFLICT(key) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        is_running = 1,
        lock_expires_at = excluded.lock_expires_at,
        last_error = NULL,
        updated_at = excluded.updated_at
      WHERE sync_state.is_running = 0
        OR sync_state.lock_expires_at IS NULL
        OR sync_state.lock_expires_at < ?`,
    args: [SYNC_STATE_KEY, now, lockExpiresAt, now, now],
  });

  return result.rowsAffected > 0 ? lockExpiresAt : null;
}

async function markSyncSuccess(client: DbClient, result: SyncResult, lockExpiresAt: number): Promise<void> {
  const now = unixNow();

  await client.execute({
    sql: `UPDATE sync_state SET
      last_success_at = ?,
      last_error = NULL,
      is_running = 0,
      lock_expires_at = NULL,
      ignored_count = ?,
      wishlist_count = ?,
      owned_count = ?,
      games_updated = ?,
      games_removed = ?,
      updated_at = ?
    WHERE key = ? AND lock_expires_at = ?`,
    args: [
      now,
      result.ignoredCount,
      result.wishlistCount,
      result.ownedCount,
      result.gamesUpdated,
      result.gamesRemoved,
      now,
      SYNC_STATE_KEY,
      lockExpiresAt,
    ],
  });
}

async function markSyncFailure(client: DbClient, error: string, lockExpiresAt: number): Promise<void> {
  const now = unixNow();

  await client.execute({
    sql: `UPDATE sync_state SET
      last_error = ?,
      is_running = 0,
      lock_expires_at = NULL,
      updated_at = ?
    WHERE key = ? AND lock_expires_at = ?`,
    args: [error, now, SYNC_STATE_KEY, lockExpiresAt],
  });
}

async function fetchSteamUserData(env: SteamStatusEnv): Promise<SteamUserData> {
  if (!env.STEAM_LOGIN_SECURE) {
    throw new Error("Missing STEAM_LOGIN_SECURE");
  }

  const response = await fetch("https://store.steampowered.com/dynamicstore/userdata/", {
    headers: {
      Cookie: `steamLoginSecure=${env.STEAM_LOGIN_SECURE}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Steam dynamicstore error: ${response.status}`);
  }

  return (await response.json()) as SteamUserData;
}

async function fetchSteamLibrary(env: SteamStatusEnv): Promise<SteamLibrarySnapshot> {
  if (!env.STEAM_API_KEY || !env.STEAM_ID) {
    throw new Error("Missing STEAM_API_KEY or STEAM_ID");
  }

  const ownedGamesUrl = createPlayerServiceUrl("GetOwnedGames", env);
  ownedGamesUrl.searchParams.set("include_played_free_games", "true");

  const recentlyPlayedUrl = createPlayerServiceUrl("GetRecentlyPlayedGames", env);
  recentlyPlayedUrl.searchParams.set("count", "100");

  const [ownedGamesResponse, recentlyPlayedResponse] = await Promise.all([
    fetch(ownedGamesUrl.toString()),
    fetch(recentlyPlayedUrl.toString()),
  ]);

  if (!ownedGamesResponse.ok) {
    throw new Error(`Steam owned games error: ${ownedGamesResponse.status}`);
  }
  if (!recentlyPlayedResponse.ok) {
    throw new Error(`Steam recently played games error: ${recentlyPlayedResponse.status}`);
  }

  const ownedGamesData = (await ownedGamesResponse.json()) as GetOwnedGamesResponse;
  const recentlyPlayedData = (await recentlyPlayedResponse.json()) as GetOwnedGamesResponse;
  const ownedGames = ownedGamesData.response?.games ?? [];
  const recentlyPlayedGames = recentlyPlayedData.response?.games ?? [];

  return {
    ownedGames: new Map(ownedGames.map((game) => [game.appid, game.playtime_forever])),
    recentlyPlayedGames: new Map(
      recentlyPlayedGames.map((game) => [game.appid, game.playtime_forever])
    ),
  };
}

function createPlayerServiceUrl(method: string, env: SteamStatusEnv): URL {
  const url = new URL(`https://api.steampowered.com/IPlayerService/${method}/v1/`);
  url.searchParams.set("key", env.STEAM_API_KEY!);
  url.searchParams.set("steamid", env.STEAM_ID!);
  return url;
}

export function resolvePlaytimeMinutes(
  current: number | null,
  owned: number | undefined,
  recent: number | undefined
): number | null {
  const values = [current, owned, recent].filter(
    (value): value is number => value != null && Number.isFinite(value) && value >= 0
  );

  return values.length > 0 ? Math.max(...values) : null;
}

async function fetchCurrentGameStatuses(client: DbClient): Promise<CurrentGameStatus[]> {
  const result = await client.execute(`
    SELECT
      id,
      steam_app_id,
      is_ignored,
      is_on_wishlist,
      is_owned,
      playtime_minutes
    FROM games
  `);

  return result.rows.map((row) => ({
    id: Number(row.id),
    steamAppId: Number(row.steam_app_id),
    isIgnored: toBoolean(row.is_ignored),
    isOnWishlist: toBoolean(row.is_on_wishlist),
    isOwned: toBoolean(row.is_owned),
    playtimeMinutes: row.playtime_minutes == null ? null : Number(row.playtime_minutes),
  }));
}

async function runBatches(
  client: DbClient,
  statements: { sql: string; args: (number | null)[] }[]
): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await client.batch(statements.slice(i, i + BATCH_SIZE), "write");
  }
}

function isMissingSyncStateTable(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("no such table: sync_state");
}

function mapSyncState(row: Record<string, unknown>): SyncState {
  return {
    key: String(row.key),
    lastAttemptAt: nullableNumber(row.last_attempt_at),
    lastSuccessAt: nullableNumber(row.last_success_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    isRunning: toBoolean(row.is_running),
    lockExpiresAt: nullableNumber(row.lock_expires_at),
    ignoredCount: Number(row.ignored_count ?? 0),
    wishlistCount: Number(row.wishlist_count ?? 0),
    ownedCount: Number(row.owned_count ?? 0),
    gamesUpdated: Number(row.games_updated ?? 0),
    gamesRemoved: Number(row.games_removed ?? 0),
    updatedAt: nullableNumber(row.updated_at),
  };
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
