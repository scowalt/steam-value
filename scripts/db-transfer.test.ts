import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))); });

async function run(args: string[], script = "scripts/db-transfer.ts") {
  const child = Bun.spawnSync(["bun", "--no-env-file", script, ...args], {
    stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, WRANGLER_SEND_METRICS: "false" },
  });
  return { stdout: child.stdout.toString(), stderr: child.stderr.toString(), exitCode: child.exitCode };
}

test("transfer CLI is local-only and rejects implicit, remote, reset and credential arguments without echoing values", async () => {
  for (const args of [[], ["--help", "--remote"], ["inventory"], ["inventory", "--remote"], ["import", "--local", "--reset"], ["export", "--token", "synthetic-not-a-secret"]]) {
    const result = await run(args);
    expect(result.stderr.includes("synthetic-not-a-secret")).toBe(false);
    expect(result).toMatchObject({ exitCode: 1, stdout: "", stderr: expect.stringContaining("Usage:") });
  }
  expect(await run(["--help"])).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("prepare-rollback"), stderr: "" });
});

test("explicit CLI inventory/export/import uses checksum bootstrap and protected receipts on separately selected local databases", async () => {
  const parent = await mkdtemp(join(tmpdir(), "steam-value-transfer-cli-"));
  directories.push(parent);
  const sourceDirectory = join(parent, "source");
  const targetDirectory = join(parent, "target");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(sourceDirectory, { mode: 0o700 });
  await mkdir(targetDirectory, { mode: 0o700 });
  for (const persistTo of [sourceDirectory, targetDirectory]) expect((await run(["--local", "--persist-to", persistTo], "scripts/db-migrate.ts")).exitCode).toBe(0);
  const freezeFile = join(parent, "freeze.json");
  await writeFile(freezeFile, JSON.stringify({ mode: "frozen-writers", sourceId: "cli-source", recordId: "synthetic-local-freeze", frozenAt: 1700000000, evidence: "isolated synthetic CLI database", writersPaused: ["fixture"], writersDrained: ["fixture"], manualWritersDrained: true, holdsUntilRelease: true }), { mode: 0o600 });
  const common = ["--local", "--persist-to", sourceDirectory, "--id", "cli-source", "--freeze-record", freezeFile];
  const inventoryDirectory = join(parent, "inventory");
  const inventory = await run(["inventory", ...common, "--destination", inventoryDirectory]);
  expect(inventory).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(inventory.stdout)).toMatchObject({ scope: "isolated-local", operation: "inventory", status: "complete" });
  expect(JSON.parse(await Bun.file(join(inventoryDirectory, "inventory.json")).text()).schema.tables).toHaveLength(7);
  const snapshotDirectory = join(parent, "snapshot");
  expect(await run(["export", ...common, "--destination", snapshotDirectory])).toMatchObject({ exitCode: 0, stderr: "" });
  const receipt = join(parent, "import.json");
  const targetArgs = common.map((value) => value === sourceDirectory ? targetDirectory : value);
  expect(await run(["import", ...targetArgs, "--snapshot", snapshotDirectory, "--receipt", receipt, "--intent", "staging"])).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(await Bun.file(receipt).text())).toMatchObject({ status: "imported", writeOutcome: "imported" });
  expect(await run(["validate", ...targetArgs, "--snapshot", snapshotDirectory, "--receipt", receipt])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("BEHAVIOR_REQUIRED") });
  expect(JSON.parse(await Bun.file(receipt).text())).toMatchObject({ status: "imported", validation: { status: "failed" } });
}, 15000);
