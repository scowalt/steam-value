import { describe, expect, test } from "bun:test";
import { parseArgs, planCatalogChanges, toCatalogRow } from "./refresh-steamspy-catalog";

describe("refresh SteamSpy catalog helpers", () => {
  test("parses defaults and overrides", () => {
    expect(parseArgs([])).toEqual({
      minReviews: 10,
      pageDelayMs: 1500,
      pageRetries: 5,
      retryDelayMs: 5000,
      batchSize: 200,
      dryRun: false,
    });

    expect(
      parseArgs([
        "--min-reviews",
        "25",
        "--page-delay-ms",
        "0",
        "--page-retries",
        "1",
        "--retry-delay-ms",
        "250",
        "--batch-size",
        "50",
        "--limit-pages",
        "2",
        "--dry-run",
      ])
    ).toEqual({
      minReviews: 25,
      pageDelayMs: 0,
      pageRetries: 1,
      retryDelayMs: 250,
      batchSize: 50,
      limitPages: 2,
      dryRun: true,
    });
  });

  test("normalizes SteamSpy entries into catalog rows", () => {
    expect(
      toCatalogRow({ appid: 620, name: " Portal 2 ", positive: 1234, negative: 66 })
    ).toEqual({
      steamAppId: 620,
      name: "Portal 2",
      steamReviewScore: 95,
      steamReviewCount: 1300,
    });
  });

  test("plans inserts, updates, unchanged, invalid, and below-threshold rows", () => {
    const existing = new Map([
      [620, { steamAppId: 620, name: "Portal 2", steamReviewScore: 95, steamReviewCount: 1300 }],
      [292030, { steamAppId: 292030, name: "The Witcher 3", steamReviewScore: 96, steamReviewCount: 1000 }],
    ]);

    const plan = planCatalogChanges(
      [
        { appid: 620, name: "Portal 2", positive: 1234, negative: 66 },
        { appid: 292030, name: "The Witcher 3: Wild Hunt", positive: 970, negative: 30 },
        { appid: 413150, name: "Stardew Valley", positive: 99, negative: 1 },
        { appid: 10, name: "Too Small", positive: 5, negative: 4 },
        { appid: 0, name: "Invalid", positive: 10, negative: 0 },
      ],
      existing,
      10
    );

    expect(plan.candidates).toBe(3);
    expect(plan.unchanged).toBe(1);
    expect(plan.belowThreshold).toBe(1);
    expect(plan.invalid).toBe(1);
    expect(plan.changes.map((change) => change.kind)).toEqual(["update", "insert"]);
  });
});
