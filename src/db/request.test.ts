import { afterEach, beforeEach, expect, test } from "bun:test";
import worker from "../worker/index";
import { createHttpClient } from "./http";
import { eq, sql } from "drizzle-orm";
import { games } from "./schema";
import { isRecord, toDbError } from "./access";
import { createD1TestHarness, createD1WorkerTestHarness, type D1WorkerTestHarness } from "./testing";

function external(fetch = dispatch) {
  return createHttpClient({ url: endpoint, token, accessClientId: "synthetic-client-id", accessClientSecret: "synthetic-client-secret", fetch });
}

let token: string;
const endpoint = "https://d1-test.invalid/api/internal/db";
let harness: D1WorkerTestHarness;
beforeEach(async () => {
  harness = await createD1WorkerTestHarness();
  token = harness.clientConfig.token;
});
afterEach(async () => { await harness?.dispose(); });

function request(body: unknown, authorization?: string) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authorization) headers.set("Authorization", authorization);
  return new Request(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
}

function dispatch(req: Request) {
  return harness.fetch(req);
}

const select = { version: 1, op: "execute", statement: { sql: "SELECT 42 AS answer", args: [] } };

test("machine requests preserve projection order and numeric, null and JSON text values on real D1", async () => {
  const response = await dispatch(request({
    version: 1, op: "execute", statement: {
      sql: "SELECT ? AS z_text, ? AS a_number, ? AS nullable, ? AS empty, ? AS zero, json_extract(?, '$.flag') AS flag;",
      args: ['literal ?; and \"quotes\"', 1.25, null, "", 0, '{"flag":true}'],
    },
  }, `Bearer ${token}`));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    version: 1, ok: true, result: {
      columns: ["z_text", "a_number", "nullable", "empty", "zero", "flag"],
      rows: [{ z_text: 'literal ?; and \"quotes\"', a_number: 1.25, nullable: null, empty: "", zero: 0, flag: 1 }],
      rowsAffected: 0,
    },
  });
});

test.each(["First isolated catalog", "Second isolated catalog"])("machine request scenarios have independent Game Catalogs: %s", async (name) => {
  const client = external();
  expect(await client.execute("SELECT COUNT(*) AS total FROM games")).toMatchObject({ rows: [{ total: 0 }] });
  expect(await client.execute({ sql: "INSERT INTO games (steam_app_id, name) VALUES (?, ?) RETURNING steam_app_id, name", args: [60, name] })).toMatchObject({ rows: [{ steam_app_id: 60, name }], rowsAffected: 1 });
});

test("external raw clients send both Access headers and preserve affected rows and RETURNING", async () => {
  const { createHttpClient } = await import("./http");
  const client = createHttpClient({
    url: endpoint, token, accessClientId: "synthetic-client-id", accessClientSecret: "synthetic-client-secret",
    fetch: async (req) => {
      expect(req.headers.get("CF-Access-Client-Id")).toBe("synthetic-client-id");
      expect(req.headers.get("CF-Access-Client-Secret")).toBe("synthetic-client-secret");
      expect(req.redirect).toBe("error");
      return dispatch(req);
    },
  });
  expect(await client.execute({ sql: "INSERT INTO games (steam_app_id, name) VALUES (?, ?) RETURNING name, steam_app_id", args: [21, "Raw Game"] })).toEqual({
    columns: ["name", "steam_app_id"], rows: [{ name: "Raw Game", steam_app_id: 21 }], rowsAffected: 1,
  });
  expect((await client.execute({ sql: "UPDATE games SET name = ? WHERE steam_app_id = ?", args: ["changed", 999] })).rowsAffected).toBe(0);
  expect((await client.execute({ sql: "UPDATE games SET name = ? WHERE steam_app_id = ? RETURNING name", args: ["changed", 21] })).rowsAffected).toBe(1);
  expect(await client.execute("SELECT name FROM games WHERE steam_app_id = 21")).toMatchObject({ rows: [{ name: "changed" }] });
  client.close();
  client.close();
  expect(await client.execute("SELECT name FROM games WHERE steam_app_id = -1")).toEqual({ columns: [], rows: [], rowsAffected: 0 });
});

