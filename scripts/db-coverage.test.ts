import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocalD1 } from "../src/db/admin";
import { createD1Client } from "../src/db/d1";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function run(script: string, args: string[]) {
  const child = Bun.spawn(["bun", "--no-env-file", `scripts/${script}.ts`, ...args], {
    stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, WRANGLER_SEND_METRICS: "false" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}
async function bootstrapped() {
  const directory = await mkdtemp(join(tmpdir(), "steam-value-d1-coverage-"));
  directories.push(directory);
  const args = ["--local", "--persist-to", directory];
  expect((await run("setup-worker-db", args)).exitCode).toBe(0);
  return { directory, args };
}

const complete = {
  steam_review_score: 90, steam_review_count: 1000, tags: '["Puzzle"]', release_date: "2020-01-01", controller_support: "full",
  has_single_player: 1, hltb_id: 11, hltb_main: 10, value_score: 5, is_owned: 1,
};
const catalog: Record<string, number | string | null>[] = [
  complete,
  { ...complete, has_single_player: 0, has_multiplayer: 1, hltb_id: null, hltb_main: null, value_score: null, is_owned: 0, is_endless: 1, is_on_wishlist: 1 },
  {},
  { steam_review_score: 80, hltb_id: 12, release_date: "", is_ignored: 1, is_endless: null },
  { ...complete, controller_support: null, has_single_player: 0, value_score: null, is_owned: 0 },
];

test("coverage counts Catalog Facts, Steam Status, Value Score blockers and ordered next buckets for a seeded Game Catalog", async () => {
  const { directory, args } = await bootstrapped();
  const runtime = await openLocalD1(directory);
  try {
    await createD1Client(runtime.binding).batch(catalog.map((game, index) => {
      const row = { steam_app_id: index + 1, name: `Synthetic ${index + 1}`, ...game };
      return { sql: `INSERT INTO games (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`, args: Object.values(row) };
    }), "write");
  } finally { await runtime.dispose(); }

  const reported = await run("db-coverage", [...args, "--json"]);
  expect(reported).toMatchObject({ exitCode: 0, stderr: "" });
  const report = JSON.parse(reported.stdout);
  const counts = (items: { key: string; count: number }[]) => Object.fromEntries(items.map(({ key, count }) => [key, count]));
  expect(report).toMatchObject({ scope: "isolated-local", total: 5, endless: 1 });
  expect(counts(report.coverage)).toEqual({
    reviewScore: 4, reviewCount: 3, tags: 3, releaseDate: 3, controllerSupport: 2, gameModes: 2,
    hltbId: 3, hltbMain: 2, valueScore: 1, owned: 1, wishlist: 1, ignored: 1,
  });
  expect(counts(report.blockers)).toEqual({ missingReviews: 2, missingCatalogFacts: 3, missingHltbNonEndless: 2, missingValueScoreNonEndless: 3 });
  expect(report.nextBuckets.map(({ key, count }: { key: string; count: number }) => [key, count])).toEqual([
    ["controllerSupportMissing", 3], ["gameModesMissing", 3], ["reviewsMissing", 2], ["tagsMissing", 2], ["releaseDateMissing", 2],
    ["hltbPending", 1], ["hltbMainMissing", 1], ["valueScorePending", 1],
  ]);

  const text = await run("db-coverage", args);
  expect(text).toMatchObject({ exitCode: 0, stderr: "" });
  expect(text.stdout).toContain("Total games: 5 (1 endless)");
  expect(text.stdout).toMatch(/Release date\s+3\s+60\.0%/);
  expect(text.stdout).toMatch(/Missing Value Score \(non-endless\)\s+3\s+60\.0%/);
  expect(text.stdout).toContain("1. Catalog Facts missing controller support: 3 (scripts/hydrate-controller.ts)");
  expect(text.stdout).toContain("Scope: isolated-local");
});

test("coverage of an empty bootstrapped Game Catalog reports zero counts and nothing pending", async () => {
  const { args } = await bootstrapped();
  const reported = await run("db-coverage", [...args, "--json"]);
  expect(reported.exitCode).toBe(0);
  const report = JSON.parse(reported.stdout);
  expect(report).toMatchObject({ total: 0, endless: 0, nextBuckets: [] });
  expect([...report.coverage, ...report.blockers].every((item: { count: number }) => item.count === 0)).toBe(true);
  const text = await run("db-coverage", args);
  expect(text.stdout).toContain("Nothing pending.");
  expect(text.stdout).not.toContain("NaN");
});

test("coverage rejects an implicit or ambiguous scope and fails closed without application configuration", async () => {
  expect(await run("db-coverage", ["--help"])).toMatchObject({ exitCode: 0, stderr: "", stdout: expect.stringContaining("--local --persist-to") });
  for (const args of [[], ["--json"], ["--remote"], ["--local"], ["--application", "--persist-to", "somewhere"], ["--local", "--application"]]) {
    expect(await run("db-coverage", args)).toMatchObject({ exitCode: 1, stdout: "", stderr: expect.stringContaining("Usage:") });
  }
  expect(await run("db-coverage", ["--application"])).toMatchObject({ exitCode: 1, stdout: "", stderr: expect.stringContaining("NOT_CONFIGURED (not-applied)") });
});
