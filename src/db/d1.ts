import { DbError, encodeDbRequest, encodeDbSuccess, isRecord, nativeSqlFailure, parseDbResult, validateBatch, validateStatement, type DbClient, type DbResult } from "./access.ts";

export function createD1Client(binding: D1Database): DbClient {
  if (!binding || typeof binding.prepare !== "function" || typeof binding.batch !== "function") throw new DbError("NOT_CONFIGURED", "not-applied");
  return {
    async execute(statement) {
      const checked = validateStatement(statement);
      encodeDbRequest({ version: 1, op: "execute", statement: { sql: checked.sql, args: checked.args } });
      let dispatched = false;
      let completed = false;
      try {
        const prepared = binding.prepare(checked.sql).bind(...checked.args);
        dispatched = true;
        const native = await prepared.all<unknown>();
        completed = native.success === true;
        const result = nativeResult(native);
        encodeDbSuccess({ result }, "00000000-0000-4000-8000-000000000000", checked.readOnly);
        return result;
      } catch (error) {
        throw executionError(error, checked.readOnly, dispatched, false, completed);
      }
    },
    async batch(statements, mode = "write") {
      const checked = validateBatch(statements, mode);
      if (checked.length === 0) return [];
      encodeDbRequest({ version: 1, op: "batch", mode, statements: checked.map(({ sql, args }) => ({ sql, args })) });
      let dispatched = false;
      let completed = false;
      const readOnly = checked.every((statement) => statement.readOnly);
      try {
        const prepared = checked.map((statement) => binding.prepare(statement.sql).bind(...statement.args));
        dispatched = true;
        const native = await binding.batch<unknown>(prepared);
        if (native.length !== checked.length) throw new DbError("PROTOCOL_ERROR", "not-applied");
        completed = native.every((result) => result.success === true);
        const results = native.map(nativeResult);
        encodeDbSuccess({ results }, "00000000-0000-4000-8000-000000000000", readOnly);
        return results;
      } catch (error) {
        throw executionError(error, readOnly, dispatched, true, completed);
      }
    },
    close() {},
  };
}

function executionError(error: unknown, readOnly: boolean, dispatched: boolean, batch: boolean, completed: boolean): DbError {
  if (completed && error instanceof DbError && error.code === "RESULT_LIMIT") return new DbError("RESULT_LIMIT", readOnly ? "not-applied" : "committed");
  const message = nativeSqlFailure(error);
  if (message) return new DbError("SQL_ERROR", dispatched && batch ? "rolled-back" : "not-applied", { message });
  if (error instanceof DbError && (!dispatched || readOnly)) return error;
  return new DbError(readOnly || !dispatched ? "TRANSPORT_ERROR" : "OUTCOME_UNKNOWN", readOnly || !dispatched ? "not-applied" : "unknown");
}
function nativeResult(value: unknown): DbResult {
  if (!isRecord(value) || value.success !== true || !Array.isArray(value.results) || !isRecord(value.meta)) throw new DbError("PROTOCOL_ERROR", "not-applied");
  const first: unknown = value.results[0];
  return parseDbResult({ columns: isRecord(first) ? Object.keys(first) : [], rows: value.results, rowsAffected: value.meta.changes });
}
