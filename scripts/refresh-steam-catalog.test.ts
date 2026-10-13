import { describe, expect, test } from "bun:test";
import { createHttpClient } from "../src/db/http";
import type { DbWireRequest } from "../src/db/access";
import { createD1WorkerTestHarness, type D1WorkerTestHarness } from "../src/db/testing";
import { createSteamCatalogProvider, main, parseArgs, planCatalogChange, toCatalogRow } from "./refresh-steam-catalog";

const localArgs = ["--review-delay-ms", "0", "--app-list-delay-ms", "0", "--retry-delay-ms", "0"];

function steamFixture(apps: { appid: number; name: string; positive: number; reviews: number }[]) {
  return {
    async fetchAppList(_options: unknown, startAfterAppId: number) {
      return apps.filter((app) => app.appid > startAfterAppId);
    },
    async fetchReviewSummary(app: { appid: number }) {
      const fixture = apps.find((entry) => entry.appid === app.appid);
      if (!fixture) throw new Error("Missing deterministic Steam review fixture");
      return { totalPositive: fixture.positive, totalNegative: fixture.reviews - fixture.positive, totalReviews: fixture.reviews };
    },
  };
}

function faultClient(harness: D1WorkerTestHarness, matches: (body: DbWireRequest) => boolean, outcome: "unknown" | "committed" | "rolled-back") {
  return createHttpClient({
    ...harness.clientConfig,
    fetch: async (request) => {
      const text = await request.text();
      const body: DbWireRequest = JSON.parse(text);
      const faulted = matches(body);
      if (faulted && outcome === "committed") {
        const statements = body.op === "execute" ? [body.statement] : body.statements;
        statements[0]!.sql += " RETURNING hex(zeroblob(500001)) AS oversized";
      }
      if (faulted && outcome === "rolled-back" && body.op === "batch") {
        body.statements.push({ sql: "INSERT INTO games (steam_app_id, name) VALUES (?, ?)", args: [10, "private duplicate-name sentinel"] });
      }
      const forwarded = new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(body), signal: request.signal, redirect: request.redirect });
      const response = await harness.fetch(forwarded);
      if (faulted && outcome === "unknown") {
        await response.arrayBuffer();
        throw new Error("private lost-response sentinel");
      }
      return response;
    },
  });
}

const uncertainOutcomes: ("unknown" | "committed")[] = ["unknown", "committed"];

test("catalog CLI persists threshold decisions and completion without changing other Catalog Facts or Steam Status", async () => {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    await client.batch([
      "INSERT INTO games (steam_app_id, name, steam_review_score, steam_review_count, hltb_main, is_owned, playtime_minutes, tags, value_score, created_at) VALUES (20, 'Old title', 50, 2, 12.5, 1, 123, '[\"City Builder\"]', 77, 1700000000)",
      "INSERT INTO games (steam_app_id, name, steam_review_score, steam_review_count) VALUES (30, 'Unchanged', 90, 100)",
    ]);
    await main([...localArgs, "--checkpoint-every", "2"], {
      client,
      provider: steamFixture([
        { appid: 10, name: " New game ", positive: 90, reviews: 100 },
        { appid: 20, name: "Renamed", positive: 4, reviews: 5 },
        { appid: 30, name: "Unchanged", positive: 90, reviews: 100 },
        { appid: 40, name: "Below threshold", positive: 4, reviews: 5 },
        { appid: 50, name: "No reviews", positive: 0, reviews: 0 },
      ]),
    });
    expect((await client.execute("SELECT steam_app_id, name, steam_review_score, steam_review_count FROM games ORDER BY steam_app_id")).rows).toEqual([
      { steam_app_id: 10, name: "New game", steam_review_score: 90, steam_review_count: 100 },
      { steam_app_id: 20, name: "Renamed", steam_review_score: 80, steam_review_count: 5 },
      { steam_app_id: 30, name: "Unchanged", steam_review_score: 90, steam_review_count: 100 },
    ]);
    expect((await client.execute("SELECT hltb_main, is_owned, playtime_minutes, tags, value_score, created_at FROM games WHERE steam_app_id = 20")).rows).toEqual([
      { hltb_main: 12.5, is_owned: 1, playtime_minutes: 123, tags: '["City Builder"]', value_score: 77, created_at: 1700000000 },
    ]);
    expect((await client.execute("SELECT last_app_id, apps_seen, processed_count, inserted_count, updated_count, skipped_count, unchanged_count, failed_count, completed_at, last_error FROM catalog_refresh_state")).rows).toEqual([
      { last_app_id: 50, apps_seen: 5, processed_count: 5, inserted_count: 1, updated_count: 1, skipped_count: 2, unchanged_count: 1, failed_count: 0, completed_at: expect.any(Number), last_error: null },
    ]);
  } finally { await harness.dispose(); }
});

