import { expect, test } from "bun:test";
import { isRecord } from "../src/db/access";
import { createHttpClient } from "../src/db/http";
import { createD1WorkerTestHarness } from "../src/db/testing";
import { getSyncState } from "../src/services/steam-status-sync";
import { getDealRefreshStatus, getGameDeals } from "../src/services/game-deals";

const start = 1_800_000_000;
const prefix = "__isolated_refresh_bridge__";
test("manual Steam Status and hourly offer entrypoints use only explicit external D1 configuration with fake providers", async () => {
  const harness = await createD1WorkerTestHarness();
  const client = createHttpClient(harness.clientConfig);
  try {
    await client.execute("INSERT INTO games (steam_app_id, name, value_score) VALUES (20, 'Entrypoint game', 100)");
    const code = `
      import { createInterface } from "node:readline";
      const input = createInterface({ input: process.stdin });
      Date.now = () => ${start} * 1000;
      process.argv = ["bun", "synthetic-refresh-test"];
      globalThis.fetch = async (value, init) => {
        const url = new URL(value instanceof Request ? value.url : String(value));
        if (url.origin === "https://d1-test.invalid") {
          if (!(value instanceof Request)) throw new Error("Expected a database request");
          const reply = new Promise(resolve => input.once("line", line => resolve(JSON.parse(line))));
          process.stdout.write(${JSON.stringify(prefix)} + JSON.stringify({ kind: "request", url: value.url, method: value.method, headers: Object.fromEntries(value.headers), body: await value.text() }) + "\\n");
          const response = await reply;
          return new Response(response.body, { status: response.status, headers: response.headers });
        }
        if (url.hostname === "store.steampowered.com" && url.pathname === "/dynamicstore/userdata/") return Response.json({ rgOwnedApps: [20], rgWishlist: [20], rgIgnoredApps: {} });
        if (url.hostname === "api.steampowered.com" && url.pathname === "/IPlayerService/GetOwnedGames/v1/") return Response.json({ response: { games: [{ appid: 20, playtime_forever: 60 }] } });
        if (url.hostname === "api.steampowered.com" && url.pathname === "/IPlayerService/GetRecentlyPlayedGames/v1/") return Response.json({ response: { games: [] } });
        if (url.hostname === "api.isthereanydeal.com") {
          if (url.pathname === "/bundles/v1") return Response.json([]);
          if (url.pathname === "/lookup/id/shop/61/v1") return Response.json({ "app/20": "00000000-0000-0000-0000-000000000020" });
          if (url.pathname === "/games/prices/v3") return Response.json([{ id: "00000000-0000-0000-0000-000000000020", deals: [] }]);
        }
        throw new Error("Unconfigured provider boundary; live network forbidden");
      };
      try {
        await import("./scripts/hydrate-daily.ts");
        await import("./scripts/refresh-deals.ts");
        process.stdout.write(${JSON.stringify(prefix)} + JSON.stringify({ kind: "result", exitCode: process.exitCode ?? 0 }) + "\\n");
      } finally { input.close(); }
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", code], {
      env: {
        STEAM_VALUE_DB_URL: harness.clientConfig.url, STEAM_VALUE_DB_TOKEN: harness.clientConfig.token,
        STEAM_VALUE_ACCESS_CLIENT_ID: "synthetic-id", STEAM_VALUE_ACCESS_CLIENT_SECRET: "synthetic-secret",
        STEAM_API_KEY: "synthetic-steam-key", STEAM_ID: "synthetic-steam-id", STEAM_LOGIN_SECURE: "synthetic-cookie", ITAD_API_KEY: "synthetic-itad-key",
      }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    async function message(): Promise<unknown> {
      for (;;) {
        while (!pending.includes("\n")) {
          const next = await reader.read();
          if (next.done) throw new Error("Synthetic refresh entrypoints exited before completing verification");
          pending += decoder.decode(next.value, { stream: true });
        }
        const end = pending.indexOf("\n");
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.startsWith(prefix)) return JSON.parse(line.slice(prefix.length));
      }
    }
    try {
      for (;;) {
        const value = await message();
        if (!isRecord(value)) throw new Error("Invalid refresh test bridge");
        if (value.kind === "result") { expect(value).toEqual({ kind: "result", exitCode: 0 }); break; }
        if (value.kind !== "request" || typeof value.url !== "string" || typeof value.method !== "string" || typeof value.body !== "string" || !isRecord(value.headers)) throw new Error("Invalid refresh test request");
        const headers = new Headers();
        for (const [key, header] of Object.entries(value.headers)) {
          if (typeof header !== "string") throw new Error("Invalid refresh test header");
          headers.set(key, header);
        }
        const response = await harness.fetch(new Request(value.url, { method: value.method, headers, body: value.body }));
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((header, key) => { responseHeaders[key] = header; });
        child.stdin.write(JSON.stringify({ status: response.status, headers: responseHeaders, body: await response.text() }) + "\n");
      }
      child.stdin.end();
      expect(await child.exited).toBe(0);
      expect(await getSyncState(client)).toMatchObject({ lastSuccessAt: start, isRunning: false, ownedCount: 1, wishlistCount: 1, gamesUpdated: 1 });
      expect((await client.execute("SELECT is_owned, is_on_wishlist, playtime_minutes FROM games WHERE steam_app_id=20")).rows).toEqual([{ is_owned: 1, is_on_wishlist: 1, playtime_minutes: 60 }]);
      expect((await getGameDeals(client, [20], start)).get(20)).toEqual({ status: "fresh", checkedAt: start, offers: [] });
      expect(await getDealRefreshStatus(client, start)).toMatchObject({ lastSuccessAt: start, gamesChecked: 1, lastError: null, isRunning: false });
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      await reader.cancel();
      reader.releaseLock();
      await new Response(child.stderr).text();
    }
  } finally { await harness.dispose(); }
});
