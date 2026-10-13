import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { applyMigrations, loadMigrations } from "./migrations";

export interface D1TestEnv {
  DB: D1Database;
  STEAM_VALUE_DB_TOKEN: string;
}

export type WorkerFetch = (request: Request, env: D1TestEnv) => Response | Promise<Response>;

export async function createD1TestHarness(workerFetch: WorkerFetch) {
  const runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 404 }); } }",
    d1Databases: ["DB"],
    d1Persist: false,
    cf: false,
    host: "127.0.0.1",
    port: 0,
  });
  try {
    const DB = await runtime.getD1Database("DB");
    await applyMigrations(DB, await loadMigrations());
    const env: D1TestEnv = { DB, STEAM_VALUE_DB_TOKEN: `synthetic-${crypto.randomUUID()}` };
    let disposed = false;
    const dispatch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      if (disposed) throw new Error("D1 test harness is disposed");
      const request = new Request(input, init);
      if (new URL(request.url).origin !== "https://d1-test.invalid") throw new Error("D1 test harness accepts only its synthetic HTTPS origin");
      return workerFetch(request, env);
    }, { preconnect() {} });
    return {
      fetch: dispatch,
      clientConfig: {
        url: "https://d1-test.invalid/api/internal/db",
        token: env.STEAM_VALUE_DB_TOKEN,
        accessClientId: "synthetic-access-client-id",
        accessClientSecret: "synthetic-access-client-secret",
        fetch: dispatch,
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        await runtime.dispose();
      },
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export type D1TestHarness = Awaited<ReturnType<typeof createD1TestHarness>>;