test("catalog records each provider failure once and completes short runs with full counters", async () => {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    await client.execute("INSERT INTO catalog_refresh_failures (steam_app_id, name, error, attempts) VALUES (20, 'Old failure name', 'Previous failure', 2)");
    const fixture = steamFixture([
      { appid: 10, name: "Successful", positive: 90, reviews: 100 },
      { appid: 20, name: "Unavailable reviews", positive: 0, reviews: 0 },
    ]);
    const provider = {
      ...fixture,
      async fetchReviewSummary(app: { appid: number }) {
        if (app.appid === 20) throw new Error("Steam reviews unavailable");
        return fixture.fetchReviewSummary(app);
      },
    };
    for (const run of [1, 2]) {
      await main(localArgs, { client, provider });
      expect((await client.execute("SELECT last_app_id, apps_seen, processed_count, inserted_count, unchanged_count, failed_count, completed_at, last_error FROM catalog_refresh_state")).rows).toEqual([
        { last_app_id: 20, apps_seen: 2, processed_count: 2, inserted_count: run === 1 ? 1 : 0, unchanged_count: run === 1 ? 0 : 1, failed_count: 1, completed_at: expect.any(Number), last_error: null },
      ]);
      expect((await client.execute("SELECT steam_app_id, name, error, attempts, last_attempt_at FROM catalog_refresh_failures")).rows).toEqual([
        { steam_app_id: 20, name: "Unavailable reviews", error: "Steam reviews unavailable", attempts: run + 2, last_attempt_at: expect.any(Number) },
      ]);
    }
    expect((await client.execute("SELECT steam_app_id FROM games ORDER BY steam_app_id")).rows).toEqual([{ steam_app_id: 10 }]);
  } finally { await harness.dispose(); }
});

test("catalog comparisons include every existing game beyond the 10k result cap", async () => {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    const ids = Array.from({ length: 10_001 }, (_, index) => (index + 1) * 3);
    await client.execute({
      sql: "INSERT INTO games (steam_app_id, name, steam_review_score, steam_review_count) SELECT value, 'Existing', 90, 100 FROM json_each(?)",
      args: [JSON.stringify(ids)],
    });
    await main(localArgs, {
      client,
      provider: steamFixture([
        { appid: 3, name: "Existing", positive: 90, reviews: 100 },
        { appid: 15_003, name: "Existing", positive: 90, reviews: 100 },
        { appid: 30_003, name: "Last game renamed", positive: 0, reviews: 0 },
      ]),
    });
    expect((await client.execute("SELECT COUNT(*) AS total FROM games")).rows).toEqual([{ total: 10_001 }]);
    expect((await client.execute("SELECT name, steam_review_score, steam_review_count FROM games WHERE steam_app_id = 30003")).rows).toEqual([
      { name: "Last game renamed", steam_review_score: null, steam_review_count: 0 },
    ]);
    expect((await client.execute("SELECT apps_seen, processed_count, inserted_count, updated_count, unchanged_count, skipped_count FROM catalog_refresh_state")).rows).toEqual([
      { apps_seen: 3, processed_count: 3, inserted_count: 0, updated_count: 1, unchanged_count: 2, skipped_count: 0 },
    ]);
  } finally { await harness.dispose(); }
});

