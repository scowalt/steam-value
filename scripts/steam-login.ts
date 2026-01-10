#!/usr/bin/env bun
/**
 * Steam Login Script
 *
 * Uses Playwright with a persistent browser profile to maintain Steam login.
 * First run: Opens browser for manual login (handles Steam Guard, etc.)
 * Subsequent runs: Reuses the saved session automatically.
 *
 * Usage:
 *   bun scripts/steam-login.ts          # Refresh cookie from saved session
 *   bun scripts/steam-login.ts --login  # Force new login (opens browser)
 */

import { firefox, type BrowserContext } from "playwright";
import { join } from "path";

// Session stored in scowalt's home since they have GUI access
const SESSION_DIR = join("/Users/scowalt", ".steam-session");
const ENV_FILE = join(import.meta.dir, "..", ".env");

interface SteamUserData {
  rgIgnoredApps: Record<string, number>;
  rgOwnedApps: number[];
}

async function getContext(headless: boolean): Promise<BrowserContext> {
  return firefox.launchPersistentContext(SESSION_DIR, {
    headless,
    viewport: { width: 1280, height: 800 },
  });
}

async function isLoggedIn(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies("https://store.steampowered.com");
  return cookies.some((c) => c.name === "steamLoginSecure" && c.value.length > 0);
}

async function getSteamCookie(context: BrowserContext): Promise<string | null> {
  const cookies = await context.cookies("https://store.steampowered.com");
  const loginCookie = cookies.find((c) => c.name === "steamLoginSecure");
  return loginCookie?.value ?? null;
}

async function fetchIgnoredApps(context: BrowserContext): Promise<number> {
  const page = await context.newPage();
  try {
    const response = await page.goto(
      "https://store.steampowered.com/dynamicstore/userdata/"
    );
    const data: SteamUserData = await response!.json();
    return Object.keys(data.rgIgnoredApps || {}).length;
  } finally {
    await page.close();
  }
}

async function updateEnvFile(cookie: string): Promise<void> {
  try {
    const file = Bun.file(ENV_FILE);
    let content = await file.text();

    // Update or add STEAM_LOGIN_SECURE
    if (content.includes("STEAM_LOGIN_SECURE=")) {
      content = content.replace(
        /STEAM_LOGIN_SECURE=.*/,
        `STEAM_LOGIN_SECURE=${cookie}`
      );
    } else {
      content += `\nSTEAM_LOGIN_SECURE=${cookie}\n`;
    }

    await Bun.write(ENV_FILE, content);
    console.log("[Steam Session] Updated .env with fresh cookie");
  } catch (error) {
    // Can't write to .env (permission issue) - print cookie for manual update
    console.log("\n[Steam Session] Cannot write to .env (permission denied)");
    console.log("[Steam Session] Add this to your .env file:\n");
    console.log(`STEAM_LOGIN_SECURE=${cookie}`);
  }
}

async function waitForLogin(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await page.goto("https://store.steampowered.com/login/");

  console.log("\n=== Steam Login Required ===");
  console.log("Please log in to Steam in the browser window.");
  console.log("The script will continue automatically once logged in.\n");

  // Poll for cookie instead of waiting for navigation (more reliable with QR login)
  const maxWait = 300000; // 5 minutes
  const pollInterval = 1000; // 1 second
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    // Check if we got the login cookie (check context, not page, in case page closed)
    const cookies = await context.cookies("https://store.steampowered.com");
    const hasLoginCookie = cookies.some(
      (c) => c.name === "steamLoginSecure" && c.value.length > 0
    );

    if (hasLoginCookie) {
      console.log("[Steam Session] Login detected!");
      try { await page.close(); } catch { /* page may already be closed */ }
      return;
    }

    // Sleep without relying on the page (in case it closed)
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  try { await page.close(); } catch { /* page may already be closed */ }
  throw new Error("Login timed out after 5 minutes");
}

async function main() {
  const forceLogin = process.argv.includes("--login");

  console.log("[Steam Session] Checking session...");

  // First try headless to check if we're already logged in
  let context = await getContext(true);
  let loggedIn = await isLoggedIn(context);

  if (!loggedIn || forceLogin) {
    await context.close();

    // Need to log in - open visible browser
    console.log("[Steam Session] Opening browser for login...");
    context = await getContext(false);

    if (!(await isLoggedIn(context))) {
      await waitForLogin(context);
    }

    loggedIn = await isLoggedIn(context);
  }

  if (!loggedIn) {
    console.error("[Steam Session] Login failed or cancelled.");
    await context.close();
    process.exit(1);
  }

  // Get cookie and verify it works
  const cookie = await getSteamCookie(context);
  if (!cookie) {
    console.error("[Steam Session] Could not get steamLoginSecure cookie.");
    await context.close();
    process.exit(1);
  }

  // Test that we can fetch ignored apps
  const ignoredCount = await fetchIgnoredApps(context);
  console.log(`[Steam Session] Verified: ${ignoredCount} ignored apps found`);

  // Update .env file (or print cookie if permission denied)
  await updateEnvFile(cookie);

  await context.close();
  console.log("[Steam Session] Done!");
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
