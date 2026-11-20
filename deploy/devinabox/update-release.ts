import { mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const RELEASE_JOBS = ["steam-value-deals-refresh", "steam-value-status-sync"] as const;
const RETAINED_RELEASES = 3;
const commitPattern = /^[a-f0-9]{40}$/;
const busyStates = new Set(["active", "activating", "deactivating", "reloading", "refreshing"]);

export interface ReleaseHost {
  root: string;
  unitDirectory: string;
  environmentDirectory: string;
  remote: string;
  productionCommit(): Promise<string>;
  systemctl(args: string[]): Promise<string>;
  install(directory: string): Promise<void>;
  log(message: string): void;
}

export type ReleaseOutcome = { outcome: "current" | "deferred" | "switched"; commit: string };

type Send = (request: Request) => Promise<Response>;

async function githubJson(send: Send, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await send(new Request(`https://api.github.com/repos/scowalt/steam-value/${path}`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "steam-value-release-update" },
      redirect: "error", signal: AbortSignal.timeout(30000),
    }));
  } catch { throw new Error("Cannot read production deployments (transport failure)"); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Cannot read production deployments (HTTP ${response.status})`);
  }
  try { return await response.json(); } catch { throw new Error("Invalid production deployment response"); }
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

export async function latestProductionCommit(send: Send = request => fetch(request)): Promise<string> {
  const deployments = await githubJson(send, "deployments?environment=production&per_page=10");
  if (!Array.isArray(deployments)) throw new Error("Invalid production deployment response");
  for (const deployment of deployments) {
    const id = field(deployment, "id");
    const sha = field(deployment, "sha");
    if (typeof id !== "number" || typeof sha !== "string" || !commitPattern.test(sha)) throw new Error("Invalid production deployment response");
    const statuses = await githubJson(send, `deployments/${id}/statuses?per_page=1`);
    if (!Array.isArray(statuses)) throw new Error("Invalid production deployment response");
    if (field(statuses[0], "state") === "success") return sha;
  }
  throw new Error("No successful production deployment among the newest ten");
}

async function run(command: string[], cwd?: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command.slice(0, 2).join(" ")} failed (${code}): ${stderr.trim().slice(0, 500)}`);
  return stdout;
}

async function succeeds(command: string[]): Promise<boolean> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return await child.exited === 0;
}

