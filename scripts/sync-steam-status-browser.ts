#!/usr/bin/env node
import { createExternalClient } from "../src/db/http.ts";
import { chromium, type Browser, type Page } from "playwright";
import {
  syncSteamStatusFromUserData,
  type SteamUserData,
} from "../src/services/steam-status-sync.ts";

const STEAM_HOME_URL = "https://store.steampowered.com/";
const STEAM_LOGIN_URL = "https://store.steampowered.com/login/";
const STEAM_USER_DATA_PATH = "/app/api/user-data-dir";
const LOGIN_TIMEOUT_MS = Number(process.env.STEEL_LOGIN_TIMEOUT_MS ?? 30 * 60 * 1000);

interface SteelSession {
  id: string;
  websocketUrl: string;
  debugUrl: string;
}

const loginMode = process.argv.includes("--login");
const steelBaseUrl = requiredEnv("STEEL_BASE_URL").replace(/\/$/, "");
let session: SteelSession | null = null;
let browser: Browser | null = null;

try {
  session = await createSteelSession(steelBaseUrl, loginMode);
  browser = await chromium.connectOverCDP(
    resolveSteelUrl(process.env.STEEL_CDP_URL ?? session.websocketUrl, steelBaseUrl)
  );

  const context = browser.contexts()[0];
  if (!context) throw new Error("Steel session did not create a browser context");

  const page = context.pages()[0] ?? (await context.newPage());

  if (loginMode) {
    await page.goto(STEAM_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log(`STEEL_LOGIN_URL=${resolveSteelUrl(session.debugUrl, steelBaseUrl)}`);
    console.log("[Steam Status] Waiting for Steam login...");

    const userData = await waitForSteamLogin(page, LOGIN_TIMEOUT_MS);
    console.log(
      `[Steam Status] Login confirmed: ${userData.rgOwnedApps!.length} dynamic-store owned, ${userData.rgWishlist!.length} wishlisted, ${Object.keys(userData.rgIgnoredApps!).length} ignored`
    );
  } else {
    await page.goto(STEAM_HOME_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const cookies = await context.cookies(STEAM_HOME_URL);
    if (!cookies.some((cookie) => cookie.name === "steamLoginSecure")) {
      throw new Error("Steel Steam profile is not authenticated; run with --login");
    }

    const userData = await fetchSteamUserData(page);
    const client = createExternalClient(process.env);

    try {
      console.log(`[Steam Status] Starting browser-backed refresh at ${new Date().toISOString()}`);
      const result = await syncSteamStatusFromUserData(
        client,
        {
          STEAM_API_KEY: process.env.STEAM_API_KEY,
          STEAM_ID: process.env.STEAM_ID,
        },
        userData
      );

      if (!result.success) {
        throw new Error(result.error ?? "Steam Status refresh failed");
      }

      console.log(
        `[Steam Status] Complete: ${result.gamesUpdated} updates, ${result.ownedCount} owned, ${result.wishlistCount} wishlisted, ${result.ignoredCount} ignored`
      );
    } finally {
      client.close();
    }
  }
} finally {
  await browser?.close().catch(() => undefined);
  if (session) await releaseSteelSession(steelBaseUrl, session.id).catch(() => undefined);
}

async function createSteelSession(baseUrl: string, interactive: boolean): Promise<SteelSession> {
  const response = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      headless: !interactive,
      persist: true,
      userDataDir: STEAM_USER_DATA_PATH,
      dimensions: { width: 1440, height: 900 },
    }),
  });

  if (!response.ok) {
    throw new Error(`Steel session creation failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as SteelSession;
}

async function releaseSteelSession(baseUrl: string, sessionId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/release`, { method: "POST" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Steel session release failed: ${response.status}`);
  }
}

async function waitForSteamLogin(page: Page, timeoutMs: number): Promise<SteamUserData> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const userData = await fetchSteamUserData(page).catch(() => null);
    if (
      userData &&
      Array.isArray(userData.rgOwnedApps) &&
      userData.rgOwnedApps.length > 0 &&
      Array.isArray(userData.rgWishlist) &&
      userData.rgIgnoredApps &&
      typeof userData.rgIgnoredApps === "object"
    ) {
      return userData;
    }

    await delay(3_000);
  }

  throw new Error("Timed out waiting for Steam login");
}

async function fetchSteamUserData(page: Page): Promise<SteamUserData> {
  return page.evaluate(async () => {
    const response = await fetch(`/dynamicstore/userdata/?v=${Date.now()}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Steam dynamicstore error: ${response.status}`);
    return (await response.json()) as SteamUserData;
  });
}

export function resolveSteelUrl(value: string, baseUrl: string): string {
  const target = new URL(value, baseUrl);
  const base = new URL(baseUrl);

  if (["localhost", "127.0.0.1", "0.0.0.0"].includes(target.hostname)) {
    target.hostname = base.hostname;
    target.port = base.port;
  }

  return target.toString();
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