test("an interrupted catalog run keeps its confirmed checkpoint and resumes counters after explicit correction", async () => {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    const apps = [
      { appid: 10, name: "Confirmed", positive: 90, reviews: 100 },
      { appid: 20, name: "é".repeat(500_001), positive: 90, reviews: 100 },
      { appid: 30, name: "After interruption", positive: 90, reviews: 100 },
    ];
    const args = [...localArgs, "--checkpoint-every", "1", "--min-reviews", "25"];
    await expect(main(args, { client, provider: steamFixture(apps) })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", outcome: "not-applied" });
    expect((await client.execute("SELECT last_app_id, apps_seen, processed_count, inserted_count, completed_at, min_reviews, started_at, last_error FROM catalog_refresh_state")).rows).toEqual([
      { last_app_id: 10, apps_seen: 3, processed_count: 1, inserted_count: 1, completed_at: null, min_reviews: 25, started_at: expect.any(Number), last_error: "Database request exceeds supported limits" },
    ]);
    const startedAt = (await client.execute("SELECT started_at FROM catalog_refresh_state")).rows[0]?.started_at;
    if (typeof startedAt !== "number") throw new Error("Interrupted catalog run must retain its start time");
    expect((await client.execute("SELECT steam_app_id FROM games")).rows).toEqual([{ steam_app_id: 10 }]);
    expect((await client.execute("SELECT attempts FROM catalog_refresh_failures")).rows).toEqual([]);
    const corrected = steamFixture(apps.map((app) => app.appid === 20 ? { ...app, name: "Corrected" } : app));
    let resumedAfter: number | undefined;
    await main(args, {
      client,
      provider: {
        ...corrected,
        async fetchAppList(options, startAfterAppId) {
          resumedAfter = startAfterAppId;
          return corrected.fetchAppList(options, startAfterAppId);
        },
      },
    });
    expect(resumedAfter).toBe(10);
    expect((await client.execute("SELECT steam_app_id, name FROM games ORDER BY steam_app_id")).rows).toEqual([
      { steam_app_id: 10, name: "Confirmed" }, { steam_app_id: 20, name: "Corrected" }, { steam_app_id: 30, name: "After interruption" },
    ]);
    expect((await client.execute("SELECT last_app_id, apps_seen, processed_count, inserted_count, started_at, completed_at, last_error FROM catalog_refresh_state")).rows).toEqual([
      { last_app_id: 30, apps_seen: 3, processed_count: 3, inserted_count: 3, started_at: startedAt, completed_at: expect.any(Number), last_error: null },
    ]);
  } finally { await harness.dispose(); }
});

test("catalog writes all games across bounded atomic groups, counting four binds per upsert rather than four games", async () => {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    await main([...localArgs, "--batch-size", "400", "--checkpoint-every", "10000"], {
      client,
      provider: steamFixture(Array.from({ length: 1001 }, (_, index) => ({ appid: (index + 1) * 10, name: `Game ${index + 1}`, positive: 90, reviews: 100 }))),
    });
    expect((await client.execute("SELECT COUNT(*) AS total, SUM(steam_app_id) AS checksum, MIN(steam_review_score) AS score, MIN(steam_review_count) AS reviews FROM games")).rows).toEqual([
      { total: 1001, checksum: 5_015_010, score: 90, reviews: 100 },
    ]);
    expect((await client.execute("SELECT steam_app_id, name, created_at, updated_at FROM games WHERE steam_app_id IN (10, 10010) ORDER BY steam_app_id")).rows).toEqual([
      { steam_app_id: 10, name: "Game 1", created_at: expect.any(Number), updated_at: expect.any(Number) },
      { steam_app_id: 10010, name: "Game 1001", created_at: expect.any(Number), updated_at: expect.any(Number) },
    ]);
    expect((await client.execute("SELECT last_app_id, apps_seen, processed_count, inserted_count, completed_at FROM catalog_refresh_state")).rows).toEqual([
      { last_app_id: 10010, apps_seen: 1001, processed_count: 1001, inserted_count: 1001, completed_at: expect.any(Number) },
    ]);
  } finally { await harness.dispose(); }
});

test("byte pressure rejects the entire requested catalog group without partial writes or an advanced checkpoint", async () => {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    await expect(main([...localArgs, "--batch-size", "5", "--checkpoint-every", "10000"], {
      client,
      provider: steamFixture(Array.from({ length: 5 }, (_, index) => ({ appid: index + 1, name: "é".repeat(450_000), positive: 90, reviews: 100 }))),
    })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", outcome: "not-applied" });
    expect((await client.execute("SELECT COUNT(*) AS total FROM games")).rows).toEqual([{ total: 0 }]);
    expect((await client.execute("SELECT last_app_id, processed_count, inserted_count, completed_at, last_error FROM catalog_refresh_state")).rows).toEqual([
      { last_app_id: 0, processed_count: 0, inserted_count: 0, completed_at: null, last_error: "Database request exceeds supported limits" },
    ]);
    expect((await client.execute("SELECT attempts FROM catalog_refresh_failures")).rows).toEqual([]);
  } finally { await harness.dispose(); }
});

