import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { join } from "node:path";

export function collectReleasedD1Owners() {
  Bun.gc(true);
}

export async function disposeD1Runtime(runtime: Pick<Miniflare, "dispose">) {
  await runtime.dispose();
  collectReleasedD1Owners();
}

export interface LocalD1Worker {
  name?: string;
  script?: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  text?: Record<string, string>;
  d1: readonly string[] | Readonly<Record<string, string>>;
}

export function createD1Runtime(workers: LocalD1Worker | readonly LocalD1Worker[], persistTo?: string) {
  return new Miniflare({
    cf: false, host: "127.0.0.1", port: 0, enableDevRegistry: false, telemetry: { enabled: false },
    resourcePersistencePath: persistTo === undefined ? undefined : join(persistTo, "v3"),
    workers: [workers].flat().map((worker) => ({
      config: {
        name: worker.name ?? "",
        compatibilityDate: worker.compatibilityDate ?? "2000-01-01",
        compatibilityFlags: worker.compatibilityFlags,
        manifest: { mainModule: "index.mjs", modules: { "index.mjs": { type: "esm" as const, contents: worker.script ?? "export default { fetch() { return new Response(null, { status: 404 }); } }" } } },
        env: {
          ...Object.fromEntries(Object.entries(worker.text ?? {}).map(([name, value]) => [name, { type: "text" as const, value }])),
          ...Object.fromEntries((Array.isArray(worker.d1) ? worker.d1.map((name) => [name, name]) : Object.entries(worker.d1)).map(([name, id]) => [name, { type: "d1" as const, id }])),
        },
      },
    })),
  });
}

export interface LocalD1Options {
  persistTo?: string;
  databaseNames?: readonly string[];
}

export interface LocalD1Owner {
  readonly binding: D1Database;
  getBinding(name: string): Promise<D1Database>;
  dispose(): Promise<void>;
}

export async function createLocalD1(options: LocalD1Options = {}): Promise<LocalD1Owner> {
  collectReleasedD1Owners();
  const names = [...new Set(["DB", ...(options.databaseNames ?? [])])];
  const runtime = createD1Runtime({ d1: names }, options.persistTo);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await disposeD1Runtime(runtime);
  };
  try {
    return {
      binding: await runtime.getD1Database("DB"),
      async getBinding(name) {
        if (disposed || !names.includes(name)) throw new Error("Local D1 binding is unavailable");
        return runtime.getD1Database(name);
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
