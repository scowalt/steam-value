import { createClient, type Client } from "@libsql/client/web";
import { DB_ERROR_STATUS, DB_LIMITS, encodeDbSuccess, isJsonMediaType, isRequestId, readBoundedJson, toDbError, validateStatement, validateWireRequest } from "../db/access";
import { createD1Client } from "../db/d1";
import { getSyncState } from "../services/steam-status-sync";
import { getDealRefreshStatus } from "../services/game-deals";
import { listCityBuilderGames, listGames, parseGameQuery } from "./games";

export interface Env {
  DB?: D1Database;
  STEAM_VALUE_DB_TOKEN?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
}

let client: Client | null = null;
let clientKey: string | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      const safe = toDbError(error);
      console.error("Unhandled Worker error", { code: safe.code, outcome: safe.outcome });
      return json({ error: safe.message }, { status: 500, headers: { "Cache-Control": "no-store" } });
    }
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/internal/db") {
    return handleMachineRequest(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/games") {
    const games = await listGames(getClient(env), parseGameQuery(url));
    return json(games);
  }

  if (request.method === "GET" && url.pathname === "/api/city-builders") {
    const games = await listCityBuilderGames(getClient(env));
    return json(games);
  }

  if (request.method === "GET" && url.pathname === "/api/deal-state") {
    return json(await getDealRefreshStatus(getClient(env)));
  }

  if (request.method === "GET" && url.pathname === "/api/sync-state") {
    return json(await getSyncState(getClient(env)));
  }

  if (url.pathname.startsWith("/api/")) {
    return json({ error: "Not found" }, { status: 404 });
  }

  return new Response("Not found", { status: 404 });
}

async function handleMachineRequest(request: Request, env: Env): Promise<Response> {
  const suppliedId = request.headers.get("X-Steam-Value-Request-Id");
  const requestId = isRequestId(suppliedId) ? suppliedId : crypto.randomUUID();
  const failure = (code: string, message: string, status: number) => json({
    version: 1, ok: false, requestId, error: { code, message, outcome: "not-applied" },
  }, { status, headers: { "Cache-Control": "no-store" } });
  if (!env.STEAM_VALUE_DB_TOKEN || !/^\S+$/.test(env.STEAM_VALUE_DB_TOKEN)) return failure("NOT_CONFIGURED", "Database access is not configured", 503);
  const supplied = request.headers.get("Authorization")?.match(/^Bearer (\S+)$/i)?.[1] ?? "";
  const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [expected, actual] = await Promise.all([digest(env.STEAM_VALUE_DB_TOKEN), digest(supplied)]);
  const left = new Uint8Array(expected);
  const right = new Uint8Array(actual);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  if (difference !== 0) return failure("UNAUTHORIZED", "Machine authorization required", 401);
  if (!env.DB) return failure("NOT_CONFIGURED", "Database access is not configured", 503);
  if (request.method !== "POST") {
    const response = failure("INVALID_REQUEST", "Unsupported database request", 405);
    response.headers.set("Allow", "POST");
    return response;
  }
  const encoding = request.headers.get("Content-Encoding");
  if (!isJsonMediaType(request.headers.get("Content-Type")) || (encoding !== null && encoding.toLowerCase() !== "identity")) return failure("INVALID_REQUEST", "Unsupported database request", 415);
  try {
    const body = validateWireRequest(await readBoundedJson(request.body, DB_LIMITS.maxRequestBytes, "LIMIT_EXCEEDED", "INVALID_REQUEST"));
    const client = createD1Client(env.DB);
    const result = body.op === "execute"
      ? { result: await client.execute(body.statement) }
      : { results: await client.batch(body.statements, body.mode) };
    const readOnly = body.op === "execute" ? validateStatement(body.statement).readOnly : body.statements.every((statement) => validateStatement(statement).readOnly);
    return new Response(encodeDbSuccess(result, requestId, readOnly), { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } });
  } catch (error) {
    const safe = toDbError(error);
    return json({ version: 1, ok: false, requestId, error: { code: safe.code, message: safe.message, outcome: safe.outcome, statementIndex: safe.statementIndex } }, {
      status: DB_ERROR_STATUS[safe.code], headers: { "Cache-Control": "no-store" },
    });
  }
}

function getClient(env: Env): Client {
  if (!env.TURSO_DATABASE_URL) throw new Error("Viewer database is not configured");
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