test("ordinary catalog runs require explicit bootstrap and do not initialize missing schema", async () => {
  const harness = await createD1WorkerTestHarness({ bootstrap: false });
  try {
    const client = createHttpClient(harness.clientConfig);
    await expect(main(localArgs, { client, provider: steamFixture([]) })).rejects.toMatchObject({ code: "SQL_ERROR", outcome: "not-applied", message: "no such table: catalog_refresh_state" });
    expect((await client.execute("SELECT name FROM sqlite_schema WHERE name IN ('games', 'catalog_refresh_state', 'catalog_refresh_failures')")).rows).toEqual([]);
  } finally { await harness.dispose(); }
});

test.each(uncertainOutcomes)("a failure-record outcome of %s stops without incrementing attempts again or advancing progress", async (outcome) => {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    await client.execute("INSERT INTO catalog_refresh_failures (steam_app_id, name, error, attempts) VALUES (20, 'Old', 'Old error', 3)");
    const broken = faultClient(harness, (body) => body.op === "execute" && body.statement.sql.startsWith("INSERT INTO catalog_refresh_failures"), outcome);
    const fixture = steamFixture([
      { appid: 10, name: "Confirmed", positive: 90, reviews: 100 },
      { appid: 20, name: "Unavailable", positive: 0, reviews: 0 },
      { appid: 30, name: "Must not be processed", positive: 90, reviews: 100 },
    ]);
    const reviewed: number[] = [];
    await expect(main([...localArgs, "--checkpoint-every", "1"], {
      client: broken,
      provider: {
        ...fixture,
        async fetchReviewSummary(app) {
          reviewed.push(app.appid);
          if (app.appid === 20) throw new Error("Steam reviews unavailable");
          return fixture.fetchReviewSummary(app);
        },
      },
    })).rejects.toMatchObject({ code: outcome === "unknown" ? "OUTCOME_UNKNOWN" : "RESULT_LIMIT", outcome });
    expect(reviewed).toEqual([10, 20]);
    expect((await client.execute("SELECT name, error, attempts FROM catalog_refresh_failures WHERE steam_app_id = 20")).rows).toEqual([
      { name: "Unavailable", error: "Steam reviews unavailable", attempts: 4 },
    ]);
    expect((await client.execute("SELECT steam_app_id FROM games ORDER BY steam_app_id")).rows).toEqual([{ steam_app_id: 10 }]);
    expect((await client.execute("SELECT last_app_id, processed_count, inserted_count, failed_count, completed_at, last_error FROM catalog_refresh_state")).rows).toEqual([
      { last_app_id: 10, processed_count: 1, inserted_count: 1, failed_count: 0, completed_at: null, last_error: null },
    ]);
  } finally { await harness.dispose(); }
});

test.each(uncertainOutcomes)("a catalog flush outcome of %s leaves the prior checkpoint and stops before subsequent apps", async (outcome) => {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    const broken = faultClient(harness, (body) => body.op === "batch" && body.statements.some((statement) => statement.args[0] === 20), outcome);
    await expect(main([...localArgs, "--checkpoint-every", "1"], {
      client: broken,
      provider: steamFixture([
        { appid: 10, name: "Confirmed", positive: 90, reviews: 100 },
        { appid: 20, name: "Committed but unconfirmed", positive: 90, reviews: 100 },
        { appid: 30, name: "Must not be processed", positive: 90, reviews: 100 },
      ]),
    })).rejects.toMatchObject({ code: outcome === "unknown" ? "OUTCOME_UNKNOWN" : "RESULT_LIMIT", outcome });
    expect((await client.execute("SELECT steam_app_id FROM games ORDER BY steam_app_id")).rows).toEqual([{ steam_app_id: 10 }, { steam_app_id: 20 }]);
    expect((await client.execute("SELECT last_app_id, processed_count, inserted_count, completed_at, last_error FROM catalog_refresh_state")).rows).toEqual([
      { last_app_id: 10, processed_count: 1, inserted_count: 1, completed_at: null, last_error: null },
    ]);
    expect((await client.execute("SELECT attempts FROM catalog_refresh_failures")).rows).toEqual([]);
  } finally { await harness.dispose(); }
});

