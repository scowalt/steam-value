import { createClient, type Client } from "@libsql/client/web";
import { getSyncState } from "../services/steam-status-sync";
import { listCityBuilderGames, listGames, parseGameQuery } from "./games";

interface Env {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN?: string;
}

let client: Client | null = null;
let clientKey: string | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      console.error("Unhandled Worker error", error);
      return json({ error: message }, { status: 500 });
    }
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const client = getClient(env);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/games") {
    const games = await listGames(client, parseGameQuery(url));
    return json(games);
  }

  if (request.method === "GET" && url.pathname === "/api/city-builders") {
    const games = await listCityBuilderGames(client);
    return json(games);
  }

  if (request.method === "GET" && url.pathname === "/api/sync-state") {
    return json(await getSyncState(client));
  }

  if (url.pathname.startsWith("/api/")) {
    return json({ error: "Not found" }, { status: 404 });
  }

  return new Response("Not found", { status: 404 });
}

function getClient(env: Env): Client {
  const key = `${env.TURSO_DATABASE_URL}:${env.TURSO_AUTH_TOKEN ?? ""}`;

  if (!client || clientKey !== key) {
    client = createClient({
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    });
    clientKey = key;
  }

  return client;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, init);
}
