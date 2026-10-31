import { checkCurrentMain } from "./current-main";

const retired = ["TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL"];
const application = "STEAM_VALUE_DB_TOKEN";
interface CleanupOptions {
  accountId: string;
  apiToken: string;
  assertCurrentMain: () => Promise<void>;
  fetch?: (request: Request) => Promise<Response>;
}
interface SecretName { name: string; type: string }
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export async function retireLegacyWorkerSecrets(options: CleanupOptions): Promise<string[]> {
  if (!/^[a-f0-9]{32}$/.test(options.accountId) || !options.apiToken || !/^\S+$/.test(options.apiToken)) throw new Error("Invalid Worker cleanup configuration");
  const base = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/workers/scripts/steam-value/secrets`;
  const send = options.fetch ?? globalThis.fetch;
  async function call(method: "GET" | "DELETE", name?: string) {
    let response: Response;
    try {
      response = await send(new Request(name ? `${base}/${name}` : base, { method, headers: { Authorization: `Bearer ${options.apiToken}` }, redirect: "error", signal: AbortSignal.timeout(30000) }));
    } catch { throw new Error(`Worker secret ${method} transport failed; inspect before retry`); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Worker secret ${method} failed (HTTP ${response.status}); no automatic retry`);
    }
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error("Invalid Worker secret response; inspect before retry"); }
    if (!isRecord(value) || value.success !== true) throw new Error("Worker secret operation was not confirmed; inspect before retry");
    return value.result;
  }
  async function list(): Promise<SecretName[]> {
    const value = await call("GET");
    if (!Array.isArray(value) || value.some(item => !isRecord(item) || typeof item.name !== "string" || !item.name || typeof item.type !== "string")) throw new Error("Invalid Worker secret inventory");
    const names = value.map(item => ({ name: String(item.name), type: String(item.type) }));
    if (new Set(names.map(item => item.name)).size !== names.length || !names.some(item => item.name === application && item.type === "secret_text")) throw new Error("Application secret inventory differs");
    return names;
  }
  const before = await list();
  const selected = retired.filter(name => before.some(item => item.name === name));
  if (before.some(item => retired.includes(item.name) && item.type !== "secret_text")) throw new Error("Retired binding type differs");
  for (const name of selected) {
    await options.assertCurrentMain();
    await call("DELETE", name);
  }
  const after = await list();
  if (after.some(item => retired.includes(item.name)) || before.some(item => !retired.includes(item.name) && !after.some(remaining => remaining.name === item.name && remaining.type === item.type))) throw new Error("Worker secret cleanup readback differs");
  return selected;
}

if (import.meta.main) {
  if (process.env.CI_REPO !== "scowalt/steam-value" || process.env.CI_PIPELINE_EVENT !== "push" || process.env.CI_COMMIT_REF !== "refs/heads/main") throw new Error("Worker cleanup requires a main push");
  const head = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  const [sha, , code] = await Promise.all([new Response(head.stdout).text(), new Response(head.stderr).text(), head.exited]);
  if (code !== 0 || sha.trim() !== process.env.CI_COMMIT_SHA) throw new Error("Worker cleanup checkout differs");
  const removed = await retireLegacyWorkerSecrets({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "", assertCurrentMain: checkCurrentMain });
  console.log(removed.length ? `Retired Worker secret names: ${removed.join(", ")}` : "No retired Worker secret names remain");
}
