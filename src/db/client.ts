import { createDrizzleDb } from "./drizzle.ts";
import { createExternalClient } from "./http.ts";

export const client = createExternalClient(process.env);
export const db = createDrizzleDb(client);
