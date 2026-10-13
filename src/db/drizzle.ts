import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { DbClient } from "./access.ts";
import * as schema from "./schema.ts";

export function createDrizzleDb(client: DbClient) {
  return drizzle(async (sql, args, method) => {
    const result = await client.execute({ sql, args });
    const rows = result.rows.map((row) => result.columns.map((column) => row[column]));
    if (method === "run") return { rows: [], rowsAffected: result.rowsAffected };
    return { rows: method === "get" ? rows[0]! : rows };
  }, { schema });
}
