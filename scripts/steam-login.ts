#!/usr/bin/env bun

import { firefox, type BrowserContext } from "playwright";
import { join } from "path";

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
    console.log("\n[Steam Session] Cannot write to .env (permission denied)");
    console.log("[Steam Session] Cookie was refreshed in memory, but not persisted. Fix .env permissions or use scripts/steam-get-refresh-token.ts to save it to Doppler.");
  }
}

async function waitForLogin(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await page.goto("https://store.steampowered.com/login/");

  console.log("\n=== Steam Login Required ===");
  console.log("Please log in to Steam in the browser window.");
  console.log("The script will continue automatically once logged in.\n");

  const maxWait = 300000;  
  const pollInterval = 1000;  
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    const cookies = await context.cookies("https://store.steampowered.com");
    const hasLoginCookie = cookies.some(
      (c) => c.name === "steamLoginSecure" && c.value.length > 0
    );

    if (hasLoginCookie) {
      console.log("[Steam Session] Login detected!");
      try { await page.close(); } catch {   }
      return;
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  try { await page.close(); } catch {   }
  throw new Error("Login timed out after 5 minutes");
}

async function main() {
  const forceLogin = process.argv.includes("--login");

  console.log("[Steam Session] Checking session...");

  let context = await getContext(true);
  let loggedIn = await isLoggedIn(context);

  if (!loggedIn || forceLogin) {
    await context.close();

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

  const cookie = await getSteamCookie(context);
  if (!cookie) {
    console.error("[Steam Session] Could not get steamLoginSecure cookie.");
    await context.close();
    process.exit(1);
  }

  const ignoredCount = await fetchIgnoredApps(context);
  console.log(`[Steam Session] Verified: ${ignoredCount} ignored apps found`);

  await updateEnvFile(cookie);

  await context.close();
  console.log("[Steam Session] Done!");
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
