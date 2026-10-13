#!/usr/bin/env bun
import { db } from "../src/db/client";
import { readAllGames, reportManualError, updateGame } from "../src/db/manual";
import { games } from "../src/db/schema";
import { isNull, desc, eq } from "drizzle-orm";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface AppDetails {
  success: boolean;
  data?: {
    categories?: Array<{ id: number; description: string }>;
  };
}

async function fetchAppDetails(appId: number): Promise<AppDetails | null> {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appId}`;
  try {
    const res = await fetch(url);
    if (res.status === 429) return null;
    const data = await res.json() as Record<string, AppDetails>;
    return data[appId.toString()] || null;
  } catch {
    return null;
  }
}

async function main() {
  const nullGames = await readAllGames(db, {
    where: isNull(games.controllerSupport),
    orderBy: [desc(games.valueScore)],
  });

  console.log(
    `Hydrating ${nullGames.length} games (~${Math.ceil((nullGames.length * 1.5) / 60)} min)...`
  );

  let full = 0,
    partial = 0,
    noController = 0,
    errors = 0;

  for (let i = 0; i < nullGames.length; i++) {
    const game = nullGames[i]!;
    let appDetails: AppDetails | null = null;
    let retries = 0;

    while (retries < 3) {
      appDetails = await fetchAppDetails(game.steamAppId);
      if (appDetails !== null) break;
      await sleep(2000 * Math.pow(2, retries));
      retries++;
    }

    if (!appDetails?.success || !appDetails.data) {
      errors++;
      await sleep(1500);
      if ((i + 1) % 50 === 0)
        console.log(
          `${i + 1}/${nullGames.length} | Full: ${full}, Partial: ${partial}`
        );
      continue;
    }

    let controller: "full" | "partial" | null = null;
    if (appDetails.data.categories?.some((c) => c.id === 28)) {
      controller = "full";
      full++;
    } else if (appDetails.data.categories?.some((c) => c.id === 18)) {
      controller = "partial";
      partial++;
    } else {
      noController++;
    }

    await updateGame(db, eq(games.id, game.id), { controllerSupport: controller });
    if ((i + 1) % 50 === 0)
      console.log(
        `${i + 1}/${nullGames.length} | Full: ${full}, Partial: ${partial}`
      );
    await sleep(1500);
  }

  console.log(
    `\nDone! Full: ${full}, Partial: ${partial}, None: ${noController}, Errors: ${errors}`
  );
}

main().catch(reportManualError);