test("a lost checkpoint response stops even when inspection confirms that checkpoint committed", async () => {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    const broken = faultClient(harness, (body) => body.op === "execute" && body.statement.sql.includes("last_app_id = ?") && body.statement.sql.startsWith("UPDATE"), "unknown");
    await expect(main([...localArgs, "--checkpoint-every", "1"], {
      client: broken,
      provider: steamFixture([
        { appid: 10, name: "Unconfirmed checkpoint", positive: 90, reviews: 100 },
        { appid: 20, name: "Must not be processed", positive: 90, reviews: 100 },
      ]),
    })).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", outcome: "unknown" });
    expect((await client.execute("SELECT last_app_id, processed_count, inserted_count, completed_at, last_error FROM catalog_refresh_state")).rows).toEqual([
      { last_app_id: 10, processed_count: 1, inserted_count: 1, completed_at: null, last_error: null },
    ]);
    expect((await client.execute("SELECT steam_app_id FROM games ORDER BY steam_app_id")).rows).toEqual([{ steam_app_id: 10 }]);
  } finally { await harness.dispose(); }
});

test.each(["official", "import-steamspy", "refresh-steamspy"])("%s catalog entrypoint keeps dry-run fully write-free, including failures and checkpoints", async (entrypoint) => {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    await client.batch([
      "INSERT INTO games (steam_app_id, name, steam_review_score, steam_review_count, tags, is_owned) VALUES (20, 'Old', 50, 2, '[\"City Builder\"]', 1)",
      "INSERT INTO catalog_refresh_state (key, last_app_id, processed_count, inserted_count, min_reviews, started_at, last_error, updated_at) VALUES ('steam_official_catalog', 100, 7, 7, 25, 1000, 'Prior interruption', 555)",
      "INSERT INTO catalog_refresh_failures (steam_app_id, name, error, attempts, last_attempt_at) VALUES (30, 'Prior name', 'Prior failure', 3, 444)",
    ]);
    const snapshot = () => client.batch(["SELECT * FROM games ORDER BY steam_app_id", "SELECT * FROM catalog_refresh_state", "SELECT * FROM catalog_refresh_failures ORDER BY steam_app_id"], "read");
    const before = await snapshot();
    const fixture = steamFixture([
      { appid: 10, name: "New", positive: 90, reviews: 100 },
      { appid: 20, name: "Would update", positive: 90, reviews: 100 },
      { appid: 30, name: "Would record failure", positive: 0, reviews: 0 },
    ]);
    const run = entrypoint === "official" ? main : entrypoint === "import-steamspy"
      ? (await import("./import-steamspy-catalog")).main : (await import("./refresh-steamspy-catalog")).main;
    const cursors: number[] = [];
    for (const flags of [["--dry-run"], ["--dry-run", "--start-after-app-id", "15"]]) {
      await run([...localArgs, "--checkpoint-every", "1", ...flags], {
        client,
        provider: {
          ...fixture,
          async fetchAppList(options, cursor) {
            cursors.push(cursor);
            return fixture.fetchAppList(options, cursor);
          },
          async fetchReviewSummary(app) {
            if (app.appid === 30) throw new Error("Steam reviews unavailable");
            return fixture.fetchReviewSummary(app);
          },
        },
      });
      expect(await snapshot()).toEqual(before);
    }
    expect(cursors).toEqual([0, 15]);
  } finally { await harness.dispose(); }
});

