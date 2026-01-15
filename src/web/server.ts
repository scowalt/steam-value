import index from "./index.html";
import { db } from "../db/client";
import { games } from "../db/schema";
import { desc, isNotNull, and, eq, gt, or, SQL } from "drizzle-orm";
import { syncSteamStatus } from "../services/steam-sync";

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const server = Bun.serve({
  port: 3000,
  routes: {
    "/": index,
    "/api/games": async (req) => {
      const url = new URL(req.url);
      const limit = parseInt(url.searchParams.get("limit") || "100");
      const offset = parseInt(url.searchParams.get("offset") || "0");

      // Filter parameters
      const hideEa = url.searchParams.get("hideEa") === "true";
      const hidePlayed = url.searchParams.get("hidePlayed") === "true";
      const hideMMO = url.searchParams.get("hideMMO") === "true";
      const hideIgnored = url.searchParams.get("hideIgnored") === "true";
      const singleOnly = url.searchParams.get("singleOnly") === "true";
      const coopFilter = url.searchParams.get("coop") || "any";
      const controllerFilter = url.searchParams.get("controller") || "any";

      // Build conditions array
      const conditions: SQL<unknown>[] = [
        isNotNull(games.valueScore),
        eq(games.isEndless, false),
      ];

      if (hideEa) {
        conditions.push(eq(games.isEarlyAccess, false));
      }

      if (hidePlayed) {
        conditions.push(
          or(eq(games.playtimeMinutes, 0), eq(games.playtimeMinutes, null)) as SQL<unknown>
        );
      }

      if (hideMMO) {
        conditions.push(eq(games.isMMO, false));
      }

      if (hideIgnored) {
        conditions.push(eq(games.isIgnored, false));
      }

      if (singleOnly) {
        conditions.push(eq(games.hasSinglePlayer, true));
        conditions.push(eq(games.hasMultiplayer, false));
      }

      if (coopFilter === "has-coop") {
        conditions.push(
          or(
            eq(games.hasCoOp, true),
            eq(games.hasOnlineCoOp, true),
            eq(games.hasLocalCoOp, true)
          ) as SQL<unknown>
        );
      } else if (coopFilter === "online-coop") {
        conditions.push(eq(games.hasOnlineCoOp, true));
      } else if (coopFilter === "local-coop") {
        conditions.push(eq(games.hasLocalCoOp, true));
      }

      if (controllerFilter === "full") {
        conditions.push(eq(games.controllerSupport, "full"));
      } else if (controllerFilter === "partial") {
        conditions.push(
          or(
            eq(games.controllerSupport, "full"),
            eq(games.controllerSupport, "partial")
          ) as SQL<unknown>
        );
      }

      const results = await db.query.games.findMany({
        where: and(...conditions),
        orderBy: desc(games.valueScore),
        limit,
        offset,
      });

      return Response.json(results);
    },
    "/api/sync": {
      POST: async () => {
        const result = await syncSteamStatus();
        return Response.json(result);
      },
    },
  },
});

console.log(`Server running at http://localhost:${server.port}`);

// Sync on startup
syncSteamStatus().then((result) => {
  if (result.success) {
    console.log(`[Startup] Synced: ${result.wishlistCount} wishlisted, ${result.ignoredCount} ignored`);
  }
});

// Periodic sync
setInterval(() => {
  syncSteamStatus().then((result) => {
    if (result.gamesUpdated > 0) {
      console.log(`[Periodic Sync] Updated ${result.gamesUpdated} games`);
    }
  });
}, SYNC_INTERVAL_MS);