test("the external raw client runs on native Node TypeScript through the same real Worker request interface", async () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required for the scheduled-client compatibility check");
  const code = `
    import { createInterface } from "node:readline";
    const input = createInterface({ input: process.stdin });
    try {
      const { createHttpClient } = await import("./src/db/http.ts");
      const client = createHttpClient({
        url: ${JSON.stringify(endpoint)}, token: ${JSON.stringify(token)}, accessClientId: "synthetic-id", accessClientSecret: "synthetic-secret",
        fetch: async (request) => {
          const reply = new Promise(resolve => input.once("line", line => resolve(JSON.parse(line))));
          process.stdout.write(JSON.stringify({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() }) + "\\n");
          const response = await reply;
          return new Response(response.body, { status: response.status, headers: response.headers });
        },
      });
      const result = await client.execute({ sql: "SELECT ? AS z_text, ? AS a_number, ? AS nullable", args: ["Node JSON text", 24, null] });
      process.stdout.write(JSON.stringify(result) + "\\n");
    } catch { process.stderr.write("Node client could not complete the isolated request\\n"); process.exitCode = 1; }
    finally { input.close(); }
  `;
  const child = Bun.spawn([node, "--input-type=module", "-e", code], { env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  async function line(): Promise<unknown> {
    while (!pending.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error("Node client exited before completing the isolated request");
      pending += decoder.decode(next.value, { stream: true });
    }
    const end = pending.indexOf("\n");
    const value: unknown = JSON.parse(pending.slice(0, end));
    pending = pending.slice(end + 1);
    return value;
  }
  try {
    const message = await line();
    if (!isRecord(message) || typeof message.url !== "string" || typeof message.method !== "string" || typeof message.body !== "string" || !isRecord(message.headers)) throw new Error("Invalid Node request bridge");
    const headers = new Headers();
    for (const [key, value] of Object.entries(message.headers)) {
      if (typeof value !== "string") throw new Error("Invalid Node request header");
      headers.set(key, value);
    }
    const response = await dispatch(new Request(message.url, { method: message.method, headers, body: message.body }));
    child.stdin.write(JSON.stringify({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() }) + "\n");
    child.stdin.end();
    expect(await line()).toEqual({ columns: ["z_text", "a_number", "nullable"], rows: [{ z_text: "Node JSON text", a_number: 24, nullable: null }], rowsAffected: 0 });
    expect(await child.exited).toBe(0);
  } finally { reader.releaseLock(); if (child.exitCode === null) child.kill(); await child.exited; }
});

test("external atomic batches retain input order and roll back every write on a constraint failure", async () => {
  const client = external();
  const results = await client.batch([
    { sql: "INSERT INTO games (steam_app_id, name) VALUES (?, ?) RETURNING name", args: [22, "before"] },
    "SELECT steam_app_id, name FROM games WHERE steam_app_id = 22",
  ]);
  expect(results).toEqual([
    { columns: ["name"], rows: [{ name: "before" }], rowsAffected: 1 },
    { columns: ["steam_app_id", "name"], rows: [{ steam_app_id: 22, name: "before" }], rowsAffected: 0 },
  ]);
  await expect(client.batch([
    "UPDATE games SET name = 'must-roll-back' WHERE steam_app_id = 22",
    "INSERT INTO games (steam_app_id, name) VALUES (22, 'duplicate')",
  ])).rejects.toMatchObject({ code: "SQL_ERROR", outcome: "rolled-back" });
  expect(await client.batch([
    "SELECT name FROM games WHERE steam_app_id = 22",
    "SELECT steam_app_id FROM games WHERE steam_app_id = 22",
  ], "read")).toEqual([
    { columns: ["name"], rows: [{ name: "before" }], rowsAffected: 0 },
    { columns: ["steam_app_id"], rows: [{ steam_app_id: 22 }], rowsAffected: 0 },
  ]);
  await expect(client.execute("INSERT INTO games (steam_app_id, name) VALUES (22, 'duplicate')")).rejects.toMatchObject({ code: "SQL_ERROR", outcome: "not-applied" });
  expect(await client.batch([])).toEqual([]);
});

test("Drizzle relational reads, reordered projections and RETURNING keep typed booleans, dates and JSON text", async () => {
  const { createDrizzleDb } = await import("./drizzle");
  const raw = external();
  const db = createDrizzleDb(raw);
  const date = new Date("2024-01-02T03:04:05.987Z");
  const inserted = await db.insert(games).values({ steamAppId: 30, name: "Drizzle Game", isOwned: true, isIgnored: null, tags: '["City Builder"]', createdAt: date, updatedAt: null }).returning();
  expect(inserted[0]).toMatchObject({ steamAppId: 30, name: "Drizzle Game", isOwned: true, isIgnored: null, tags: '["City Builder"]', createdAt: new Date("2024-01-02T03:04:05Z"), updatedAt: null });
  expect(await raw.execute("SELECT created_at, updated_at, is_owned, is_ignored, tags FROM games WHERE steam_app_id = 30")).toMatchObject({ rows: [{ created_at: 1704164645, updated_at: null, is_owned: 1, is_ignored: null, tags: '["City Builder"]' }] });
  expect(await db.select({ zName: games.name, aApp: games.steamAppId, owned: games.isOwned }).from(games).where(eq(games.steamAppId, 30))).toEqual([{ zName: "Drizzle Game", aApp: 30, owned: true }]);
  expect(await db.query.games.findFirst({ where: eq(games.steamAppId, 30) })).toMatchObject({ name: "Drizzle Game", isOwned: true, updatedAt: null });
  expect(await db.query.games.findFirst({ where: eq(games.steamAppId, -1) })).toBeUndefined();
  expect(await db.select().from(games).where(eq(games.steamAppId, -1)).get()).toBeUndefined();
  expect(await db.values(sql`SELECT name, steam_app_id FROM games WHERE steam_app_id = ${30}`)).toEqual([["Drizzle Game", 30]]);
  const updated = await db.update(games).set({ isOwned: false }).where(eq(games.steamAppId, 30)).returning({ owned: games.isOwned, updated: games.updatedAt });
  expect(updated[0]?.owned).toBe(false);
  expect(updated[0]?.updated).toBeInstanceOf(Date);
  const run = await db.run(sql`UPDATE games SET name = ${"run"} WHERE steam_app_id = ${30}`);
  expect(run).toMatchObject({ rowsAffected: 1 });
  try {
    await db.insert(games).values({ steamAppId: 30, name: "private-parameter-sentinel" });
    throw new Error("Expected constraint rejection");
  } catch (error) {
    const safe = toDbError(error);
    expect(safe).toMatchObject({ code: "SQL_ERROR", outcome: "not-applied", message: "Database constraint violation" });
    expect(safe.message).not.toContain("private-parameter-sentinel");
    expect(safe.cause).toBeUndefined();
  }
  await expect(db.transaction(async (tx) => { await tx.delete(games); })).rejects.toBeDefined();
  expect(await db.query.games.findFirst({ where: eq(games.steamAppId, 30) })).toMatchObject({ name: "run" });
});

test("result limits never truncate reads or pretend a completed RETURNING write rolled back", async () => {
  const client = external();
  await client.execute("INSERT INTO games (steam_app_id, name) VALUES (32, 'before-large-result')");
  const integers = JSON.stringify(Array.from({ length: 10001 }, (_, i) => i));
  expect((await client.execute({ sql: "SELECT value AS item FROM json_each(?) LIMIT 10000", args: [integers] })).rows).toHaveLength(10000);
  await expect(client.execute({ sql: "SELECT value AS item FROM json_each(?)", args: [integers] })).rejects.toMatchObject({ code: "RESULT_LIMIT", outcome: "not-applied" });
  await expect(client.execute("SELECT hex(zeroblob(500001)) AS oversized")).rejects.toMatchObject({ code: "RESULT_LIMIT", outcome: "not-applied" });
  await expect(client.execute({ sql: "INSERT INTO games (steam_app_id, name) SELECT 100000 + value, 'bulk' FROM json_each(?) RETURNING steam_app_id", args: [integers] })).rejects.toMatchObject({ code: "RESULT_LIMIT", outcome: "committed" });
  expect(await client.execute("SELECT COUNT(*) AS total FROM games WHERE steam_app_id >= 100000")).toMatchObject({ rows: [{ total: 10001 }] });
  await expect(client.batch([
    "UPDATE games SET name = 'large-result-committed' WHERE steam_app_id = 32",
    ...Array.from({ length: 10 }, () => "SELECT hex(zeroblob(450000)) AS payload"),
  ])).rejects.toMatchObject({ code: "RESULT_LIMIT", outcome: "committed" });
  expect(await client.execute("SELECT name FROM games WHERE steam_app_id = 32")).toMatchObject({ rows: [{ name: "large-result-committed" }] });
  await client.execute("DELETE FROM games WHERE steam_app_id >= 100000");
});

test("lost or untrustworthy replies expose unknown writes without replay or unsafe diagnostics", async () => {
  const client = external();
  await client.execute("INSERT INTO games (steam_app_id, name) VALUES (40, '0')");
  const faults: ((req: Request, response: Response) => Promise<Response>)[] = [
    async () => { throw new Error("private-transport-sentinel with credentials and SQL"); },
    async () => new Response("private-body-sentinel", { status: 502, headers: { "Content-Type": "text/html" } }),
    async () => Response.redirect("https://login.test/", 302),
    async () => new Response('{"version":1,"ok":true,', { headers: { "Content-Type": "application/json" } }),
    async (req) => Response.json({ version: 2, ok: true, requestId: req.headers.get("X-Steam-Value-Request-Id"), result: {} }),
    async (req) => Response.json({ version: 1, ok: true, requestId: req.headers.get("X-Steam-Value-Request-Id"), result: { columns: ["name"], rows: [{ name: true }], rowsAffected: 1 } }),
    async (req) => Response.json({ version: 1, ok: true, requestId: req.headers.get("X-Steam-Value-Request-Id"), result: { columns: ["name", "name"], rows: [{ name: "1" }], rowsAffected: 1 } }),
    async (req) => Response.json({ version: 1, ok: true, requestId: req.headers.get("X-Steam-Value-Request-Id"), result: { columns: ["name"], rows: [{ name: "1", extra: "private" }], rowsAffected: 1 } }),
    async (req) => Response.json({ version: 1, ok: true, requestId: req.headers.get("X-Steam-Value-Request-Id"), result: { columns: ["name"], rows: [{ name: "1" }], rowsAffected: -1 } }),
    async (_req, response) => {
      const body: unknown = await response.json();
      if (!isRecord(body)) throw new Error("Expected a Worker envelope");
      return Response.json({ ...body, secretField: "private-envelope-sentinel" });
    },
  ];
  for (const fault of faults) {
    await client.execute("UPDATE games SET name = '0' WHERE steam_app_id = 40");
    const broken = external(async (req) => fault(req, await dispatch(req)));
    try {
      await broken.execute("UPDATE games SET name = CAST(CAST(name AS INTEGER) + 1 AS TEXT) WHERE steam_app_id = 40 RETURNING name");
      throw new Error("Expected an unknown outcome");
    } catch (error) {
      const safe = toDbError(error);
      expect(safe).toMatchObject({ code: "OUTCOME_UNKNOWN", outcome: "unknown" });
      expect(safe.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(safe.message).not.toContain("private");
      expect(safe.cause).toBeUndefined();
    }
    expect(await client.execute("SELECT name FROM games WHERE steam_app_id = 40")).toMatchObject({ rows: [{ name: "1" }] });
  }
  const readFailure = external(async (req) => { await dispatch(req); throw new Error("private-read-sentinel"); });
  await expect(readFailure.execute("SELECT name FROM games WHERE steam_app_id = 40")).rejects.toMatchObject({ code: "TRANSPORT_ERROR", outcome: "not-applied" });
  const partialRead = external(async (req) => {
    await dispatch(req);
    return Response.json({ version: 1, ok: true, requestId: req.headers.get("X-Steam-Value-Request-Id"), results: [] });
  });
  await expect(partialRead.batch(["SELECT 1 AS one", "SELECT 2 AS two"], "read")).rejects.toMatchObject({ code: "PROTOCOL_ERROR", outcome: "not-applied" });
});

test("schema errors stay recognizable and Drizzle-wrapped unknown outcomes keep only safe diagnostics", async () => {
  const empty = await createD1WorkerTestHarness({ bootstrap: false });
  try {
    const unbootstrapped = createHttpClient(empty.clientConfig);
    await expect(unbootstrapped.execute("SELECT last_error FROM sync_state")).rejects.toMatchObject({ code: "SQL_ERROR", outcome: "not-applied", message: "no such table: sync_state" });
    await expect(unbootstrapped.execute("SELECT name FROM games")).rejects.toMatchObject({ code: "SQL_ERROR", outcome: "not-applied", message: "no such table: games" });
  } finally { await empty.dispose(); }
  await expect(external().execute("SELECT private_column_sentinel FROM games")).rejects.toMatchObject({ code: "SQL_ERROR", message: "Database SQL syntax error" });
  const { createDrizzleDb } = await import("./drizzle");
  await external().execute("INSERT INTO games (steam_app_id, name) VALUES (45, 'before-lost-reply')");
  const db = createDrizzleDb(external(async (req) => { await dispatch(req); throw new Error("private-transport-sentinel"); }));
  try {
    await db.update(games).set({ name: "private-parameter-sentinel" }).where(eq(games.steamAppId, 45));
    throw new Error("Expected an unknown outcome");
  } catch (error) {
    const safe = toDbError(error);
    expect(safe).toMatchObject({ code: "OUTCOME_UNKNOWN", outcome: "unknown" });
    expect(safe.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(safe.message).not.toContain("private");
    expect(safe.cause).toBeUndefined();
  }
  expect(await external().execute("SELECT name FROM games WHERE steam_app_id = 45")).toMatchObject({ rows: [{ name: "private-parameter-sentinel" }] });
});

test("grouped read batches remain consistent during concurrent native writes", async () => {
  const client = external();
  await client.execute("INSERT INTO games (steam_app_id, name) VALUES (41, '0')");
  await client.execute("INSERT INTO games (steam_app_id, name) VALUES (42, '0')");
  const writer = async () => {
    for (let i = 0; i < 30; i++) await client.batch([
      "UPDATE games SET name = CAST(CAST(name AS INTEGER) + 1 AS TEXT) WHERE steam_app_id = 41",
      "UPDATE games SET name = CAST(CAST(name AS INTEGER) + 1 AS TEXT) WHERE steam_app_id = 42",
    ]);
  };
  const reader = async () => {
    for (let i = 0; i < 30; i++) {
      const snapshot = await client.batch(Array.from({ length: 20 }, (_, index) => `SELECT name FROM games WHERE steam_app_id = ${index % 2 === 0 ? 41 : 42}`), "read");
      const values = snapshot.map((result) => result.rows[0]?.name);
      expect(new Set(values).size).toBe(1);
    }
  };
  await Promise.all([writer(), reader()]);
  expect(await client.execute("SELECT name FROM games WHERE steam_app_id IN (41, 42) ORDER BY steam_app_id")).toMatchObject({ rows: [{ name: "30" }, { name: "30" }] });
});

test("a request deadline exposes an unknown committed write without cancellation or replay", async () => {
  const client = external();
  await client.execute("INSERT INTO games (steam_app_id, name) VALUES (43, '0')");
  const delayed = external(async (req) => {
    await dispatch(req);
    return new Response(new ReadableStream<Uint8Array>(), { headers: { "Content-Type": "application/json" } });
  });
  await expect(delayed.execute("UPDATE games SET name = CAST(CAST(name AS INTEGER) + 1 AS TEXT) WHERE steam_app_id = 43")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", outcome: "unknown" });
  expect(await client.execute("SELECT name FROM games WHERE steam_app_id = 43")).toMatchObject({ rows: [{ name: "1" }] });
}, 60000);

test("unauthorized writes do not mutate state and correlation only echoes valid UUIDs", async () => {
  const client = external();
  const body = { version: 1, op: "execute", statement: { sql: "INSERT INTO games (steam_app_id, name) VALUES (44, 'unauthorized')", args: [] } };
  for (const authorization of [undefined, "Bearer wrong", `Bearer ${token}wrong-length`, "Basic viewer"]) {
    const req = request(body, authorization);
    req.headers.set("X-Steam-Value-Request-Id", "private-correlation-sentinel");
    const response = await dispatch(req);
    expect(response.status).toBe(401);
    const error: unknown = await response.json();
    expect(JSON.stringify(error)).not.toContain("private-correlation-sentinel");
  }
  expect(await client.execute("SELECT name FROM games WHERE steam_app_id = 44")).toMatchObject({ rows: [] });
  const req = request(select, `Bearer ${token}`);
  const id = crypto.randomUUID();
  req.headers.set("X-Steam-Value-Request-Id", id);
  expect(await (await dispatch(req)).json()).toMatchObject({ requestId: id });
});

test("SQL-aware validation ignores literal delimiters but rejects extension and CTE execution", async () => {
  const client = external();
  expect(await client.execute("SELECT 'semi; ?' AS [z?;], 'it''s ?;' AS \"a?;\", 1 AS `b;?` /* ?; ignored */; -- ?; ignored\n")).toEqual({
    columns: ["z?;", "a?;", "b;?"], rows: [{ "z?;": "semi; ?", "a?;": "it's ?;", "b;?": 1 }], rowsAffected: 0,
  });
  for (const sql of ["SELECT load_extension('private-extension')", "SELECT \"load_extension\"('private-extension')", "SELECT * FROM `pragma_table_info`('games')", "SELECT * FROM pragma_table_info('games')", "SELECT * FROM (WITH c AS (SELECT 1) SELECT * FROM c)"]) {
    const response = await dispatch(request({ ...select, statement: { sql, args: [] } }, `Bearer ${token}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST", outcome: "not-applied" } });
  }
});

test("external configuration requires four explicit application keys and an exact credential-free HTTPS endpoint", async () => {
  const { createExternalClient } = await import("./http");
  const env = {
    STEAM_VALUE_DB_URL: endpoint, STEAM_VALUE_DB_TOKEN: token,
    STEAM_VALUE_ACCESS_CLIENT_ID: "synthetic-client-id", STEAM_VALUE_ACCESS_CLIENT_SECRET: "synthetic-client-secret",
    TURSO_DATABASE_URL: "must-not-be-used", CLOUDFLARE_API_TOKEN: "must-not-be-used",
  };
  for (const key of ["STEAM_VALUE_DB_URL", "STEAM_VALUE_DB_TOKEN", "STEAM_VALUE_ACCESS_CLIENT_ID", "STEAM_VALUE_ACCESS_CLIENT_SECRET"]) {
    expect(() => createExternalClient({ ...env, [key]: "" })).toThrow("Database access is not configured");
  }
  expect(() => createHttpClient({ url: endpoint, token, accessClientId: "id", accessClientSecret: "☃-synthetic", fetch: dispatch })).toThrow("Database access is not configured");
  const valid = createExternalClient(env);
  expect(await valid.batch([])).toEqual([]);
  valid.close();
  for (const url of ["http://steam-value.test/api/internal/db", "https://user:secret@steam-value.test/api/internal/db", `${endpoint}/`, `${endpoint}?database=other`, `${endpoint}?`, `${endpoint}#`, "https://steam-value.test/api/games"]) {
    expect(() => createHttpClient({ url, token, accessClientId: "id", accessClientSecret: "secret", fetch: dispatch })).toThrow("Database access is not configured");
  }
});

test("request bounds include every bind and actual UTF-8 bytes without splitting atomic groups", async () => {
  const client = external();
  const hundred = { sql: `SELECT ${Array.from({ length: 100 }, () => "?").join(" + ")} AS total`, args: Array.from({ length: 100 }, () => 1) };
  expect(await client.execute(hundred)).toMatchObject({ rows: [{ total: 100 }] });
  const base = "SELECT 1 AS boundary";
  expect(await client.execute(base + " ".repeat(96000 - base.length))).toMatchObject({ rows: [{ boundary: 1 }] });
  expect((await client.execute({ sql: "SELECT ? AS text", args: ["é".repeat(500000)] })).rows[0]?.text).toHaveLength(500000);
  expect(await client.batch(Array.from({ length: 400 }, () => "SELECT 1 AS boundary"), "read")).toHaveLength(400);
  const oversized = [
    { ...select, statement: { sql: hundred.sql.replace(" AS total", " + ? AS total"), args: [...hundred.args, 1] } },
    { ...select, statement: { sql: base + " ".repeat(95999 - base.length) + "é", args: [] } },
    { ...select, statement: { sql: "SELECT ? AS too_wide", args: ["é".repeat(500001)] } },
    { version: 1, op: "batch", mode: "read", statements: Array.from({ length: 401 }, () => select.statement) },
  ];
  for (const body of oversized) {
    const response = await dispatch(request(body, `Bearer ${token}`));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "LIMIT_EXCEEDED", outcome: "not-applied" } });
  }
  const body = JSON.stringify({ version: 1, op: "batch", mode: "write", statements: [
    { sql: "INSERT INTO games (steam_app_id, name) VALUES (29, 'reject-entire-group')", args: [] },
    ...Array.from({ length: 5 }, () => ({ sql: "SELECT ? AS payload", args: ["x".repeat(900000)] })),
  ] });
  const bytes = new TextEncoder().encode(body);
  const streamedProbe = await createD1TestHarness(worker.fetch);
  try {
    const streamed = new Request(endpoint, {
      method: "POST", headers: { "Authorization": `Bearer ${streamedProbe.clientConfig.token}`, "Content-Type": "application/json", "Content-Length": "1" },
      body: new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 32768) controller.enqueue(bytes.slice(i, i + 32768)); controller.close(); } }),
    });
    const response = await streamedProbe.fetch(streamed);
    expect(response.status).toBe(413);
    expect(await createHttpClient(streamedProbe.clientConfig).execute("SELECT name FROM games WHERE steam_app_id = 29")).toMatchObject({ rows: [] });
  } finally { await streamedProbe.dispose(); }
  expect(await client.execute("SELECT name FROM games WHERE steam_app_id = 29")).toMatchObject({ rows: [] });
});

