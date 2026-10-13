export type DbValue = number | string | null;
export type DbStatement = string | { sql: string; args?: readonly DbValue[] };
export interface DbResult {
  columns: readonly string[];
  rows: readonly Record<string, DbValue>[];
  rowsAffected: number;
}
export interface DbClient {
  execute(statement: DbStatement): Promise<DbResult>;
  batch(statements: readonly DbStatement[], mode?: "read" | "write"): Promise<DbResult[]>;
  close(): void;
}
export const DB_LIMITS = Object.freeze({
  maxParams: 100, maxSqlBytes: 96000, maxStatements: 400, maxRequestBytes: 4194304,
  maxStringBytes: 1000000, maxRowsPerResult: 10000, maxResponseBytes: 8388608, timeoutMs: 45000,
});
export function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
export function isJsonMediaType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(value);
}
export type DbOutcome = "not-applied" | "rolled-back" | "committed" | "unknown";
const messages = {
  UNAUTHORIZED: "Machine authorization required",
  NOT_CONFIGURED: "Database access is not configured",
  INVALID_REQUEST: "Unsupported database request",
  LIMIT_EXCEEDED: "Database request exceeds supported limits",
  SQL_ERROR: "Database statement failed",
  RESULT_LIMIT: "Database result exceeds supported limits",
  TRANSPORT_ERROR: "Database transport failed",
  PROTOCOL_ERROR: "Invalid database response",
  OUTCOME_UNKNOWN: "Database write outcome is unknown; inspect state before resuming",
};
export type DbErrorCode = keyof typeof messages;
export class DbError extends Error {
  readonly code: DbErrorCode;
  readonly outcome: DbOutcome;
  readonly requestId?: string;
  readonly statementIndex?: number;
  constructor(code: DbErrorCode, outcome: DbOutcome, details: { requestId?: string; statementIndex?: number; message?: string } = {}) {
    super(details.message ?? messages[code]);
    this.name = "DbError";
    this.code = code;
    this.outcome = outcome;
    this.requestId = details.requestId;
    this.statementIndex = details.statementIndex;
  }
}
export function toDbError(error: unknown): DbError {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof DbError) return current;
    seen.add(current);
    current = current.cause;
  }
  return new DbError("OUTCOME_UNKNOWN", "unknown");
}
export const DB_ERROR_STATUS: Record<DbErrorCode, number> = {
  UNAUTHORIZED: 401, NOT_CONFIGURED: 503, INVALID_REQUEST: 400, LIMIT_EXCEEDED: 413,
  SQL_ERROR: 422, RESULT_LIMIT: 413, TRANSPORT_ERROR: 502, PROTOCOL_ERROR: 502, OUTCOME_UNKNOWN: 503,
};
export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isErrorCode(value: unknown): value is DbErrorCode {
  return typeof value === "string" && Object.hasOwn(messages, value);
}
function isOutcome(value: unknown): value is DbOutcome {
  return value === "not-applied" || value === "rolled-back" || value === "committed" || value === "unknown";
}
const tables = ["games", "sync_state", "catalog_refresh_state", "catalog_refresh_failures", "itad_game_map", "game_deal_cache", "deal_refresh_state"];
function safeSqlMessage(value: unknown): string | undefined {
  if (value === "Database constraint violation" || value === "Database SQL syntax error") return value;
  return tables.map((table) => `no such table: ${table}`).find((message) => value === message);
}
export function nativeSqlFailure(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message.startsWith("D1_ERROR:")) return undefined;
  if (/\bSQLITE_CONSTRAINT\b|\bconstraint failed\b/i.test(error.message)) return "Database constraint violation";
  for (const table of tables) {
    if (new RegExp(`\\bno such table: ${table}(?:\\b|$)`).test(error.message)) return `no such table: ${table}`;
  }
  if (/\bSQLITE_ERROR\b|\bsyntax error\b|\bno such (?:table|column|function)\b/i.test(error.message)) return "Database SQL syntax error";
  return undefined;
}
export function parseWireError(value: unknown, requestId: string): DbError {
  if (!isRecord(value) || !exactKeys(value, ["code", "message", "outcome", "statementIndex"]) || !isErrorCode(value.code) || typeof value.message !== "string" || !isOutcome(value.outcome) || (value.statementIndex !== undefined && (typeof value.statementIndex !== "number" || !Number.isSafeInteger(value.statementIndex) || value.statementIndex < 0))) throw new DbError("PROTOCOL_ERROR", "not-applied", { requestId });
  return new DbError(value.code, value.outcome, { requestId, statementIndex: value.statementIndex, message: value.code === "SQL_ERROR" ? safeSqlMessage(value.message) : undefined });
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isDbValue(value: unknown): value is DbValue {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
}
export function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
export interface ValidatedStatement { sql: string; args: DbValue[]; readOnly: boolean }
export function validateStatement(value: unknown): ValidatedStatement {
  const statement = typeof value === "string" ? { sql: value } : value;
  if (!isRecord(statement) || !exactKeys(statement, ["sql", "args"]) || typeof statement.sql !== "string") throw new DbError("INVALID_REQUEST", "not-applied");
  const supplied: unknown = "args" in statement ? statement.args : [];
  if (!Array.isArray(supplied)) throw new DbError("INVALID_REQUEST", "not-applied");
  const args: unknown[] = Array.from(supplied);
  if (!args.every(isDbValue)) throw new DbError("INVALID_REQUEST", "not-applied");
  if (args.length > DB_LIMITS.maxParams || byteLength(statement.sql) > DB_LIMITS.maxSqlBytes || args.some((arg) => typeof arg === "string" && byteLength(arg) > DB_LIMITS.maxStringBytes)) throw new DbError("LIMIT_EXCEEDED", "not-applied");
  const { kind, binds, executableSql } = inspectSql(statement.sql);
  if (binds !== args.length) throw new DbError("INVALID_REQUEST", "not-applied");
  return { sql: executableSql, args, readOnly: kind === "SELECT" };
}
function inspectSql(sql: string): { kind: string; binds: number; executableSql: string } {
  let kind = "";
  let binds = 0;
  let terminated = false;
  let end = sql.length;
  for (let i = 0; i < sql.length;) {
    const char = sql[i]!;
    if (/\s/.test(char)) { i++; continue; }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new DbError("INVALID_REQUEST", "not-applied");
      i = end + 2;
      continue;
    }
    if (terminated) throw new DbError("INVALID_REQUEST", "not-applied");
    if (!kind) {
      const word = sql.slice(i).match(/^(SELECT|INSERT|UPDATE|DELETE)\b/i)?.[0];
      if (!word) throw new DbError("INVALID_REQUEST", "not-applied");
      kind = word.toUpperCase();
      i += word.length;
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const endQuote = char === "[" ? "]" : char;
      const start = i + 1;
      let closed = false;
      for (i++; i < sql.length; i++) {
        if (sql[i] !== endQuote) continue;
        if (char !== "[" && sql[i + 1] === endQuote) { i++; continue; }
        i++;
        closed = true;
        break;
      }
      if (!closed) throw new DbError("INVALID_REQUEST", "not-applied");
      const name = sql.slice(start, i - 1).toUpperCase();
      const tail = sql.slice(i).replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "");
      if ((name === "LOAD_EXTENSION" || name.startsWith("PRAGMA_")) && tail.startsWith("(")) throw new DbError("INVALID_REQUEST", "not-applied");
      continue;
    }
    if (char === ";") { terminated = true; end = i; i++; continue; }
    if (/[a-z_]/i.test(char)) {
      const word = sql.slice(i).match(/^[a-z_][a-z_0-9]*/i)![0].toUpperCase();
      if (word === "WITH" || word === "LOAD_EXTENSION" || word.startsWith("PRAGMA_")) throw new DbError("INVALID_REQUEST", "not-applied");
      i += word.length;
      continue;
    }
    if (char === "?") {
      if (/\d/.test(sql[i + 1] ?? "")) throw new DbError("INVALID_REQUEST", "not-applied");
      binds++;
    }
    if (char === ":" || char === "@" || char === "$") throw new DbError("INVALID_REQUEST", "not-applied");
    i++;
  }
  if (!kind) throw new DbError("INVALID_REQUEST", "not-applied");
  return { kind, binds, executableSql: sql.slice(0, end) };
}
export function validateBatch(values: unknown, mode: unknown = "write"): ValidatedStatement[] {
  if (!Array.isArray(values) || (mode !== "read" && mode !== "write")) throw new DbError("INVALID_REQUEST", "not-applied");
  if (values.length > DB_LIMITS.maxStatements) throw new DbError("LIMIT_EXCEEDED", "not-applied");
  return Array.from(values).map((value, statementIndex) => {
    try {
      const checked = validateStatement(value);
      if (mode === "read" && !checked.readOnly) throw new DbError("INVALID_REQUEST", "not-applied");
      return checked;
    } catch (error) {
      const safe = toDbError(error);
      throw new DbError(safe.code, safe.outcome, { statementIndex });
    }
  });
}
export type DbWireRequest =
  | { version: 1; op: "execute"; statement: { sql: string; args: DbValue[] } }
  | { version: 1; op: "batch"; mode: "read" | "write"; statements: { sql: string; args: DbValue[] }[] };
