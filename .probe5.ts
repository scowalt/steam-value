import { Miniflare } from "miniflare";
const dir = process.argv[2]!;
const mf = new Miniflare({
  cf: false, host: "127.0.0.1", port: 0, enableDevRegistry: false, telemetry: { enabled: false },
  resourcePersistencePath: dir + "/v3",
  workers: [{ config: { name: "local-d1", compatibilityDate: "2026-05-22",
    manifest: { mainModule: "index.mjs", modules: { "index.mjs": { type: "esm", contents: "export default { fetch() { return new Response(null, { status: 404 }); } }" } } },
    env: { DB: { type: "d1", id: "DB" }, SECOND: { type: "d1", id: "SECOND" } } } }],
});
for (const b of ["DB", "SECOND"]) {
  const db = await mf.getD1Database(b);
  console.log(b, JSON.stringify((await db.prepare("SELECT v FROM t").all()).results));
}
await mf.dispose();