function environmentKeys(text: string): Set<string> {
  return new Set([...text.matchAll(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(match => match[1]!));
}

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertInstalledConfiguration(host: ReleaseHost, mirror: string, commit: string) {
  const templates = (await run(["git", "-C", mirror, "ls-tree", "--name-only", `${commit}:deploy/devinabox`])).split("\n").filter(Boolean);
  for (const name of templates) {
    const template = await run(["git", "-C", mirror, "show", `${commit}:deploy/devinabox/${name}`]);
    if (/\.(service|timer)$/.test(name)) {
      const installed = await readOptional(join(host.unitDirectory, name));
      if (installed !== undefined && installed !== template) throw new Error(`Release ${commit} changes ${name}; install that unit by hand, then rerun`);
    }
    const environment = name.match(/^(.+\.env)\.example$/)?.[1];
    if (environment) {
      const installed = await readOptional(join(host.environmentDirectory, environment));
      if (installed === undefined) throw new Error(`Release ${commit} needs ${environment}; create it by hand, then rerun`);
      const present = environmentKeys(installed);
      const missing = [...environmentKeys(template)].filter(key => !present.has(key));
      if (missing.length) throw new Error(`Release ${commit} needs ${missing.join(", ")} in ${environment}; add them by hand, then rerun`);
    }
  }
}

async function prepareRelease(host: ReleaseHost, mirror: string, commit: string) {
  const releases = join(host.root, "releases");
  const destination = join(releases, commit);
  const marker = join(destination, ".release.json");
  if (await readOptional(marker) !== undefined) return destination;
  if (await readOptional(join(destination, "package.json")) !== undefined) throw new Error(`${destination} exists without an install record; inspect it by hand`);
  const staging = join(releases, `.${commit}.partial`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const archive = `${staging}.tar`;
  await run(["git", "-C", mirror, "archive", "--format=tar", "-o", archive, commit]);
  try { await run(["tar", "-xf", archive, "-C", staging]); } finally { await rm(archive, { force: true }); }
  await host.install(staging);
  await writeFile(join(staging, ".release.json"), `${JSON.stringify({ commit, installedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  await rename(staging, destination);
  host.log(`Prepared release ${commit}`);
  return destination;
}

async function pruneReleases(host: ReleaseHost, keep: Set<string>) {
  const releases = join(host.root, "releases");
  const installed: { name: string; installedAt: string }[] = [];
  for (const name of await readdir(releases)) {
    if (!commitPattern.test(name) || keep.has(name)) continue;
    const record = await readOptional(join(releases, name, ".release.json"));
    if (record === undefined) continue;
    const installedAt = field(JSON.parse(record), "installedAt");
    if (typeof installedAt === "string") installed.push({ name, installedAt });
  }
  installed.sort((a, b) => b.installedAt.localeCompare(a.installedAt));
  for (const { name } of installed.slice(Math.max(0, RETAINED_RELEASES - keep.size))) {
    await rm(join(releases, name), { recursive: true, force: true });
    host.log(`Removed release ${name}`);
  }
}

export async function updateRelease(host: ReleaseHost): Promise<ReleaseOutcome> {
  const commit = await host.productionCommit();
  if (!commitPattern.test(commit)) throw new Error("Invalid production commit");
  const link = join(host.root, "current");
  const current = basename(await realpath(link));
  if (current === commit) return { outcome: "current", commit };

  const mirror = join(host.root, "source.git");
  if (!(await succeeds(["git", "-C", mirror, "rev-parse", "--git-dir"]))) await run(["git", "clone", "--bare", "--quiet", host.remote, mirror]);
  await run(["git", "-C", mirror, "fetch", "--quiet", host.remote, "+refs/heads/main:refs/heads/main"]);
  if (!(await succeeds(["git", "-C", mirror, "merge-base", "--is-ancestor", commit, "refs/heads/main"]))) throw new Error(`Production commit ${commit} is not on main`);
  if (!(await succeeds(["git", "-C", mirror, "merge-base", "--is-ancestor", current, commit]))) throw new Error(`Production commit ${commit} does not descend from selected release ${current}; switch by hand`);

  await assertInstalledConfiguration(host, mirror, commit);
  const destination = await prepareRelease(host, mirror, commit);

  const paused: string[] = [];
  let outcome: ReleaseOutcome["outcome"] = "deferred";
  try {
    for (const job of RELEASE_JOBS) {
      if ((await host.systemctl(["is-active", `${job}.timer`])).trim() !== "active") continue;
      await host.systemctl(["stop", `${job}.timer`]);
      paused.push(`${job}.timer`);
    }
    const busy: string[] = [];
    for (const job of RELEASE_JOBS) {
      if (busyStates.has((await host.systemctl(["is-active", `${job}.service`])).trim())) busy.push(job);
    }
    if (busy.length) {
      host.log(`Deferred release ${commit}: ${busy.join(", ")} running`);
    } else {
      const next = join(host.root, ".current.next");
      await rm(next, { force: true });
      await symlink(destination, next);
      await rename(next, link);
      outcome = "switched";
      host.log(`Selected release ${commit} (was ${current})`);
    }
  } finally {
    for (const timer of paused) await host.systemctl(["start", timer]);
  }
  if (outcome === "switched") await pruneReleases(host, new Set([commit, current]));
  return { outcome, commit };
}

export function machineHost(): ReleaseHost {
  const home = homedir();
  const bun = join(home, ".bun/bin/bun");
  return {
    root: join(home, ".local/share/steam-value"),
    unitDirectory: join(home, ".config/systemd/user"),
    environmentDirectory: join(home, ".config/steam-value-d1"),
    remote: "https://github.com/scowalt/steam-value.git",
    productionCommit: () => latestProductionCommit(),
    async systemctl(args) {
      const child = Bun.spawn(["systemctl", "--user", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0 && args[0] !== "is-active") throw new Error(`systemctl ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
      return stdout;
    },
    async install(directory) { await run([bun, "install", "--frozen-lockfile"], directory); },
    log: message => console.log(message),
  };
}

if (import.meta.main) {
  const result = await updateRelease(machineHost());
  if (result.outcome === "current") console.log(`Release ${result.commit} is already selected`);
}
