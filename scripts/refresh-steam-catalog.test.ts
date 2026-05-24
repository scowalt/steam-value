import { describe, expect, test } from "bun:test";
import { parseArgs, planCatalogChange, toCatalogRow } from "./refresh-steam-catalog";

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
