import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page, Route } from "playwright";
import { buildViewerAssets, closeViewerBrowser, launchViewerBrowser, type ViewerAssets } from "./testing";

const games = [
  { steam_app_id: 1, name: "Cedar City", steam_review_score: 95, steam_review_count: 1200, hltb_main: 8, controller_support: "full", playtime_minutes: 30, tag_rank: 1, value_score: 120, weighted_score: 120 },
  { steam_app_id: 2, name: "Amber Town", steam_review_score: 90, steam_review_count: 800, hltb_main: 12.5, controller_support: "partial", playtime_minutes: 0, tag_rank: 3, value_score: 150, weighted_score: 50 },
  { steam_app_id: 3, name: "Birch Village", steam_review_score: null, steam_review_count: null, hltb_main: null, controller_support: null, playtime_minutes: null, tag_rank: null, value_score: null, weighted_score: null },
];

describe("0build city-builder view", () => {
  let browser: Browser;
  let assets: ViewerAssets;
  beforeAll(async () => {
    assets = await buildViewerAssets();
    browser = await launchViewerBrowser();
  });
  afterAll(async () => { await closeViewerBrowser(browser); });

  async function withPage(handler: (route: Route) => Promise<void>, run: (page: Page) => Promise<void>, width = 1440) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors: string[] = [];
    const unexpected: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === "https://steam-value.test") {
        const asset = assets.get(url.pathname);
        if (asset) return route.fulfill(asset);
        if (url.pathname === "/api/city-builders") return handler(route);
        if (url.pathname === "/api/games") return route.fulfill({ json: [] });
        if (url.pathname === "/api/sync-state") return route.fulfill({ json: null });
        if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204 });
      }
      unexpected.push(url.href);
      return route.abort();
    });
    try {
      await page.goto("https://steam-value.test/city-builders");
      await run(page);
      expect(errors).toEqual([]);
      expect(unexpected).toEqual([]);
    } finally {
      await context.close();
    }
  }

  for (const width of [1920, 1440, 390, 320]) {
    test(`renders styled, safely linked results without page overflow at ${width}px`, async () => {
      await withPage(async (route) => route.fulfill({ json: games }), async (page) => {
        await page.waitForFunction(() => document.querySelectorAll("#tbody tr").length === 3);
        expect(await page.locator("#visible-count").innerText()).toBe("Showing 3 of 3");
        expect(await page.locator("#tbody .name").allTextContents()).toEqual(["Cedar City", "Amber Town", "Birch Village"]);
        expect(await page.locator("#tbody .z-label").allTextContents()).toEqual(["Full", "Partial"]);
        expect(await page.locator("#search").evaluate((element) => getComputedStyle(element).borderRadius)).toBe("6px");
        expect(await page.locator("#tbody tr").first().locator("td").nth(4).innerText()).toBe("8.0h");
        expect(await page.locator("#tbody tr").first().locator("td").nth(6).innerText()).toBe("0.5h");
        const link = page.getByRole("link", { name: "Cedar City", exact: true });
        expect(await link.getAttribute("href")).toBe("https://store.steampowered.com/app/1");
        expect(await link.getAttribute("target")).toBe("_blank");
        expect(await link.getAttribute("rel")).toBe("noopener noreferrer");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width < 900) {
          expect(await page.locator(".table-shell").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
          await page.locator(".table-shell").focus();
          await page.keyboard.press("End");
        }
        await page.getByRole("searchbox", { name: "Search games", exact: true }).fill("AMBER");
        expect(await page.locator("#tbody .name").allTextContents()).toEqual(["Amber Town"]);
        expect(await page.locator("#visible-count").innerText()).toBe("Showing 1 of 3");
        await page.locator("#search").fill("no matching game");
        expect(await page.locator("#city-empty").isVisible()).toBe(true);
        expect(await page.locator("#tbody tr").count()).toBe(0);
        await page.locator("#search").fill("");
        expect(await page.locator("#city-empty").isVisible()).toBe(false);
        expect(await page.locator("#tbody tr").count()).toBe(3);
      }, width);
    });
  }

  test("sorts by keyboard and pointer with nulls last and accurate aria-sort", async () => {
    await withPage(async (route) => route.fulfill({ json: games }), async (page) => {
      await page.locator("#tbody tr").first().waitFor();
      const gameHeading = page.getByRole("button", { name: "Game", exact: true });
      await gameHeading.focus();
      expect(await gameHeading.evaluate((element) => getComputedStyle(element).outlineWidth)).not.toBe("0px");
      await page.keyboard.press("Enter");
      expect(await page.locator("#tbody .name").allTextContents()).toEqual(["Amber Town", "Birch Village", "Cedar City"]);
      expect(await page.locator('[data-key="name"]').getAttribute("aria-sort")).toBe("ascending");
      await page.keyboard.press("Space");
      expect(await page.locator("#tbody .name").allTextContents()).toEqual(["Cedar City", "Birch Village", "Amber Town"]);
      const score = page.getByRole("button", { name: "Value Score", exact: true });
      await score.click();
      expect(await page.locator("#tbody .name").allTextContents()).toEqual(["Amber Town", "Cedar City", "Birch Village"]);
      expect(await page.locator('[data-key="value_score"]').getAttribute("aria-sort")).toBe("descending");
      await score.click();
      expect(await page.locator("#tbody .name").allTextContents()).toEqual(["Cedar City", "Amber Town", "Birch Village"]);
      expect(await page.locator('[data-key="name"]').getAttribute("aria-sort")).toBe("none");
      await page.getByRole("link", { name: "Rankings", exact: true }).click();
      await page.locator("#games-empty").waitFor();
      expect(await page.locator('nav [aria-current="page"]').innerText()).toBe("Rankings");
    });
  });

  test("shows loading, a recoverable HTTP failure, and a genuine empty response", async () => {
    let calls = 0;
    const release = Promise.withResolvers<void>();
    await withPage(async (route) => {
      calls++;
      if (calls === 1) {
        await release.promise;
        return route.fulfill({ status: 503, json: { error: "unavailable" } });
      }
      return route.fulfill({ json: [] });
    }, async (page) => {
      expect(await page.locator("#subtitle").innerText()).toBe("Loading city builders…");
      expect(await page.locator("#city-empty").isVisible()).toBe(false);
      release.resolve();
      await page.locator("#city-error").waitFor();
      await page.getByRole("button", { name: "Retry loading", exact: true }).click();
      await page.locator("#city-empty").waitFor();
      expect(await page.locator("#city-error").isVisible()).toBe(false);
      expect(await page.locator("#city-retry").isVisible()).toBe(false);
      expect(await page.locator("#visible-count").innerText()).toBe("Showing 0 of 0");
      expect(calls).toBe(2);
    });
  });

  test("rejects a non-array response and escapes long names", async () => {
    let calls = 0;
    const name = '<img src=x onerror="alert(1)">' + "LongName".repeat(30);
    await withPage(async (route) => route.fulfill({ json: ++calls === 1 ? { error: "bad data" } : [{ ...games[0], name }] }), async (page) => {
      await page.locator("#city-error").waitFor();
      await page.locator("#city-retry").click();
      await page.locator("#tbody tr").waitFor();
      expect(await page.locator("#tbody .name").innerText()).toBe(name);
      expect(await page.locator("#tbody img").count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }, 320);
  });
});

test("vendored 0build release retains exact upstream assets and license", async () => {
  for (const [file, digest] of Object.entries({
    "kit.min.css": "0fd39628261d49d8c768e34544c8a8b62f1eb962570b7ae5d4f9bea1a8cb5c24",
    "LICENSE.md": "64252d0a5fdd5cebfe5ac8b0492c80675350c60bcffa1c75808e132ca96caaff",
  })) {
    const contents = await Bun.file(new URL(`vendor/0build/0.6.13/${file}`, import.meta.url)).arrayBuffer();
    expect(new Bun.CryptoHasher("sha256").update(contents).digest("hex")).toBe(digest);
  }
});
