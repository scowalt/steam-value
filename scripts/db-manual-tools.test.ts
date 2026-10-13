import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMigration } from "../src/db/admin";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "steam-value-d1-manual-tools-"));
  directories.push(directory);
  return directory;
}
async function run(script: string, args: string[]) {
  const child = Bun.spawn(["bun", "--no-env-file", `scripts/${script}.ts`, ...args], {
    stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, WRANGLER_SEND_METRICS: "false" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

test("the historical setup entrypoint explicitly bootstraps all seven tables with the immutable local operator receipt", async () => {
  expect(await run("setup-worker-db", ["--help"])).toMatchObject({ exitCode: 0, stderr: "", stdout: expect.stringContaining("--local --persist-to") });
  const args = ["--local", "--persist-to", await scratch()];
  const first = await run("setup-worker-db", args);
  expect(first.exitCode).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ scope: "isolated-local", applied: ["0001_complete_schema.sql", "0002_retain_legacy_metadata.sql"] });
  const second = await run("setup-worker-db", args);
  expect(second.exitCode).toBe(0);
  expect(JSON.parse(second.stdout)).toMatchObject({ applied: [], alreadyApplied: ["0001_complete_schema.sql", "0002_retain_legacy_metadata.sql"] });
});

test("offline generation appends a validated immutable D1 migration without credentials or modifying prior history", async () => {
  const directory = await scratch();
  const history = join(directory, "migrations");
  const original = await Bun.file("migrations/0001_complete_schema.sql").text();
  await Bun.write(join(history, "0001_complete_schema.sql"), original);
  const sqlFile = join(directory, "candidate.sql");
  const candidate = "ALTER TABLE games ADD COLUMN operator_check TEXT;\n";
  await Bun.write(sqlFile, candidate);
  const generated = await run("db-generate", ["--name", "operator_check", "--sql-file", sqlFile, "--migrations-dir", history]);
  expect(generated.exitCode).toBe(0);
  expect(JSON.parse(generated.stdout)).toMatchObject({ scope: "disposable-validation", migrationId: "0002_operator_check.sql", schemaFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await Bun.file(join(history, "0002_operator_check.sql")).text()).toBe(candidate);
  expect(await Bun.file(join(history, "0001_complete_schema.sql")).text()).toBe(original);
  await Bun.write(sqlFile, "ALTER TABLE missing_table ADD COLUMN private_parameter TEXT;");
  const invalid = await run("db-generate", ["--name", "invalid_candidate", "--sql-file", sqlFile, "--migrations-dir", history]);
  expect(invalid.stderr.includes("private_parameter")).toBe(false);
  expect(invalid).toMatchObject({ exitCode: 1, stdout: "", stderr: expect.stringContaining("MIGRATION_FAILED") });
  expect(await Bun.file(join(history, "0003_invalid_candidate.sql")).exists()).toBe(false);
});

test("explicit local inspection shows the complete schema, indexes and bounded samples without implicit bootstrap", async () => {
  const directory = await scratch();
  const args = ["--local", "--persist-to", directory];
  expect((await run("db-inspect", args)).exitCode).toBe(1);
  expect((await run("setup-worker-db", args)).exitCode).toBe(0);
  const inspected = await run("db-inspect", [...args, "--table", "games", "--limit", "50"]);
  expect(inspected.exitCode).toBe(0);
  const report = JSON.parse(inspected.stdout);
  expect(report.scope).toBe("isolated-local");
  expect(report.tables.map((table: { name: string }) => table.name)).toEqual(["games", "sync_state", "catalog_refresh_state", "catalog_refresh_failures", "itad_game_map", "game_deal_cache", "deal_refresh_state"]);
  expect(report.tables.every((table: { rowCount: number }) => table.rowCount === 0)).toBe(true);
  expect(report.schemaObjects.some((object: { name: string }) => object.name === "idx_games_browse_default")).toBe(true);
  expect(report.sample).toMatchObject({ table: "games", limit: 50, offset: 0, rows: [] });
});

test.each(["setup-worker-db", "db-generate", "db-inspect"])("%s rejects implicit remote operator actions before opening a database", async (script) => {
  expect(await run(script, ["--remote"])).toMatchObject({ exitCode: 1, stdout: "", stderr: expect.stringContaining("Usage:") });
});

test("application inspection fails closed without its application/Access configuration", async () => {
  expect(await run("db-inspect", ["--application"])).toMatchObject({ exitCode: 1, stdout: "", stderr: expect.stringContaining("NOT_CONFIGURED (not-applied)") });
});

test("completed direct D1 generation leaves later operator processes able to report output and exit", async () => {
  const directory = await scratch();
  const history = join(directory, "migrations");
  await Bun.write(join(history, "0001_complete_schema.sql"), await Bun.file("migrations/0001_complete_schema.sql").text());
  expect((await generateMigration("ownership_check", "ALTER TABLE games ADD COLUMN ownership_check TEXT;", history)).migrationId).toBe("0002_ownership_check.sql");
  for (let operation = 0; operation < 10; operation++) {
    expect(await run("db-migrate", ["--remote"])).toEqual({
      exitCode: 1, stdout: "", stderr: "Usage: bun scripts/db-migrate.ts --local --persist-to <isolated-directory>\n",
    });
  }
});