test("official Steam fetching retains page sizes, cursors, limits, summary filters and provider retries through the catalog job", async () => {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    const requests: string[] = [];
    const { createSteamCatalogProvider } = await import("./refresh-steam-catalog");
    const provider = createSteamCatalogProvider("synthetic-steam-key", async (url, init) => {
      requests.push(url.pathname + url.searchParams.get("last_appid"));
      expect(new Headers(init.headers).get("User-Agent")).toBe("steam-value catalog refresh");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (url.origin === "https://api.steampowered.com") {
        expect(url.pathname).toBe("/IStoreService/GetAppList/v1/");
        expect(Object.fromEntries(url.searchParams)).toEqual(url.searchParams.has("last_appid")
          ? { key: "synthetic-steam-key", include_games: "true", max_results: "50000", last_appid: "20" }
          : { key: "synthetic-steam-key", include_games: "true", max_results: "50000" });
        return Response.json({ response: url.searchParams.has("last_appid")
          ? { apps: [{ appid: 30, name: " New Last " }, { appid: 40, name: "Beyond limit" }], have_more_results: false }
          : { apps: [{ appid: 10, name: "No successful summary" }, { appid: 20, name: "Unavailable" }, { appid: 15, name: " " }], have_more_results: true, last_appid: 20 } });
      }
      expect(url.origin).toBe("https://store.steampowered.com");
      expect(Object.fromEntries(url.searchParams)).toEqual({ json: "1", filter: "summary", language: "all", purchase_type: "all", num_per_page: "0" });
      if (url.pathname === "/appreviews/20") return new Response("private-upstream-body sentinel", { status: 503 });
      return Response.json({ success: url.pathname === "/appreviews/10" ? 0 : 1, query_summary: { total_positive: 51, total_negative: 49, total_reviews: 100 } });
    });
    await main([...localArgs, "--retries", "1", "--limit-apps", "3"], { client, provider });
    expect(requests).toEqual([
      "/IStoreService/GetAppList/v1/null", "/IStoreService/GetAppList/v1/20", "/appreviews/10null", "/appreviews/20null", "/appreviews/20null", "/appreviews/30null",
    ]);
    expect((await client.execute("SELECT steam_app_id, name, steam_review_score, steam_review_count FROM games")).rows).toEqual([
      { steam_app_id: 30, name: "New Last", steam_review_score: 51, steam_review_count: 100 },
    ]);
    expect((await client.execute("SELECT steam_app_id, attempts, error FROM catalog_refresh_failures")).rows).toEqual([
      { steam_app_id: 20, attempts: 1, error: "Steam reviews for 20 failed after 2 attempts: HTTP 503" },
    ]);
    expect((await client.execute("SELECT last_app_id, apps_seen, processed_count, inserted_count, skipped_count, failed_count, completed_at FROM catalog_refresh_state")).rows).toEqual([
      { last_app_id: 30, apps_seen: 3, processed_count: 3, inserted_count: 1, skipped_count: 1, failed_count: 1, completed_at: expect.any(Number) },
    ]);
  } finally { await harness.dispose(); }
});

test.each(["http", "non-json", "transport"])("known Steam app-list %s failures preserve progress and record only safe diagnostics", async (failure) => {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    await client.batch([
      "INSERT INTO games (steam_app_id, name) VALUES (10, 'Confirmed')",
      "INSERT INTO catalog_refresh_state (key, last_app_id, started_at, processed_count, inserted_count) VALUES ('steam_official_catalog', 10, 1000, 1, 1)",
    ]);
    const provider = createSteamCatalogProvider("synthetic-steam-key", async (url) => {
      expect(url.searchParams.get("last_appid")).toBe("10");
      if (failure === "transport") throw new Error("private transport URL with key=synthetic-steam-key");
      return new Response("private body with key=synthetic-steam-key", { status: failure === "http" ? 503 : 200 });
    });
    const message = `Steam app list failed after 1 attempts: ${failure === "http" ? "HTTP 503" : failure === "non-json" ? "non-JSON response" : "request failed"}`;
    await expect(main([...localArgs, "--retries", "0"], { client, provider })).rejects.toThrow(message);
    expect((await client.execute("SELECT last_app_id, processed_count, inserted_count, started_at, completed_at, last_error FROM catalog_refresh_state")).rows).toEqual([
      { last_app_id: 10, processed_count: 1, inserted_count: 1, started_at: 1000, completed_at: null, last_error: message },
    ]);
    expect((await client.execute("SELECT steam_app_id, name FROM games")).rows).toEqual([{ steam_app_id: 10, name: "Confirmed" }]);
    expect((await client.execute("SELECT attempts FROM catalog_refresh_failures")).rows).toEqual([]);
  } finally { await harness.dispose(); }
});

