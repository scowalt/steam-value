import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function runMigration(args: string[]) {
  const process = Bun.spawn(["bun", "scripts/db-migrate.ts", ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { PATH: globalThis.process.env.PATH, WRANGLER_SEND_METRICS: "false" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test.each([
  [], ["--remote"], ["--local"], ["--persist-to", "/tmp/not-authorized"],
  ["--local", "--persist-to", "--remote"], ["--local", "--remote", "--persist-to", "/tmp/not-authorized"],
].map((args) => ({ args })))("the operator command rejects missing local opt-in, missing persistence and remote flags: %j", async ({ args }) => {
  expect(await runMigration(args)).toMatchObject({ exitCode: 1, stdout: "", stderr: expect.stringContaining("--local --persist-to <isolated-directory>") });
});

test("the explicit local operator command applies the same immutable history repeatably", async () => {
  const directory = await mkdtemp(join(tmpdir(), "steam-value-d1-operator-"));
  directories.push(directory);
  const args = ["--local", "--persist-to", directory];
  const first = await runMigration(args);
  expect(first.exitCode).toBe(0);
  const initial = JSON.parse(first.stdout);
  expect(initial).toMatchObject({
    scope: "isolated-local", schemaStatus: "provisional-source-schema",
    applied: ["0001_complete_schema.sql", "0002_retain_legacy_metadata.sql"], alreadyApplied: [],
    schemaFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  const repeated = await runMigration(args);
  expect(repeated.exitCode).toBe(0);
  expect(JSON.parse(repeated.stdout)).toEqual({
    ...initial, applied: [], alreadyApplied: ["0001_complete_schema.sql", "0002_retain_legacy_metadata.sql"],
  });
});
