import { expect, test } from "bun:test";
import { createHttpClient } from "./http";
import { createD1WorkerTestHarness } from "./testing";

async function isolatedNativeRequest() {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    expect((await client.execute("SELECT COUNT(*) AS total FROM games")).rows).toEqual([{ total: 0 }]);
  } finally { await harness.dispose(); }
}

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