test("native catalog rollback preserves the entire group and reports a safe known failure at the last confirmed checkpoint", async () => {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    await client.batch([
      "INSERT INTO games (steam_app_id, name) VALUES (10, 'Confirmed')",
      "INSERT INTO catalog_refresh_state (key, last_app_id, started_at, processed_count, inserted_count, apps_seen) VALUES ('steam_official_catalog', 10, 1000, 1, 1, 3)",
    ]);
    const broken = faultClient(harness, (body) => body.op === "batch" && body.statements.some((statement) => statement.args[0] === 20), "rolled-back");
    await expect(main([...localArgs, "--batch-size", "2", "--checkpoint-every", "10000"], {
      client: broken,
      provider: steamFixture([
        { appid: 20, name: "Must roll back", positive: 90, reviews: 100 },
        { appid: 30, name: "Must also roll back", positive: 90, reviews: 100 },
      ]),
    })).rejects.toMatchObject({ code: "SQL_ERROR", outcome: "rolled-back", message: "Database constraint violation" });
    expect((await client.execute("SELECT steam_app_id, name FROM games")).rows).toEqual([{ steam_app_id: 10, name: "Confirmed" }]);
    expect((await client.execute("SELECT last_app_id, processed_count, inserted_count, completed_at, last_error FROM catalog_refresh_state")).rows).toEqual([
      { last_app_id: 10, processed_count: 1, inserted_count: 1, completed_at: null, last_error: "Database constraint violation" },
    ]);
    expect((await client.execute("SELECT attempts FROM catalog_refresh_failures")).rows).toEqual([]);
  } finally { await harness.dispose(); }
});

test("empty resumed work completes its existing counters, while restart resets progress but preserves games and failure history", async () => {
  const harness = await createD1WorkerTestHarness();
  try {
    const client = createHttpClient(harness.clientConfig);
    await client.batch([
      "INSERT INTO games (steam_app_id, name, steam_review_score, steam_review_count) VALUES (10, 'Confirmed', 90, 100)",
      "INSERT INTO catalog_refresh_state (key, last_app_id, started_at, processed_count, inserted_count, updated_count, skipped_count, failed_count, last_error) VALUES ('steam_official_catalog', 100, 1000, 7, 5, 1, 1, 1, 'Prior interruption')",
      "INSERT INTO catalog_refresh_failures (steam_app_id, name, error, attempts, last_attempt_at) VALUES (20, 'Historical failure', 'Historical error', 3, 444)",
    ]);
    const fixture = steamFixture([
      { appid: 10, name: "Confirmed", positive: 90, reviews: 100 },
      { appid: 20, name: "Below threshold", positive: 4, reviews: 5 },
    ]);
    const cursors: number[] = [];
    const provider = {
      ...fixture,
      async fetchAppList(options: unknown, cursor: number) {
        cursors.push(cursor);
        return fixture.fetchAppList(options, cursor);
      },
    };
    await main(localArgs, { client, provider });
    expect((await client.execute("SELECT last_app_id, processed_count, inserted_count, updated_count, skipped_count, failed_count, apps_seen, started_at, completed_at, last_error FROM catalog_refresh_state")).rows).toEqual([
      { last_app_id: 100, processed_count: 7, inserted_count: 5, updated_count: 1, skipped_count: 1, failed_count: 1, apps_seen: 7, started_at: 1000, completed_at: expect.any(Number), last_error: null },
    ]);
    await main([...localArgs, "--restart"], { client, provider });
    expect(cursors).toEqual([100, 0]);
    expect((await client.execute("SELECT last_app_id, processed_count, inserted_count, updated_count, skipped_count, unchanged_count, failed_count, apps_seen, started_at, completed_at, last_error FROM catalog_refresh_state")).rows).toEqual([
      { last_app_id: 20, processed_count: 2, inserted_count: 0, updated_count: 0, skipped_count: 1, unchanged_count: 1, failed_count: 0, apps_seen: 2, started_at: expect.any(Number), completed_at: expect.any(Number), last_error: null },
    ]);
    expect((await client.execute("SELECT steam_app_id, name FROM games")).rows).toEqual([{ steam_app_id: 10, name: "Confirmed" }]);
    expect((await client.execute("SELECT steam_app_id, name, error, attempts, last_attempt_at FROM catalog_refresh_failures")).rows).toEqual([
      { steam_app_id: 20, name: "Historical failure", error: "Historical error", attempts: 3, last_attempt_at: 444 },
    ]);
  } finally { await harness.dispose(); }
});

