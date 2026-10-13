import {
  DB_ERROR_STATUS, DB_LIMITS, DbError, encodeDbRequest, exactKeys, isJsonMediaType, isRecord, isRequestId,
  parseDbResult, parseWireError, readBoundedJson, validateBatch, validateStatement,
  type DbClient, type DbResult, type DbWireRequest,
} from "./access.ts";

export interface HttpClientConfig {
  url: string;
  token: string;
  accessClientId: string;
  accessClientSecret: string;
  fetch?: (request: Request) => Promise<Response>;
}
export function createExternalClient(env: Readonly<Record<string, string | undefined>>): DbClient {
  const url = env.STEAM_VALUE_DB_URL;
  const token = env.STEAM_VALUE_DB_TOKEN;
  const accessClientId = env.STEAM_VALUE_ACCESS_CLIENT_ID;
  const accessClientSecret = env.STEAM_VALUE_ACCESS_CLIENT_SECRET;
  if (!url || !token || !accessClientId || !accessClientSecret) throw new DbError("NOT_CONFIGURED", "not-applied");
  return createHttpClient({ url, token, accessClientId, accessClientSecret });
}
type Reply = { ok: true; results: DbResult[] } | { ok: false; error: DbError };

export function createHttpClient(config: HttpClientConfig): DbClient {
  const { url, token, accessClientId, accessClientSecret } = config;
  if ([url, token, accessClientId, accessClientSecret].some((value) => typeof value !== "string" || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) || !/^\S+$/.test(token)) throw new DbError("NOT_CONFIGURED", "not-applied");
  let endpoint: URL;
  try { endpoint = new URL(url); } catch { throw new DbError("NOT_CONFIGURED", "not-applied"); }
  if (endpoint.protocol !== "https:" || endpoint.pathname !== "/api/internal/db" || endpoint.username || endpoint.password || endpoint.href.includes("?") || endpoint.href.includes("#")) throw new DbError("NOT_CONFIGURED", "not-applied");
  const send = config.fetch ?? globalThis.fetch;
  if (typeof send !== "function") throw new DbError("NOT_CONFIGURED", "not-applied");
  let configuredHeaders: Headers;
  try {
    configuredHeaders = new Headers({
      "Content-Type": "application/json", "Authorization": `Bearer ${token}`,
      "CF-Access-Client-Id": accessClientId, "CF-Access-Client-Secret": accessClientSecret,
    });
  } catch { throw new DbError("NOT_CONFIGURED", "not-applied"); }

  async function call(body: DbWireRequest): Promise<DbResult[]> {
    const encoded = encodeDbRequest(body);
    const readOnly = body.op === "execute" ? validateStatement(body.statement).readOnly : body.statements.every((statement) => validateStatement(statement).readOnly);
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    const headers = new Headers(configuredHeaders);
    headers.set("X-Steam-Value-Request-Id", requestId);
    const request = new Request(endpoint.href, {
      method: "POST", redirect: "error", signal: controller.signal, headers, body: encoded,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DbError("TRANSPORT_ERROR", "not-applied"));
      }, DB_LIMITS.timeoutMs);
    });
    let reply: Reply;
    try {
      const operation = async () => {
        let response: Response;
        try { response = await send(request); }
        catch { throw new DbError("TRANSPORT_ERROR", "not-applied"); }
        return decodeResponse(response, body, requestId, readOnly, controller.signal);
      };
      reply = await Promise.race([operation(), deadline]);
    } catch (error) {
      if (!readOnly) throw new DbError("OUTCOME_UNKNOWN", "unknown", { requestId });
      const code = error instanceof DbError && (error.code === "TRANSPORT_ERROR" || error.code === "RESULT_LIMIT") ? error.code : "PROTOCOL_ERROR";
      throw new DbError(code, "not-applied", { requestId });
    } finally {
      clearTimeout(timer);
    }
    if (!reply.ok) throw reply.error;
    return reply.results;
  }
  return {
    async execute(statement) {
      const { sql, args } = validateStatement(statement);
      const results = await call({ version: 1, op: "execute", statement: { sql, args } });
      return results[0]!;
    },
    async batch(statements, mode = "write") {
      const checked = validateBatch(statements, mode);
      if (checked.length === 0) return [];
      return call({ version: 1, op: "batch", mode, statements: checked.map(({ sql, args }) => ({ sql, args })) });
    },
    close() {},
  };
}
async function decodeResponse(response: Response, body: DbWireRequest, requestId: string, readOnly: boolean, signal: AbortSignal): Promise<Reply> {
  if (response.redirected || !isJsonMediaType(response.headers.get("Content-Type"))) throw new DbError("PROTOCOL_ERROR", "not-applied");
  const value = await readBoundedJson(response.body, DB_LIMITS.maxResponseBytes, "RESULT_LIMIT", "PROTOCOL_ERROR", signal);
  if (!isRecord(value) || value.version !== 1 || !isRequestId(value.requestId) || value.requestId !== requestId) throw new DbError("PROTOCOL_ERROR", "not-applied");
  if (value.ok === false) {
    if (!exactKeys(value, ["version", "ok", "requestId", "error"])) throw new DbError("PROTOCOL_ERROR", "not-applied");
    const error = parseWireError(value.error, requestId);
    const statusMatches = response.status === DB_ERROR_STATUS[error.code] || (error.code === "INVALID_REQUEST" && (response.status === 405 || response.status === 415));
    const outcome = error.code === "SQL_ERROR" ? (body.op === "batch" ? "rolled-back" : "not-applied") : error.code === "RESULT_LIMIT" ? (readOnly ? "not-applied" : "committed") : error.code === "OUTCOME_UNKNOWN" ? "unknown" : "not-applied";
    if (!statusMatches || error.outcome !== outcome || (readOnly && error.code === "OUTCOME_UNKNOWN") || (error.statementIndex !== undefined && error.statementIndex >= (body.op === "execute" ? 1 : body.statements.length))) throw new DbError("PROTOCOL_ERROR", "not-applied");
    return { ok: false, error };
  }
  if (value.ok !== true || response.status !== 200 || !exactKeys(value, ["version", "ok", "requestId", body.op === "execute" ? "result" : "results"])) throw new DbError("PROTOCOL_ERROR", "not-applied");
  if (body.op === "execute") return { ok: true, results: [parseDbResult(value.result)] };
  if (!Array.isArray(value.results) || value.results.length !== body.statements.length) throw new DbError("PROTOCOL_ERROR", "not-applied");
  return { ok: true, results: value.results.map(parseDbResult) };
}
