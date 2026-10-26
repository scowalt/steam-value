import { openSync, closeSync, lstatSync } from "node:fs";
import { join } from "node:path";

const runtime = process.env.RUNTIME_DIRECTORY;
const home = process.env.HOME;
if (!runtime || !home) throw new Error("Steel runtime directory and home are required");
const file = Bun.file(join(runtime, "container-id"));
if (!(await file.exists())) process.exit(0);
const id = (await file.text()).trim();
if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid owned Steel container ID; no stop");

function docker(args: string[]) {
  const result = Bun.spawnSync(["/usr/bin/docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("Steel container operation failed; no fallback");
  return result.stdout.toString("utf8").trim();
}

const found = docker(["ps", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"]);
if (!found) process.exit(0);
if (found !== id) throw new Error("Steel container identity differs; no stop");
const [container] = JSON.parse(docker(["inspect", "--type=container", id]));
if (container.Id !== id || container.Image !== "sha256:5c10c06375cb1e4833999432f307c816bf72486c8c57667d41b307fb660191fc" || container.Config.Labels?.["info.scowalt.application"] !== "steam-value" || container.Config.Labels?.["info.scowalt.component"] !== "steel" || !container.Mounts.some((mount: { Source: string; Destination: string }) => mount.Source === join(home, ".local/share/steam-value/steel-profile") && mount.Destination === "/app/api/user-data-dir")) throw new Error("Steel container ownership differs; no stop");
if (!container.State.Running) process.exit(0);
const claim = openSync(join(runtime, "stop-requested"), "wx", 0o600);
closeSync(claim);

const api = new URL((await Bun.file(join(runtime, "api-url")).text()).trim());
if (api.protocol !== "https:" || api.host !== "steam-value-steel-api.localhost" || api.pathname !== "/" || api.username || api.password || api.search || api.hash) throw new Error("Unexpected owned Steel API; no stop");
const ca = await Bun.file(join(home, ".portless/ca.pem")).text();
async function request(path: string, method = "GET") {
  return fetch(new URL(path, api), { method, redirect: "error", signal: AbortSignal.timeout(method === "POST" ? 45000 : 10000), tls: { ca } });
}
async function liveSessions(): Promise<{ id: string; status: string }[]> {
  const response = await request("/v1/sessions");
  if (!response.ok) throw new Error("Cannot inspect owned Steel session; no container stop");
  const data = await response.json() as { sessions?: { id: string; status: string }[] };
  if (!Array.isArray(data.sessions)) throw new Error("Invalid Steel session metadata; no container stop");
  return data.sessions.filter(session => session.status === "live");
}

console.log(`Preparing graceful stop of owned Steel container ${id}`);
const live = await liveSessions();
if (live.length > 1) throw new Error("Multiple live Steel sessions; no container stop");
if (live.length === 1) {
  const session = live[0]!;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(session.id)) throw new Error("Invalid owned session ID; no release");
  const released = await request(`/v1/sessions/${session.id}/release`, "POST");
  if (!released.ok) throw new Error("Owned session release failed; no container stop or retry");
  await released.body?.cancel();
  if ((await liveSessions()).length !== 0) throw new Error("A live session remains after release; no container stop");
  console.log("Owned Steel session released before container stop");
}

try {
  lstatSync(join(home, ".local/share/steam-value/steel-profile/SingletonLock"));
  throw new Error("Persistent Chrome profile is still locked; no container stop");
} catch (error: any) {
  if (error.code !== "ENOENT") throw error;
}
docker(["stop", "--time", "60", id]);
console.log("Owned Steel container is stopped");
