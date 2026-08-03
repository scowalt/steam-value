import { describe, expect, test } from "bun:test";
import {
  getSteamStatusCounts,
  validateSteamStatusCounts,
  type SyncState,
} from "./steam-status-sync";

function previousState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    key: "steam_status",
    lastAttemptAt: 1,
    lastSuccessAt: 1,
    lastError: null,
    isRunning: false,
    lockExpiresAt: null,
    ignoredCount: 6_097,
    wishlistCount: 165,
    ownedCount: 1_432,
    gamesUpdated: 0,
    gamesRemoved: 0,
    updatedAt: 1,
    ...overrides,
  };
}

describe("Steam Status validation", () => {
  test("accepts authenticated, stable Steam data", () => {
    expect(
      validateSteamStatusCounts(
        {
          ignoredCount: 6_100,
          wishlistCount: 164,
          ownedCount: 1_433,
          dynamicStoreOwnedCount: 2_460,
        },
        previousState()
      )
    ).toBeNull();
  });

  test("rejects the empty response returned for an expired Steam session", () => {
    expect(
      validateSteamStatusCounts(
        { ignoredCount: 0, wishlistCount: 0, ownedCount: 1_432, dynamicStoreOwnedCount: 0 },
        previousState()
      )
    ).toBe("Steam Dynamic Store session is not authenticated");
  });

  test("rejects suspiciously large drops without changing the database", () => {
    expect(
      validateSteamStatusCounts(
        { ignoredCount: 10, wishlistCount: 5, ownedCount: 100, dynamicStoreOwnedCount: 2_460 },
        previousState()
      )
    ).toContain("wishlist 165 -> 5, ignored 6097 -> 10, owned 1432 -> 100");
  });

  test("requires all authenticated Dynamic Store fields", () => {
    expect(
      getSteamStatusCounts(
        { rgOwnedApps: [10] },
        new Map([[10, 60]])
      )
    ).toEqual({
      ignoredCount: -1,
      wishlistCount: -1,
      ownedCount: 1,
      dynamicStoreOwnedCount: 1,
    });
  });
});
