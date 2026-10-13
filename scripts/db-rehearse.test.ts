import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./db-rehearse";

test("synthetic rehearsal refuses implicit or remote scope before creating artifacts", async () => {
  const parent = await mkdtemp(join(tmpdir(), "steam-value-rehearsal-test-"));
  const destination = join(parent, "evidence");
  try {
    for (const argv of [[], ["--destination", destination], ["--remote", "--destination", destination], ["--local"]]) {
      await expect(main(argv)).rejects.toThrow("Usage: db:rehearse --local --destination <new-private-directory>");
    }
    expect(await Bun.file(join(destination, "inventory.json")).exists()).toBe(false);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("synthetic all-table rehearsal validates imported native consumers and preserves post-cutover changes in a fresh recovery restore", async () => {
  const parent = await mkdtemp(join(tmpdir(), "steam-value-rehearsal-test-"));
  const destination = join(parent, "evidence");
  try {
    const report = await main(["--local", "--destination", destination]);
    const baselineRows = { __drizzle_migrations: 0, catalog_refresh_failures: 1, catalog_refresh_state: 1, deal_refresh_state: 2, game_deal_cache: 1001, games: 500, itad_game_map: 501, sync_state: 3 };
    expect(report).toMatchObject({
      scope: "isolated-local", schemaStatus: "provisional-source-schema",
      baseline: { status: "validated", tableRows: baselineRows, highWater: 900 },
      recovery: { status: "reconciliation-required", automaticReversion: false, sequenceChanged: true, delta: {
        games: { added: 1, deleted: 0, changed: 500 }, catalog_refresh_failures: { added: 0, deleted: 0, changed: 1 },
      } },
      restore: { status: "validated", tableRows: { ...baselineRows, games: 501 }, highWater: 1106 },
    });
    expect(await Bun.file(join(destination, "summary.json")).json()).toEqual(report);
    for (const file of ["import.json", "restore.json"]) {
      expect(await Bun.file(join(destination, file)).json()).toMatchObject({ status: "validated" });
    }
    expect(await Bun.file(join(destination, "recovery", "rollback-receipt.json")).json()).toMatchObject({ status: "reconciliation-required", automaticReversion: false });
    for (const directory of [destination, join(destination, "baseline"), join(destination, "recovery")]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const name of await readdir(directory, { withFileTypes: true })) {
        if (name.isFile()) expect((await stat(join(directory, name.name))).mode & 0o777).toBe(0o600);
      }
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
}, 30_000);