describe("refresh Steam catalog helpers", () => {
  test("parses defaults and overrides", () => {
    expect(parseArgs([])).toEqual({
      minReviews: 10,
      appListPageSize: 50_000,
      appListDelayMs: 1000,
      reviewDelayMs: 500,
      retries: 5,
      retryDelayMs: 5000,
      reviewTimeoutMs: 20_000,
      batchSize: 200,
      checkpointEvery: 50,
      dryRun: false,
      restart: false,
    });

    expect(
      parseArgs([
        "--min-reviews",
        "25",
        "--limit-apps",
        "10",
        "--start-after-app-id",
        "620",
        "--review-delay-ms",
        "0",
        "--retries",
        "1",
        "--retry-delay-ms",
        "250",
        "--batch-size",
        "50",
        "--checkpoint-every",
        "5",
        "--dry-run",
        "--restart",
      ])
    ).toEqual({
      minReviews: 25,
      appListPageSize: 50_000,
      appListDelayMs: 1000,
      reviewDelayMs: 0,
      retries: 1,
      retryDelayMs: 250,
      reviewTimeoutMs: 20_000,
      batchSize: 50,
      checkpointEvery: 5,
      limitApps: 10,
      startAfterAppId: 620,
      dryRun: true,
      restart: true,
    });
  });

  test("rejects an unsupported atomic write group instead of silently changing the requested batch size", () => {
    expect(parseArgs(["--batch-size", "400"]).batchSize).toBe(400);
    expect(() => parseArgs(["--batch-size", "401"])).toThrow("--batch-size must be at most 400");
    expect(() => parseArgs(["--checkpoint-every", "9007199254740992"])).toThrow("--checkpoint-every must be a non-negative safe integer");
  });

  test("normalizes Steam app and review summary into a catalog row", () => {
    expect(
      toCatalogRow(
        { appid: 620, name: " Portal 2 " },
        { totalPositive: 453650, totalNegative: 5952, totalReviews: 459602 }
      )
    ).toEqual({
      steamAppId: 620,
      name: "Portal 2",
      steamReviewScore: 99,
      steamReviewCount: 459602,
    });
  });

  test("plans inserts, updates, unchanged rows, and review-count skips", () => {
    expect(
      planCatalogChange(
        { steamAppId: 413150, name: "Stardew Valley", steamReviewScore: 98, steamReviewCount: 100 },
        undefined,
        10
      )
    ).toEqual({
      kind: "insert",
      row: { steamAppId: 413150, name: "Stardew Valley", steamReviewScore: 98, steamReviewCount: 100 },
    });

    expect(
      planCatalogChange(
        { steamAppId: 10, name: "Too Small", steamReviewScore: 80, steamReviewCount: 5 },
        undefined,
        10
      )
    ).toBe("skip-below-threshold");

    expect(
      planCatalogChange(
        { steamAppId: 20, name: "No Reviews", steamReviewScore: null, steamReviewCount: 0 },
        undefined,
        10
      )
    ).toBe("skip-no-reviews");

    expect(
      planCatalogChange(
        { steamAppId: 620, name: "Portal 2", steamReviewScore: 99, steamReviewCount: 459602 },
        { steamAppId: 620, name: "Portal 2", steamReviewScore: 99, steamReviewCount: 459602 },
        10
      )
    ).toBe("unchanged");

    expect(
      planCatalogChange(
        { steamAppId: 292030, name: "The Witcher 3: Wild Hunt", steamReviewScore: 96, steamReviewCount: 1000 },
        { steamAppId: 292030, name: "The Witcher 3", steamReviewScore: 96, steamReviewCount: 1000 },
        10
      )
    ).toEqual({
      kind: "update",
      row: {
        steamAppId: 292030,
        name: "The Witcher 3: Wild Hunt",
        steamReviewScore: 96,
        steamReviewCount: 1000,
      },
    });
  });
});
