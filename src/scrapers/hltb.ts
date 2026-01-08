import type { HltbData } from "./types";

const HLTB_BASE_URL = "https://howlongtobeat.com";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

interface HltbGameData {
  game_id: number;
  game_name: string;
  comp_main: number;
  comp_plus: number;
  comp_100: number;
  profile_steam?: number;
}

interface NextData {
  props?: {
    pageProps?: {
      game?: {
        data?: {
          game?: HltbGameData[];
        };
      };
    };
  };
}

/**
 * Fetch HLTB data by scraping the game page directly.
 * This works when you know the HLTB game ID.
 */
export async function getHltbById(hltbId: number): Promise<HltbData | null> {
  try {
    const url = `${HLTB_BASE_URL}/game/${hltbId}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": getRandomUserAgent(),
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch HLTB game page: ${response.status}`);
    }

    const html = await response.text();

    // Extract __NEXT_DATA__ JSON from the page
    const nextDataMatch = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/
    );
    if (!nextDataMatch) {
      throw new Error("Could not find game data in page");
    }

    const nextData: NextData = JSON.parse(nextDataMatch[1]);
    const gameData = nextData.props?.pageProps?.game?.data?.game?.[0];

    if (!gameData) {
      throw new Error("No game data found in page");
    }

    // Times are in seconds, convert to hours
    return {
      hltbId: gameData.game_id,
      name: gameData.game_name,
      main: gameData.comp_main > 0 ? gameData.comp_main / 3600 : null,
      mainExtra: gameData.comp_plus > 0 ? gameData.comp_plus / 3600 : null,
      completionist: gameData.comp_100 > 0 ? gameData.comp_100 / 3600 : null,
    };
  } catch (error) {
    console.error(`Failed to fetch HLTB data for id ${hltbId}:`, error);
    return null;
  }
}

/**
 * Search HLTB by game name.
 * Note: The HLTB API blocks automated requests. This function will return null
 * and suggest using getHltbById() with a known HLTB game ID instead.
 *
 * You can find the HLTB ID by:
 * 1. Searching on howlongtobeat.com
 * 2. Looking at the URL: howlongtobeat.com/game/XXXXX
 * 3. The XXXXX is the HLTB ID
 */
export async function searchHltb(gameName: string): Promise<HltbData | null> {
  // HLTB API blocks automated requests with 404s
  // Return null and guide user to provide HLTB ID manually
  console.warn(
    `HLTB search is not available (API blocked). To add HLTB data, find the game on howlongtobeat.com and use the --hltb-id flag.`
  );
  console.warn(
    `Example: bun run add <steam_app_id> --hltb-id <hltb_game_id>`
  );
  return null;
}

/**
 * Try to find HLTB data for a game.
 * If hltbId is provided, fetch directly from the game page.
 * Otherwise, return null (search API is blocked).
 */
export async function fetchHltbData(
  gameName: string,
  hltbId?: number
): Promise<HltbData | null> {
  if (hltbId) {
    return getHltbById(hltbId);
  }
  return searchHltb(gameName);
}
