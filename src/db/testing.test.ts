import { expect, test } from "bun:test";
import { createHttpClient } from "./http";
import { createD1WorkerTestHarness } from "./testing";
import { createLocalD1 } from "./local-d1";
import { applyMigrations, loadMigrations } from "./migrations";

async function isolatedNativeRequest() {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    expect((await client.execute("SELECT COUNT(*) AS total FROM games")).rows).toEqual([{ total: 0 }]);
  } finally { await harness.dispose(); }
}

async function isolatedNativeOperator() {
  const owner = await createLocalD1({ databaseNames: ["SECONDARY"] });
  try {
    const binding = owner.binding;
    expect((await binding.prepare("SELECT name FROM sqlite_schema WHERE name IN ('games','steam_value_migrations')").all()).results).toEqual([]);
    expect((await applyMigrations(binding, await loadMigrations())).applied).toEqual(["0001_complete_schema.sql"]);
    const other = await owner.getBinding("SECONDARY");
    expect((await other.prepare("SELECT name FROM sqlite_schema WHERE name IN ('games','steam_value_migrations')").all()).results).toEqual([]);
    await expect(owner.getBinding("NOT_DECLARED")).rejects.toThrow("Local D1 binding is unavailable");
  } finally { await owner.dispose(); await owner.dispose(); }
}

test("disposing a native operator owner preserves explicit bootstrap, isolation and subsequent operator process exits", async () => {
  await isolatedNativeOperator();
  for (let operation = 0; operation < 10; operation++) {
    const child = Bun.spawn([process.execPath, "--no-env-file", "scripts/db-migrate.ts", "--remote"], {
      stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, WRANGLER_SEND_METRICS: "false" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: "", stderr: "Usage: bun scripts/db-migrate.ts --local --persist-to <isolated-directory>\n", exitCode: 1,
    });
  }
});

test("disposing a native D1 fixture leaves later isolated operator processes able to report output and exit", async () => {
  await isolatedNativeRequest();
  for (let operation = 0; operation < 10; operation++) {
    const child = Bun.spawn([process.execPath, "--no-env-file", "scripts/db-migrate.ts", "--remote"], {
      stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, WRANGLER_SEND_METRICS: "false" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: "", stderr: "Usage: bun scripts/db-migrate.ts --local --persist-to <isolated-directory>\n", exitCode: 1,
    });
  }
});
