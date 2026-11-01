import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { buildViewerAssets, closeViewerBrowser, launchViewerBrowser, textContrast, type ViewerAssets } from "./testing";

describe("Steam Value branding", () => {
  let browser: Browser;
  let assets: ViewerAssets;
  beforeAll(async () => {
    assets = await buildViewerAssets();
    browser = await launchViewerBrowser();
  });
  afterAll(async () => { await closeViewerBrowser(browser); });

  for (const path of ["/", "/city-builders"]) {
    for (const width of [1440, 390, 320, 280]) {
      test(`the shared logo and favicon are accessible without overflow on ${path} at ${width}px`, async () => {
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
            if (url.pathname === "/api/games" || url.pathname === "/api/city-builders") return route.fulfill({ json: [] });
            if (url.pathname === "/api/sync-state") return route.fulfill({ json: null });
          }
          unexpected.push(url.href);
          return route.abort();
        });
        try {
          await page.goto(`https://steam-value.test${path}`);
          const home = page.getByRole("link", { name: "Steam Value home", exact: true });
          expect(await home.isVisible()).toBe(true);
          expect(await home.getAttribute("href")).toBe("/");
          expect(await home.locator("img").evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
          expect(await home.locator("img").getAttribute("alt")).toBe("");
          expect(await home.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
          expect(await page.getByRole("heading", { level: 1 }).allTextContents())
            .toEqual([path === "/" ? "Rankings" : "City Builder Games"]);
          expect(await page.title()).toContain("Steam Value");
          expect(await textContrast(page, ".brand-wordmark")).toBeGreaterThanOrEqual(4.5);
          expect(await textContrast(page, ".page-title")).toBeGreaterThanOrEqual(4.5);
          expect(await page.locator('link[rel="icon"]').evaluateAll((links) => links.map((link) => ({
            href: link.getAttribute("href"), type: link.getAttribute("type"), sizes: link.getAttribute("sizes"),
          })))).toEqual([
            { href: "/favicon.ico", type: null, sizes: "16x16 32x32 48x48" },
            { href: "/favicon.svg", type: "image/svg+xml", sizes: "any" },
          ]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.keyboard.press("Tab");
          expect(await page.locator(".skip-link").evaluate((element) => element === document.activeElement)).toBe(true);
          await page.keyboard.press("Tab");
          expect(await home.evaluate((element) => element === document.activeElement)).toBe(true);
          expect(await home.evaluate((element) => getComputedStyle(element).outlineWidth)).not.toBe("0px");
          if (path !== "/") {
            await page.keyboard.press("Enter");
            await page.waitForURL("https://steam-value.test/");
            expect(await page.getByRole("heading", { level: 1 }).textContent()).toBe("Rankings");
          }
          expect(errors).toEqual([]);
          expect(unexpected).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }

  test("the favicon preserves the approved mark and adapts to light and dark browser chrome", async () => {
    const logo = await Bun.file(new URL("logo.svg", import.meta.url)).text();
    const favicon = await Bun.file(new URL("favicon.svg", import.meta.url)).text();
    const paths = (svg: string) => Array.from(svg.matchAll(/<path[^>]+>/g), (match) => match[0]);
    expect(paths(favicon)).toEqual(paths(logo));
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme });
      const page = await context.newPage();
      try {
        await page.setContent(favicon);
        expect(await page.locator("svg").evaluate((element) => getComputedStyle(element).fill))
          .toBe(colorScheme === "dark" ? "rgb(52, 211, 153)" : "rgb(8, 127, 91)");
      } finally {
        await context.close();
      }
    }
  });
});

test("the fallback favicon contains transparent 16, 32 and 48px PNG images", async () => {
  const ico = Buffer.from(await Bun.file(new URL("favicon.ico", import.meta.url)).arrayBuffer());
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  expect(ico.readUInt16LE(4)).toBe(3);
  let offset = 6 + 3 * 16;
  for (const [index, size] of [16, 32, 48].entries()) {
    const entry = 6 + index * 16;
    expect([ico[entry], ico[entry + 1], ico.readUInt16LE(entry + 4), ico.readUInt16LE(entry + 6)])
      .toEqual([size, size, 1, 32]);
    expect(ico.readUInt32LE(entry + 12)).toBe(offset);
    const bytes = ico.readUInt32LE(entry + 8);
    const png = ico.subarray(offset, offset + bytes);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[25]]).toEqual([size, size, 6]);
    offset += bytes;
  }
  expect(offset).toBe(ico.length);
});
