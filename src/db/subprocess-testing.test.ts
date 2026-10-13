import { expect, test } from "bun:test";
import { createHttpClient } from "./http";
import { createD1WorkerTestHarness } from "./testing";
import { createSubprocessBridge } from "./subprocess-testing";
import { isRecord } from "./access";

test("prefixed fragmented Unicode requests and noisy stderr preserve native client results and process completion", async () => {
  const harness = await createD1WorkerTestHarness();
  const prefix = "synthetic-framed-request:";
  const name = "Café 🎮 ".repeat(12_000);
  try {
    const code = `
      import { createInterface } from "node:readline";
      import { createHttpClient } from "./src/db/http.ts";
      const input = createInterface({ input: process.stdin });
      try {
        await new Promise(resolve => process.stderr.write("Synthetic stderr only. ".repeat(8000), resolve));
        process.stdout.write("Synthetic unframed output\\n");
        const client = createHttpClient({
          url: ${JSON.stringify(harness.clientConfig.url)}, token: ${JSON.stringify(harness.clientConfig.token)}, accessClientId: "synthetic-id", accessClientSecret: "synthetic-secret",
          fetch: async request => {
            const reply = new Promise(resolve => input.once("line", line => resolve(JSON.parse(line))));
            const frame = new TextEncoder().encode(${JSON.stringify(prefix)} + JSON.stringify({ kind: "request", url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() }) + "\\n");
            for (let start = 0; start < frame.length; start += 4093) process.stdout.write(frame.subarray(start, start + 4093));
            const response = await reply;
            return new Response(response.body, { status: response.status, headers: response.headers });
          },
        });
        const result = await client.execute({ sql: "INSERT INTO games (steam_app_id, name) VALUES (?, ?) RETURNING steam_app_id, name", args: [987, "Café 🎮 ".repeat(12_000)] });
        process.stdout.write(${JSON.stringify(prefix)} + JSON.stringify({ kind: "result", result }) + "\\n");
      } finally { input.close(); }
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", code], { env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const bridge = createSubprocessBridge(child, (request) => harness.fetch(request), prefix);
    try {
      for (;;) {
        const message = await bridge.read();
        if (!isRecord(message)) throw new Error("Invalid synthetic result frame");
        if (message.kind === "result") {
          expect(message.result).toEqual({ columns: ["steam_app_id", "name"], rows: [{ steam_app_id: 987, name }], rowsAffected: 1 });
          break;
        }
        if (message.kind !== "request") throw new Error("Unexpected synthetic result frame");
        await bridge.forward(message);
      }
      bridge.end();
      expect(await child.exited).toBe(0);
      expect((await createHttpClient(harness.clientConfig).execute("SELECT name FROM games WHERE steam_app_id=987")).rows).toEqual([{ name }]);
    } finally { await bridge.dispose(); }
  } finally { await harness.dispose(); }
});
