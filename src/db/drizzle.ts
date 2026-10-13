import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { DbClient, DbResult } from "./access.ts";
import * as schema from "./schema.ts";

export function createDrizzleDb(client: DbClient) {
  return drizzle(async (sql, args, method) => proxyResult(await client.execute({ sql, args }), method),
    async (queries) => {
      const results = await client.batch(queries.map(({ sql, params }) => ({ sql, args: params })), "write");
      return results.map((result, index) => proxyResult(result, queries[index]!.method));
    }, { schema });
}

function proxyResult(result: DbResult, method: "run" | "all" | "get" | "values") {
  const rows = result.rows.map((row) => result.columns.map((column) => row[column]));
  if (method === "run") return { rows: [], rowsAffected: result.rowsAffected };
  return { rows: method === "get" ? rows[0]! : rows };
}
