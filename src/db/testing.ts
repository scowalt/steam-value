import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { applyMigrations, loadMigrations } from "./migrations";

export interface D1TestEnv {
  DB: D1Database;
  STEAM_VALUE_DB_TOKEN: string;
}

export type WorkerFetch = (request: Request, env: D1TestEnv) => Response | Promise<Response>;

export async function createD1TestHarness(workerFetch: WorkerFetch) {
  Bun.gc(true);
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
    return createHarness(runtime, env.STEAM_VALUE_DB_TOKEN, (request) => workerFetch(request, env));
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export interface D1WorkerTestOptions {
  bootstrap?: boolean;
}

let workerBundle: Promise<string> | undefined;

async function bundledWorker() {
  const build = await Bun.build({ entrypoints: [new URL("../worker/index.ts", import.meta.url).pathname], target: "browser", minify: true });
  const output = build.outputs[0];
  if (!build.success || build.outputs.length !== 1 || !output) throw new Error("Could not build the actual Worker request fixture");
  return output.text();
}

export async function createD1WorkerTestHarness(options: D1WorkerTestOptions = {}) {
  Bun.gc(true);
  const script = await (workerBundle ??= bundledWorker());
  const token = `synthetic-${crypto.randomUUID()}`;
  const runtime = new Miniflare({
    modules: true, script, compatibilityDate: "2026-05-22",
    bindings: { STEAM_VALUE_DB_TOKEN: token }, d1Databases: ["DB"], d1Persist: false,
    cf: false, host: "127.0.0.1", port: 0,
  });
  try {
    if (options.bootstrap !== false) {
      await applyMigrations(await runtime.getD1Database("DB"), await loadMigrations());
    }
    return createHarness(runtime, token, async (request) => {
      const redirect = request.redirect;
      if (redirect !== "error" && redirect !== "manual" && redirect !== "follow") throw new Error("Unsupported fixture request redirect mode");
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => { headers[key] = value; });
      const response = await runtime.dispatchFetch(request.url, {
        method: request.method, headers,
        body: request.body === null ? undefined : await request.arrayBuffer(), signal: request.signal, redirect,
      });
      const responseHeaders = new Headers();
      response.headers.forEach((value, key) => { responseHeaders.append(key, value); });
      const reader = response.body?.getReader();
      const body = reader ? new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              reader.releaseLock();
              controller.close();
            } else {
              if (!(chunk.value instanceof Uint8Array)) throw new Error("Invalid fixture response bytes");
              controller.enqueue(chunk.value);
            }
          } catch {
            reader.releaseLock();
            controller.error(new Error("D1 fixture response transport failed"));
          }
        },
        async cancel(reason) {
          try { await reader.cancel(reason); } finally { reader.releaseLock(); }
        },
      }) : null;
      return new Response(body, { status: response.status, headers: responseHeaders });
    });
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

function createHarness(runtime: Miniflare, token: string, send: (request: Request) => Response | Promise<Response>) {
  let disposed = false;
  const dispatch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    if (disposed) throw new Error("D1 test harness is disposed");
    const request = input instanceof Request && init === undefined ? input
      : typeof input === "string" ? new Request(input, init)
      : input instanceof URL ? new Request(input.href, init) : new Request(input, init);
    if (new URL(request.url).origin !== "https://d1-test.invalid") throw new Error("D1 test harness accepts only its synthetic HTTPS origin");
    return send(request);
  }, { preconnect() {} });
  return {
    fetch: dispatch,
    clientConfig: {
      url: "https://d1-test.invalid/api/internal/db", token,
      accessClientId: "synthetic-access-client-id",
      accessClientSecret: "synthetic-access-client-secret",
      fetch: dispatch,
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await runtime.dispose();
      Bun.gc(true);
    },
  };
}

export type D1TestHarness = Awaited<ReturnType<typeof createD1TestHarness>>;
export type D1WorkerTestHarness = Awaited<ReturnType<typeof createD1WorkerTestHarness>>;
