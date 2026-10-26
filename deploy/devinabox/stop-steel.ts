import { join } from "node:path";

const runtime = process.env.RUNTIME_DIRECTORY;
if (!runtime) throw new Error("Steel runtime directory is required");
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
if (container.Id !== id || container.Image !== "sha256:5c10c06375cb1e4833999432f307c816bf72486c8c57667d41b307fb660191fc" || container.Config.Labels?.["info.scowalt.application"] !== "steam-value" || container.Config.Labels?.["info.scowalt.component"] !== "steel" || !container.Mounts.some((mount: { Source: string; Destination: string }) => mount.Source === join(process.env.HOME!, ".local/share/steam-value/steel-profile") && mount.Destination === "/app/api/user-data-dir")) throw new Error("Steel container ownership differs; no stop");
if (container.State.Running) docker(["stop", "--time", "60", id]);
console.log("Owned Steel container is stopped");
