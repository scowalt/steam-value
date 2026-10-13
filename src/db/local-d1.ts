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
  const runtime = new Miniflare({
    modules: true, script: "export default { fetch() { return new Response(null, { status: 404 }); } }",
    d1Databases: names, d1Persist: options.persistTo === undefined ? false : join(options.persistTo, "v3", "d1"),
    cf: false, host: "127.0.0.1", port: 0,
  });
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
