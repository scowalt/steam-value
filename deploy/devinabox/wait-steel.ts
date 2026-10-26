import { join } from "node:path";

const runtime = process.env.RUNTIME_DIRECTORY;
const home = process.env.HOME;
if (!runtime || !home) throw new Error("Steel runtime directory and home are required");
const marker = Bun.file(join(runtime, "api-url"));
const ca = await Bun.file(join(home, ".portless/ca.pem")).text();
const deadline = Date.now() + 180000;
let readyCount = 0;
while (Date.now() < deadline) {
  if (!(await marker.exists())) {
    await Bun.sleep(250);
    continue;
  }
  const api = new URL((await marker.text()).trim());
  if (api.protocol !== "https:" || api.host !== "steam-value-steel-api.localhost" || api.pathname !== "/" || api.username || api.password || api.search || api.hash) throw new Error("Unexpected local Steel readiness URL");
  try {
    const response = await fetch(new URL("/v1/sessions/current/live-details", api), { redirect: "error", signal: AbortSignal.timeout(2000), tls: { ca } });
    if (response.ok) {
      const data = await response.json() as { pages?: unknown[] };
      readyCount = Array.isArray(data.pages) && data.pages.length > 0 ? readyCount + 1 : 0;
      if (readyCount >= 2) {
        console.log("Owned Steel browser and initial page are ready");
        process.exit(0);
      }
    } else {
      await response.body?.cancel();
      if (![500, 502, 503, 504].includes(response.status)) throw new Error(`Steel readiness rejected HTTP ${response.status}`);
      readyCount = 0;
    }
  } catch (error: any) {
    if (error.name !== "TimeoutError" && error.name !== "AbortError" && !["ECONNREFUSED", "ECONNRESET"].includes(error.code)) throw error;
    readyCount = 0;
  }
  await Bun.sleep(250);
}
throw new Error("Owned Steel browser did not become ready; no startup fallback");
