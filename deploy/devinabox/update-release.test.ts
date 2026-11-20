import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestProductionCommit, updateRelease, type ReleaseHost } from "./update-release";

const unit = "[Service]\nExecStart=%h/.bun/bin/bun scripts/refresh-deals.ts\n";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function commit(source: string, files: Record<string, string>) {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(source, path, ".."), { recursive: true });
    await writeFile(join(source, path), contents);
  }
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "change");
  return git(source, "rev-parse", "HEAD");
}

async function machine() {
  const root = await mkdtemp(join(tmpdir(), "steam-value-release-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  git(source, "init", "-q", "-b", "main");
  const first = await commit(source, {
    "package.json": "{}\n",
    "deploy/devinabox/steam-value-deals-refresh.service": unit,
    "deploy/devinabox/deals.env.example": "STEAM_VALUE_DB_TOKEN=\n",
  });
  const home = join(root, "home");
  await mkdir(join(home, "releases", first), { recursive: true });
  await writeFile(join(home, "releases", first, "package.json"), "{}\n");
  await symlink(join(home, "releases", first), join(home, "current"));
  await mkdir(join(root, "units"));
  await writeFile(join(root, "units", "steam-value-deals-refresh.service"), unit);
  await mkdir(join(root, "env"));
  await writeFile(join(root, "env", "deals.env"), "STEAM_VALUE_DB_TOKEN=synthetic-secret\n");

  const units: Record<string, string> = {
    "steam-value-deals-refresh.timer": "active", "steam-value-deals-refresh.service": "inactive",
    "steam-value-status-sync.timer": "inactive", "steam-value-status-sync.service": "inactive",
  };
  const calls: string[] = [];
  const installs: string[] = [];
  let production = first;
  const host: ReleaseHost = {
    root: home, unitDirectory: join(root, "units"), environmentDirectory: join(root, "env"), remote: source,
    productionCommit: async () => production,
    async systemctl([verb, name]) {
      calls.push(`${verb} ${name}`);
      if (verb === "stop") units[name!] = "inactive";
      if (verb === "start") units[name!] = "active";
      return `${units[name!]}\n`;
    },
    async install(directory) {
      installs.push(directory);
      await mkdir(join(directory, "node_modules"));
    },
    log() {},
  };
  return { home, source, first, units, calls, installs, host, deploy: (sha: string) => { production = sha; } };
}

test("a newer production commit on main is installed and selected with active job timers paused around the switch", async () => {
  const m = await machine();
  const second = await commit(m.source, { "src/a.ts": "export {};\n" });
  m.deploy(second);
  expect(await updateRelease(m.host)).toEqual({ outcome: "switched", commit: second });
  expect(await readlink(join(m.home, "current"))).toBe(join(m.home, "releases", second));
  expect(await Bun.file(join(m.home, "releases", second, "src/a.ts")).text()).toBe("export {};\n");
  expect(JSON.parse(await Bun.file(join(m.home, "releases", second, ".release.json")).text())).toMatchObject({ commit: second });
  expect(m.calls.filter(call => !call.startsWith("is-active"))).toEqual(["stop steam-value-deals-refresh.timer", "start steam-value-deals-refresh.timer"]);
  expect(m.units["steam-value-status-sync.timer"]).toBe("inactive");
  expect(await Bun.file(join(m.home, "releases", m.first, "package.json")).exists()).toBe(true);
});

test("the selected production commit needs no git, install or systemd work", async () => {
  const m = await machine();
  expect(await updateRelease(m.host)).toEqual({ outcome: "current", commit: m.first });
  expect(m.calls).toEqual([]);
  expect(m.installs).toEqual([]);
});

test("a running job defers the switch, restores its timer and reuses the prepared release on the next attempt", async () => {
  const m = await machine();
  const second = await commit(m.source, { "src/a.ts": "export {};\n" });
  m.deploy(second);
  m.units["steam-value-deals-refresh.service"] = "activating";
  expect(await updateRelease(m.host)).toEqual({ outcome: "deferred", commit: second });
  expect(await readlink(join(m.home, "current"))).toBe(join(m.home, "releases", m.first));
  expect(m.units["steam-value-deals-refresh.timer"]).toBe("active");
  m.units["steam-value-deals-refresh.service"] = "inactive";
  expect(await updateRelease(m.host)).toEqual({ outcome: "switched", commit: second });
  expect(m.installs).toHaveLength(1);
});

test("a release that changes an installed unit or needs a new environment key waits for a human", async () => {
  const m = await machine();
  m.deploy(await commit(m.source, { "deploy/devinabox/steam-value-deals-refresh.service": `${unit}TimeoutStartSec=1h\n` }));
  await expect(updateRelease(m.host)).rejects.toThrow("changes steam-value-deals-refresh.service; install that unit by hand");
  m.deploy(await commit(m.source, { "deploy/devinabox/steam-value-deals-refresh.service": unit, "deploy/devinabox/deals.env.example": "STEAM_VALUE_DB_TOKEN=\nITAD_API_KEY=\n" }));
  const failure = await updateRelease(m.host).catch((error: Error) => error);
  expect(String(failure)).toContain("needs ITAD_API_KEY in deals.env");
  expect(String(failure)).not.toContain("synthetic-secret");
  expect(m.calls).toEqual([]);
  expect(await readlink(join(m.home, "current"))).toBe(join(m.home, "releases", m.first));
});

test("production commits that are not on main or would move the jobs backwards are refused", async () => {
  const m = await machine();
  git(m.source, "checkout", "-q", "-b", "side");
  const side = await commit(m.source, { "src/side.ts": "export {};\n" });
  git(m.source, "checkout", "-q", "main");
  m.deploy(side);
  await expect(updateRelease(m.host)).rejects.toThrow("is not on main");
  const second = await commit(m.source, { "src/a.ts": "export {};\n" });
  m.deploy(second);
  await updateRelease(m.host);
  m.deploy(m.first);
  await expect(updateRelease(m.host)).rejects.toThrow("does not descend from selected release");
});

test("only the newest updater-installed releases are retained and pre-existing releases are left alone", async () => {
  const m = await machine();
  const installed: string[] = [];
  for (const name of ["b", "c", "d", "e", "f"]) {
    const sha = await commit(m.source, { [`src/${name}.ts`]: "export {};\n" });
    m.deploy(sha);
    await updateRelease(m.host);
    installed.push(sha);
  }
  const present = await Promise.all(installed.map(sha => Bun.file(join(m.home, "releases", sha, "package.json")).exists()));
  expect(present).toEqual([false, false, true, true, true]);
  expect(await Bun.file(join(m.home, "releases", m.first, "package.json")).exists()).toBe(true);
});

test("production is the newest deployment whose latest status succeeded", async () => {
  const states: Record<number, string> = { 3: "in_progress", 2: "failure", 1: "success" };
  const sha = (n: number) => String(n).repeat(40);
  const send = async (request: Request) => {
    const { pathname } = new URL(request.url);
    const id = pathname.match(/deployments\/(\d+)\/statuses/)?.[1];
    return Response.json(id ? [{ state: states[Number(id)] }] : [3, 2, 1].map(n => ({ id: n, sha: sha(n) })));
  };
  expect(await latestProductionCommit(send)).toBe(sha(1));
  await expect(latestProductionCommit(async () => Response.json([{ id: 1, sha: "main" }]))).rejects.toThrow("Invalid production deployment response");
  await expect(latestProductionCommit(async () => new Response("", { status: 403 }))).rejects.toThrow("HTTP 403");
});
