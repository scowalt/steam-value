import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createD1TransferSource, exportSnapshot, inventorySource, openLocalTransferHandle } from "../src/db/transfer";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))); });

async function run(args: string[], script = "scripts/db-transfer.ts") {
  const child = Bun.spawn(["bun", "--no-env-file", script, ...args], {
    stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, WRANGLER_SEND_METRICS: "false" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
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

test("native transfer persistence interoperates with explicit migration reapplication without losing IDs or crossing targets", async () => {
  const parent = await mkdtemp(join(tmpdir(), "steam-value-transfer-persistence-"));
  directories.push(parent);
  const { mkdir } = await import("node:fs/promises");
  const sourceDirectory = join(parent, "source");
  const targetDirectory = join(parent, "target");
  await mkdir(sourceDirectory, { mode: 0o700 });
  await mkdir(targetDirectory, { mode: 0o700 });
  for (const directory of [sourceDirectory, targetDirectory]) {
    expect((await run(["--local", "--persist-to", directory], "scripts/db-migrate.ts")).exitCode).toBe(0);
  }
  async function seedNativeSource() {
    const owner = await openLocalTransferHandle(sourceDirectory);
    try {
      await owner.binding.batch([
        owner.binding.prepare("INSERT INTO games (id,steam_app_id,name,is_owned,created_at,tags) VALUES (700,44,'Persisted ü',1,1700000000,'[\"synthetic\"]')"),
        owner.binding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (900,45,'Deleted allocation')"),
        owner.binding.prepare("DELETE FROM games WHERE id = 900"),
        owner.binding.prepare("INSERT INTO itad_game_map VALUES (999,NULL,1700000000)"),
      ]);
    } finally { await owner.dispose(); }
  }
  await seedNativeSource();
  const reapplied = await run(["--local", "--persist-to", sourceDirectory], "scripts/db-migrate.ts");
  expect(reapplied.exitCode).toBe(0);
  expect(JSON.parse(reapplied.stdout)).toMatchObject({ applied: [], alreadyApplied: ["0001_complete_schema.sql"] });
  const freezeRecord = {
    mode: "frozen-writers" as const, sourceId: "persistent-source", recordId: "synthetic-persistence-freeze", frozenAt: 1700000000,
    evidence: "isolated native source after writer disposal and explicit migration reapplication", writersPaused: ["fixture"], writersDrained: ["fixture"], manualWritersDrained: true as const, holdsUntilRelease: true as const,
  };
  const source = await openLocalTransferHandle(sourceDirectory);
  try {
    const snapshot = await exportSnapshot(createD1TransferSource(source.binding, { id: "persistent-source", freezeRecord }), join(parent, "snapshot"), freezeRecord);
    expect(snapshot.manifest.sequence).toEqual([{ name: "games", seq: 900 }]);
    expect(snapshot.manifest.tables.find((table) => table.name === "games")?.rowCount).toBe(1);
    expect(snapshot.manifest.tables.find((table) => table.name === "itad_game_map")?.rowCount).toBe(1);
    const row = JSON.parse((await Bun.file(join(snapshot.directory, "games.jsonl")).text()).trim());
    expect({ rowid: row.rowid, fields: row.values.slice(0, 3), owned: row.values[15], tags: row.values[28], created: row.values[29] }).toEqual({
      rowid: 700, fields: [["integer",700],["integer",44],["text","Persisted ü"]], owned: ["integer",1], tags: ["text",'["synthetic"]'], created: ["integer",1700000000],
    });
  } finally { await source.dispose(); }
  const target = await openLocalTransferHandle(targetDirectory);
  try {
    const targetFreeze = { ...freezeRecord, sourceId: "persistent-target", recordId: "synthetic-target-freeze", evidence: "isolated target with no application writes" };
    const inventory = await inventorySource(createD1TransferSource(target.binding, { id: "persistent-target", freezeRecord: targetFreeze }));
    expect(inventory.tables.every((table) => table.rowCount === 0)).toBe(true);
    expect(inventory.sequence).toEqual([]);
  } finally { await target.dispose(); }
});