test("invalid SQL, binds and wire selectors reject the whole operation without writes", async () => {
  const statement = { sql: "INSERT INTO games (steam_app_id, name) VALUES (?, ?)", args: [20, "must-not-be-inserted"] };
  const invalid = [
    { ...select, databaseId: "other" },
    { ...select, statement: { ...select.statement, account: "other" } },
    { ...select, statement: { sql: "SELECT :named", args: [1] } },
    { ...select, statement: { sql: "SELECT ?1 AS numbered", args: [1] } },
    { ...select, statement: { sql: "SELECT ? AS mismatch", args: [] } },
    { ...select, statement: { sql: "SELECT ? AS flag", args: [true] } },
    { ...select, statement: { sql: "SELECT ? AS missing", args: null } },
    { ...select, statement: { sql: "SELECT ? AS unsafe", args: [9007199254740992] } },
    { ...select, statement: { sql: "SELECT 1; DELETE FROM games", args: [] } },
    { ...select, statement: { sql: "PRAGMA user_version", args: [] } },
    { ...select, statement: { sql: "WITH x AS (SELECT 1) SELECT * FROM x", args: [] } },
    { ...select, statement: { sql: "BEGIN", args: [] } },
    { version: 1, op: "batch", mode: "write", statements: [statement, { sql: "CREATE TABLE forbidden (id INTEGER)", args: [] }] },
    { version: 1, op: "batch", mode: "read", statements: [statement] },
    { version: 1, op: "batch", mode: "write", statements: [] },
  ];
  for (const body of invalid) {
    const response = await dispatch(request(body, `Bearer ${token}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", outcome: "not-applied" } });
  }
  const response = await dispatch(request({ ...select, statement: { sql: "SELECT name FROM games WHERE steam_app_id = ?", args: [20] } }, `Bearer ${token}`));
  expect(await response.json()).toMatchObject({ ok: true, result: { columns: [], rows: [], rowsAffected: 0 } });
});

test("machine authorization precedes parsing and binding checks; methods, paths and media fail closed", async () => {
  const env = { STEAM_VALUE_DB_TOKEN: token };
  const malformed = () => new Request(endpoint, { method: "POST", headers: { "Authorization": "Bearer wrong", "Content-Type": "application/json" }, body: "not-json" });
  expect((await worker.fetch(malformed(), env)).status).toBe(401);
  const configuredAuth = malformed();
  configuredAuth.headers.set("Authorization", `Bearer ${token}`);
  expect((await worker.fetch(configuredAuth, env)).status).toBe(503);
  const missingToken = await createD1TestHarness((req, env) => worker.fetch(req, { DB: env.DB }));
  try {
    expect((await missingToken.fetch(request(select, `Bearer ${missingToken.clientConfig.token}`))).status).toBe(503);
  } finally { await missingToken.dispose(); }
  const invalid = [
    new Request(endpoint, { method: "GET", headers: { "Authorization": `Bearer ${token}` } }),
    new Request(endpoint, { method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "text/plain" }, body: JSON.stringify(select) }),
    new Request(endpoint, { method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: JSON.stringify(select) }),
    new Request(endpoint, { method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }, body: "not-json" }),
  ];
  for (const [i, req] of invalid.entries()) {
    const response = await dispatch(req);
    expect(response.status).toBe([405, 415, 415, 400][i]!);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST", outcome: "not-applied" } });
  }
  for (const path of ["/api/internal/db/", "/api/internal/%64b", "/api/internal/db/other"]) {
    expect((await dispatch(new Request(`https://d1-test.invalid${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(select) }))).status).toBe(404);
  }
});

test("viewer authentication cannot authorize the machine database endpoint", async () => {
  const req = request(select);
  req.headers.set("Cookie", "CF_Authorization=synthetic-viewer-session");
  req.headers.set("CF-Access-Jwt-Assertion", "synthetic-viewer-jwt");
  req.headers.set("CF-Access-Client-Id", "synthetic-client-id");
  req.headers.set("CF-Access-Client-Secret", "synthetic-client-secret");
  const response = await dispatch(req);
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ version: 1, ok: false, error: { code: "UNAUTHORIZED", outcome: "not-applied" } });
});
