import { createDrizzleDb } from "./drizzle.ts";
import { createExternalClient } from "./http.ts";

export const db = createDrizzleDb(createExternalClient(process.env));
