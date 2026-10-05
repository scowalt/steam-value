
interface SteamUserData {
  rgIgnoredApps: Record<string, number>;
  rgOwnedApps: number[];
  rgWishlist: number[];
  rgFollowedApps: number[];
}

let ignoredAppsCache: Set<number> | null = null;

export async function fetchIgnoredApps(): Promise<Set<number>> {
  const cookie = process.env.STEAM_LOGIN_SECURE;

  if (!cookie) {
    console.warn("[Steam Ignored] No STEAM_LOGIN_SECURE cookie configured");
    console.warn("[Steam Ignored] Set it in .env to filter ignored games");
    return new Set();
  }

  console.log("[Steam Ignored] Fetching ignored games from Steam...");

  const response = await fetch(
    "https://store.steampowered.com/dynamicstore/userdata/",
    {
      headers: {
        Cookie: `steamLoginSecure=${cookie}`,
      },
    }
  );

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Steam authentication failed (${response.status}). Cookie may be expired - refresh it from browser.`
      );
    }
    throw new Error(`Failed to fetch Steam userdata: ${response.status}`);
  }

  const data: SteamUserData = await response.json();

  if (!data.rgIgnoredApps || typeof data.rgIgnoredApps !== "object" || Object.keys(data.rgIgnoredApps).length === 0) {
    console.warn("[Steam Ignored] No ignored apps found - cookie may be expired");
    console.warn("[Steam Ignored] Run: bun scripts/steam-login.ts");
    ignoredAppsCache = new Set();
    return ignoredAppsCache;
  }

  const ignoredIds = Object.keys(data.rgIgnoredApps).map(Number);
  ignoredAppsCache = new Set(ignoredIds);

  console.log(`[Steam Ignored] Loaded ${ignoredIds.length} ignored apps`);

  return ignoredAppsCache;
}

export async function isIgnored(appId: number): Promise<boolean> {
  if (!ignoredAppsCache) {
    await fetchIgnoredApps();
  }
  return ignoredAppsCache?.has(appId) ?? false;
}

export function getIgnoredApps(): Set<number> | null {
  return ignoredAppsCache;
}

export function clearIgnoredCache(): void {
  ignoredAppsCache = null;
}