function wireStatement(value: unknown): { sql: string; args: DbValue[] } {
  if (!isRecord(value) || !Array.isArray(value.args)) throw new DbError("INVALID_REQUEST", "not-applied");
  const { sql, args } = validateStatement(value);
  return { sql, args };
}
export function validateWireRequest(value: unknown): DbWireRequest {
  if (!isRecord(value) || value.version !== 1) throw new DbError("INVALID_REQUEST", "not-applied");
  if (value.op === "execute" && exactKeys(value, ["version", "op", "statement"])) {
    return { version: 1, op: "execute", statement: wireStatement(value.statement) };
  }
  if (value.op === "batch" && exactKeys(value, ["version", "op", "mode", "statements"]) && (value.mode === "read" || value.mode === "write") && Array.isArray(value.statements) && value.statements.length > 0) {
    if (value.statements.length > DB_LIMITS.maxStatements) throw new DbError("LIMIT_EXCEEDED", "not-applied");
    value.statements.forEach(wireStatement);
    const statements = validateBatch(value.statements, value.mode).map(({ sql, args }) => ({ sql, args }));
    return { version: 1, op: "batch", mode: value.mode, statements };
  }
  throw new DbError("INVALID_REQUEST", "not-applied");
}
export function encodeDbRequest(value: DbWireRequest): string {
  const body = JSON.stringify(value);
  if (byteLength(body) > DB_LIMITS.maxRequestBytes) throw new DbError("LIMIT_EXCEEDED", "not-applied");
  return body;
}
export async function readBoundedJson(body: ReadableStream<Uint8Array> | null, maxBytes: number, limitCode: DbErrorCode, invalidCode: DbErrorCode, signal?: AbortSignal): Promise<unknown> {
  if (!body) throw new DbError(invalidCode, "not-applied");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      if (signal?.aborted) throw new DbError("TRANSPORT_ERROR", "not-applied");
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new DbError("TRANSPORT_ERROR", "not-applied");
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new DbError(limitCode, "not-applied");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof DbError) throw error;
    throw new DbError(invalidCode, "not-applied");
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
export function encodeDbSuccess(payload: { result: DbResult } | { results: DbResult[] }, requestId: string, readOnly: boolean): string {
  const body = JSON.stringify({ version: 1, ok: true, requestId, ...payload });
  if (byteLength(body) > DB_LIMITS.maxResponseBytes) throw new DbError("RESULT_LIMIT", readOnly ? "not-applied" : "committed");
  return body;
}
export function parseDbResult(value: unknown): DbResult {
  if (!isRecord(value) || !exactKeys(value, ["columns", "rows", "rowsAffected"]) || !Array.isArray(value.columns) || !value.columns.every((column): column is string => typeof column === "string" && !/^(?:0|[1-9]\d*)$/.test(column)) || new Set(value.columns).size !== value.columns.length || !Array.isArray(value.rows) || !Number.isSafeInteger(value.rowsAffected) || typeof value.rowsAffected !== "number" || value.rowsAffected < 0) throw new DbError("PROTOCOL_ERROR", "not-applied");
  if (value.rows.length > DB_LIMITS.maxRowsPerResult) throw new DbError("RESULT_LIMIT", "not-applied");
  const rows: Record<string, DbValue>[] = [];
  for (const row of value.rows) {
    if (!isRecord(row) || Object.keys(row).length !== value.columns.length || !exactKeys(row, value.columns)) throw new DbError("PROTOCOL_ERROR", "not-applied");
    const checked: Record<string, DbValue> = {};
    for (const column of value.columns) {
      const cell = row[column];
      if (!isDbValue(cell)) throw new DbError("PROTOCOL_ERROR", "not-applied");
      if (typeof cell === "string" && byteLength(cell) > DB_LIMITS.maxStringBytes) throw new DbError("RESULT_LIMIT", "not-applied");
      Object.defineProperty(checked, column, { value: cell, enumerable: true });
    }
    rows.push(checked);
  }
  return { columns: value.columns, rows, rowsAffected: value.rowsAffected };
}
