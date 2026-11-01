import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page, Route } from "playwright";
import { DEAL_MAX_AGE_SECONDS, type DealOffer, type GameDeals } from "../services/deal-types";
import { activeOffers, nextDealChange, renderDeals } from "./deal-display";
import { buildViewerAssets, closeViewerBrowser, launchViewerBrowser, textContrast, type ViewerAssets } from "./testing";

const now = 1_800_000_000;
function displayText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
function offer(overrides: Partial<DealOffer> = {}): DealOffer {
  return {
    kind: "retail", id: "retail-1", title: "Example game", store: "Other Store",
    url: "https://shop.example/game?affiliate=itad&voucher=SAVE%2020",
    priceCents: 799, currency: "USD", discountPercent: 60, drm: [], voucher: "SAVE20",
    note: "Requires an account", expiresAt: null, validUntil: now + 600, ...overrides,
  };
}
function deals(overrides: Partial<GameDeals> = {}): GameDeals {
  return { status: "fresh", checkedAt: now, offers: [offer()], ...overrides };
}
function game(id: number, gameDeals = deals()) {
  return {
    id, steamAppId: id, name: `Game ${id}`, steamReviewScore: 95, steamReviewCount: 1234,
    hltbMain: 8, valueScore: 10000 - id, isOnWishlist: true, isEarlyAccess: false,
    controllerSupport: "full", isOwned: false, playtimeMinutes: 0, isIgnored: false,
    hasSinglePlayer: true, hasMultiplayer: false, hasCoOp: false, hasOnlineCoOp: false,
    hasLocalCoOp: false, hasPvP: false, hasOnlinePvP: false, hasLocalPvP: false,
    hasCrossplatform: false, isMMO: false, deals: gameDeals,
  };
}

describe("deal display", () => {
  test("uses the earliest normalized deadline and expires at the exact boundary", () => {
    const data = deals({ offers: [offer({ validUntil: now }), offer({ id: "later", validUntil: now + 1 })] });
    expect(activeOffers(data, now).map((value) => value.id)).toEqual(["later"]);
    expect(nextDealChange(data, now)).toBe(now + 1);
    expect(activeOffers(data, now + 1)).toEqual([]);
    expect(nextDealChange(deals({ offers: [] }), now + DEAL_MAX_AGE_SECONDS)).toBeNull();
    expect(displayText(renderDeals(data, now + 1))).toBe("—");
  });

  test("uses a neutral placeholder when no current offer can be shown", () => {
    const states: GameDeals["status"][] = ["fresh", "unknown", "unmapped", "partial", "stale"];
    for (const status of states) {
      const html = renderDeals(deals({ status, offers: [] }), now);
      expect(displayText(html)).toBe("—");
      expect(html).not.toContain("href=");
    }
    expect(displayText(renderDeals(deals(), now + 600))).toBe("—");
    expect(displayText(renderDeals(undefined, now))).toBe("—");
  });

  test("shows only the best-price retail discount and first bundle as linked badges", () => {
    const html = renderDeals(deals({ offers: [
      offer({ id: "expensive", priceCents: 1299, discountPercent: 80, url: "https://shop.example/expensive" }),
      offer(),
      offer({ kind: "bundle", title: "Fixed tier", priceCents: 1800, url: "https://bundle.example/tier?affiliate=itad" }),
      offer({ kind: "bundle", id: "choice", priceCents: null, currency: null, note: "Choose 3; add-on purchase may be required" }),
    ] }), now);
    expect(displayText(html)).toBe("60% off In bundle");
    expect(html).toContain('href="https://shop.example/game?affiliate=itad&amp;voucher=SAVE%2020"');
    expect(html).toContain('href="https://bundle.example/tier?affiliate=itad"');
    expect(html.match(/<a /g)).toHaveLength(2);
  });

  test.each([
    { name: "Steam retail with empty DRM", overrides: { id: "shop:61:https://shop.example/direct" }, qualifies: true },
    { name: "third-party Steam key", overrides: { drm: ["Steam"] }, qualifies: true },
    { name: "multiple explicit activations", overrides: { drm: ["GOG", "Steam"] }, qualifies: true },
    { name: "confirmed Steam bundle", overrides: { kind: "bundle", drm: ["Steam"] }, qualifies: true },
    { name: "GOG only", overrides: { drm: ["GOG"] }, qualifies: false },
    { name: "unknown activation", overrides: {}, qualifies: false },
    { name: "store name without identity", overrides: { store: "Steam" }, qualifies: false },
    { name: "different shop ID", overrides: { id: "shop:610:https://shop.example/direct" }, qualifies: false },
    { name: "bundle without activation", overrides: { kind: "bundle", store: "Steam", id: "shop:61:https://shop.example/bundle" }, qualifies: false },
    { name: "similar DRM names", overrides: { drm: ["Steamworks", "Steam Deck"] }, qualifies: false },
    { name: "Steam link without activation", overrides: { url: "https://store.steampowered.com/app/1", title: "Steam key" }, qualifies: false },
  ] satisfies { name: string; overrides: Partial<DealOffer>; qualifies: boolean }[])("requires activation evidence: $name", ({ overrides, qualifies }) => {
    const data = deals({ offers: [offer(overrides)] });
    expect(activeOffers(data, now, true)).toHaveLength(qualifies ? 1 : 0);
    expect(activeOffers(data, now, false)).toHaveLength(1);
    expect(activeOffers(data, now + 600, true)).toEqual([]);
  });

  test("selects the cheapest Steam offer instead of cheaper GOG or unverified bundles", () => {
    const data = deals({ offers: [
      offer({ id: "gog", drm: ["GOG"], priceCents: 100, discountPercent: 90, url: "https://shop.example/gog" }),
      offer({ id: "expensive-key", drm: ["Steam"], priceCents: 700, discountPercent: 30 }),
      offer({ id: "key", drm: ["Steam"], priceCents: 400 }),
      offer({ id: "unknown-bundle", kind: "bundle" }),
    ] });
    const html = renderDeals(data, now, true);
    expect(displayText(html)).toBe("60% off");
    expect(html).toContain('href="https://shop.example/game?affiliate=itad&amp;voucher=SAVE%2020"');
    expect(html).not.toContain("https://shop.example/gog");
    expect(displayText(renderDeals(data, now))).toBe("90% off In bundle");
    expect(displayText(renderDeals(deals(), now, true))).toBe("—");
  });

  test("does not invent a percentage when the retail discount is missing", () => {
    const html = renderDeals(deals({ offers: [offer({ discountPercent: null })] }), now);
    expect(displayText(html)).toBe("—");
    expect(html).not.toContain("href=");
  });

  test("escapes source strings/attributes and does not emit executable URLs", () => {
    const html = renderDeals(deals({ offers: [offer({
      store: '<img src=x onerror="alert(1)">', url: "javascript:alert(1)",
      voucher: '<script>alert(1)</script>', note: '"<script>bad</script>',
    })] }), now);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href=");
    expect(displayText(html)).toBe("60% off");
    const escaped = renderDeals(deals({ offers: [offer({
      url: 'https://shop.example/?q="<script>bad</script>&affiliate=itad',
    })] }), now);
    expect(escaped).toContain('href="https://shop.example/?q=&quot;&lt;script&gt;bad&lt;/script&gt;&amp;affiliate=itad"');
    expect(escaped).not.toContain("<script>");
  });
});

describe("mocked frontend behavior", () => {
  let browser: Browser;
  let assets: ViewerAssets;
  beforeAll(async () => {
    assets = await buildViewerAssets();
    browser = await launchViewerBrowser();
  });
  afterAll(async () => { await closeViewerBrowser(browser); });

  async function withPage(
    gamesHandler: (route: Route, url: URL) => Promise<void>,
    run: (page: Page) => Promise<void>,
    options: { width?: number; syncState?: unknown } = {},
  ) {
    const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install({ time: now * 1000 });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://steam-value.test") return route.abort();
      const asset = assets.get(url.pathname);
      if (asset) return route.fulfill(asset);
      if (url.pathname === "/api/games") return gamesHandler(route, url);
      if (url.pathname === "/api/sync-state") return route.fulfill({ json: options.syncState ?? null });
      return route.abort();
    });
    try {
      await page.goto("https://steam-value.test");
      await run(page);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }

  for (const width of [1920, 1440, 390, 320]) {
    test(`compact Deals field, links and combined filter are usable at ${width}px`, async () => {
      await withPage(async (route) => route.fulfill({ json: [game(1, deals({ offers: [
        offer({ id: "expensive", store: "Expensive Store", priceCents: 1299, drm: ["GOG"] }),
        offer(),
        offer({ kind: "bundle", id: "fixed", title: "Big bundle", store: "Bundle Store", priceCents: 1500, drm: ["Steam"], voucher: null }),
        offer({ kind: "bundle", id: "choice", title: "Choice bundle", priceCents: null, currency: null, note: "Choose 3 / add-on conditions apply" }),
      ] }))] }), async (page) => {
        const root = page.locator(width > 900 ? "#games-list" : "#games-cards");
        await root.getByRole("link", { name: "60% off", exact: true }).waitFor();
        const field = width > 900 ? root.locator("td.deals") : root.locator(".game-card-deals dd");
        expect(await field.count()).toBe(1);
        expect((await field.innerText()).replace(/\s+/g, " ").trim()).toBe("60% off In bundle");
        expect(await field.getByRole("link", { name: "60% off" }).getAttribute("href")).toBe(offer().url);
        expect(await field.getByRole("link", { name: "In bundle" }).count()).toBe(1);
        for (const name of ["60% off", "In bundle"]) {
          const link = field.getByRole("link", { name, exact: true });
          expect(await link.getAttribute("target")).toBe("_blank");
          const rel = (await link.getAttribute("rel"))?.split(/\s+/) ?? [];
          expect(rel).toContain("noopener");
          expect(rel).toContain("noreferrer");
        }
        if (width > 900) {
          const headers = await page.getByRole("columnheader").allTextContents();
          expect(headers[4]).toBe("Deals");
          expect(await root.locator("tr > td").count()).toBe(headers.length);
          expect(await root.locator(".game-name").innerText()).toBe("Game 1");
        } else {
          expect(await root.locator(".game-card-deals dt").textContent()).toBe("Deals");
        }
        expect(await page.locator("#sale-explanation, .deal-info, #deal-status").count()).toBe(0);
        const filter = page.getByRole("checkbox", { name: "On sale or in bundle", exact: true });
        expect(await filter.isVisible()).toBe(true);
        expect(await filter.getAttribute("aria-describedby")).toBeNull();
        expect(await page.getByRole("link", { name: "IsThereAnyDeal", exact: true }).getAttribute("href"))
          .toBe("https://isthereanydeal.com/");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const filtered = page.waitForResponse((res) => new URL(res.url()).searchParams.get("onSale") === "true");
        await filter.check();
        await filtered;
        await root.getByRole("link", { name: "60% off", exact: true }).waitFor();
      }, { width });
    });
  }

  for (const width of [1440, 390, 320]) {
    test(`Steam activation filter works independently by keyboard at ${width}px`, async () => {
      const requests: URLSearchParams[] = [];
      const gog = offer({ id: "gog", drm: ["GOG"], priceCents: 100, discountPercent: 90, url: "https://shop.example/gog" });
      const steam = offer({ id: "steam-key", drm: ["Steam"], priceCents: 400 });
      const bundle = offer({ id: "unknown-bundle", kind: "bundle" });
      await withPage(async (route, url) => {
        requests.push(url.searchParams);
        await route.fulfill({ json: [game(1, deals({ offers: [gog, steam, bundle] })), game(2, deals({ offers: [gog] }))] });
      }, async (page) => {
        const root = page.locator(width > 900 ? "#games-list" : "#games-cards");
        await root.getByRole("link", { name: "90% off" }).first().waitFor();
        const filter = page.getByRole("checkbox", { name: "Activates on Steam only", exact: true });
        expect(await filter.isChecked()).toBe(false);
        expect(await page.locator("#on-sale").isChecked()).toBe(false);
        expect(requests.at(-1)!.has("steamOnly")).toBe(false);
        expect(await filter.locator("..").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        expect(await textContrast(page, "label:has(#steam-only)")).toBeGreaterThanOrEqual(4.5);
        await filter.focus();
        expect(await filter.evaluate((element) => getComputedStyle(element).outlineWidth)).not.toBe("0px");
        const filtered = page.waitForResponse((res) => new URL(res.url()).searchParams.get("steamOnly") === "true");
        await page.keyboard.press("Space");
        await filtered;
        await root.getByRole("link", { name: "60% off" }).waitFor();
        expect(await page.locator("#on-sale").isChecked()).toBe(false);
        expect(Object.fromEntries(requests.at(-1)!)).toEqual({ steamOnly: "true", hideIgnored: "true", limit: "100", offset: "0" });
        expect(await root.getByRole("link", { name: "Game 2", exact: true }).count()).toBe(0);
        expect(await root.getByRole("link", { name: "In bundle" }).count()).toBe(0);
        expect(await root.getByRole("link", { name: "90% off" }).count()).toBe(0);
        expect(await root.getByRole("link", { name: "60% off" }).getAttribute("href")).toBe(steam.url);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await filter.uncheck();
        await root.getByRole("link", { name: "90% off" }).first().waitFor();
        expect(await root.getByRole("link", { name: "Game 2", exact: true }).count()).toBe(1);
        expect(await root.getByRole("link", { name: "In bundle" }).count()).toBe(1);
        expect(requests.at(-1)!.has("steamOnly")).toBe(false);
      }, { width });
    });
  }

  test("uses local 0build styles and keyboard-operated native filters", async () => {
    await withPage(async (route) => route.fulfill({ json: [game(1)] }), async (page) => {
      await page.locator("#games-list tr").waitFor();
      expect(await page.locator('link[rel="stylesheet"]').evaluateAll((links) => links.map((link) => new URL((link as HTMLLinkElement).href).origin)))
        .toEqual(["https://steam-value.test", "https://steam-value.test"]);
      expect(await page.locator("#on-sale").evaluate((element) => getComputedStyle(element).appearance)).toBe("none");
      expect(await page.locator("#on-sale").evaluate((element) => getComputedStyle(element).borderRadius)).toBe("2px");
      expect(await page.locator("#coop-filter").evaluate((element) => getComputedStyle(element).appearance)).toBe("auto");
      expect(await textContrast(page, "#coop-filter option")).toBeGreaterThanOrEqual(4.5);
      expect(await page.locator("html").evaluate((element) => getComputedStyle(element).getPropertyValue("--z-card").trim())).toBe("#151518");
      await page.keyboard.press("Tab");
      expect(await page.locator(".skip-link").evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      expect(await page.locator("#rankings").evaluate((element) => element === document.activeElement)).toBe(true);
      const checkbox = page.getByRole("checkbox", { name: "Hide Ignored", exact: true });
      await checkbox.focus();
      expect(await checkbox.evaluate((element) => getComputedStyle(element).outlineWidth)).not.toBe("0px");
      const filtered = page.waitForResponse((response) => response.url().includes("/api/games") && !new URL(response.url()).searchParams.has("hideIgnored"));
      await page.keyboard.press("Space");
      await filtered;
      expect(await checkbox.isChecked()).toBe(false);
      const controller = page.getByRole("combobox", { name: "Controller", exact: true });
      await controller.focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      expect(await controller.inputValue()).toBe("full");
      expect(await page.locator('nav [aria-current="page"]').innerText()).toBe("Rankings");
      expect(await page.locator("#sync-status").innerText()).toBe("Never refreshed");
    });
  });

  test("keeps long names, Steam Status and distinct estimates/Playtime readable on mobile", async () => {
    const name = '<script>alert("game")</script> ' + "LongGameName".repeat(20);
    await withPage(async (route) => route.fulfill({ json: [{ ...game(1), name, isOwned: true, isEarlyAccess: true, playtimeMinutes: 23 }] }), async (page) => {
      const card = page.locator("#games-cards article");
      await card.waitFor();
      expect(await card.locator(".game-card-title a").innerText()).toBe(name);
      expect(await card.locator("script").count()).toBe(0);
      expect(await card.locator(".game-card-stats").innerText()).toContain("8.0 hrs");
      expect(await card.locator(".game-card-stats").innerText()).toContain("23m");
      expect(await card.locator(".game-card-tags").innerText()).toContain("Owned");
      expect(await card.locator(".game-card-tags").innerText()).toContain("Early Access");
      for (const selector of [".z-label-success", ".z-label-warning", ".z-label-info", ".review-count", ".game-card-score strong"]) {
        expect(await textContrast(page, `#games-cards ${selector}`)).toBeGreaterThanOrEqual(4.5);
      }
      expect(await page.locator("#sync-status").innerText()).toContain("12 updated");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator("#controller-filter").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    }, { width: 320, syncState: { lastSuccessAt: now, gamesUpdated: 12, isRunning: false, lastError: null } });
  });

  test("combines all filters server-side, preserves pagination and resets offset on changes", async () => {
    const requests: URLSearchParams[] = [];
    await withPage(async (route, url) => {
      requests.push(url.searchParams);
      const offset = Number(url.searchParams.get("offset"));
      const steamDeals = deals({ offers: [offer({ drm: ["Steam"] })] });
      const games = offset === 0 ? Array.from({ length: 100 }, (_, index) => game(index + 1, steamDeals)) : [game(101, steamDeals)];
      await route.fulfill({ json: games });
    }, async (page) => {
      await page.waitForFunction(() => document.querySelectorAll("#games-list tr").length === 100);
      await page.locator("#on-sale").check();
      await page.locator("#steam-only").check();
      await page.locator("#hide-ea").check();
      await page.locator("#hide-played").check();
      await page.locator("#hide-mmo").check();
      await page.locator("#single-only").check();
      await page.locator("#coop-filter").selectOption("online-coop");
      await page.locator("#controller-filter").selectOption("full");
      await page.waitForFunction(() => document.querySelectorAll("#games-list tr").length === 100 && !document.querySelector<HTMLButtonElement>("#load-more")!.disabled);
      const expected = { onSale: "true", steamOnly: "true", hideEa: "true", hidePlayed: "true", hideMMO: "true", hideIgnored: "true", singleOnly: "true", coop: "online-coop", controller: "full", limit: "100", offset: "0" };
      expect(Object.fromEntries(requests.at(-1)!)).toEqual(expected);
      await page.locator("#load-more").click();
      await page.waitForFunction(() => document.querySelectorAll("#games-list tr").length === 101);
      expect(Object.fromEntries(requests.at(-1)!)).toEqual({ ...expected, offset: "100" });
      expect(await page.locator("#load-more").isVisible()).toBe(false);
      await page.locator("#on-sale").uncheck();
      await page.waitForFunction(() => document.querySelectorAll("#games-list tr").length === 100);
      expect(requests.at(-1)!.has("onSale")).toBe(false);
      expect(requests.at(-1)!.get("steamOnly")).toBe("true");
      await page.locator("#load-more").click();
      await page.waitForFunction(() => document.querySelectorAll("#games-list tr").length === 101);
      await page.locator("#steam-only").uncheck();
      await page.waitForFunction(() => document.querySelectorAll("#games-list tr").length === 100);
      expect(requests.at(-1)!.has("steamOnly")).toBe(false);
      expect(requests.at(-1)!.get("offset")).toBe("0");
      expect(requests.at(-1)!.get("coop")).toBe("online-coop");
    });
  });

  test("ignores a late earlier-filter response even if fetch cancellation is ineffective", async () => {
    let release: (() => void) | undefined;
    const delayedStarted = Promise.withResolvers<void>();
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    await withPage(async (route, url) => {
      if (url.searchParams.has("onSale")) {
        delayedStarted.resolve();
        await delayed;
        await route.fulfill({ json: [game(999)] });
      } else {
        await route.fulfill({ json: [game(1)] });
      }
    }, async (page) => {
      await page.waitForSelector("#games-list tr");
      await page.evaluate(() => {
        window.fetch = new Proxy(window.fetch, {
          apply(target, receiver, [input, init]) {
            return Reflect.apply(target, receiver, [input, { ...init, signal: undefined }]);
          },
        });
      });
      await page.locator("#on-sale").check();
      await delayedStarted.promise;
      await page.locator("#on-sale").uncheck();
      await page.waitForSelector("#games-list tr");
      const response = page.waitForResponse((res) => res.url().includes("onSale=true"));
      release!();
      await response;
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(await page.locator("#games-list tr").count()).toBe(1);
      expect(await page.locator("#games-list .game-name > a").innerText()).toBe("Game 1");
    });
  });

  test("handles errors/retry and genuinely empty filtered results without refetch loops", async () => {
    let calls = 0;
    await withPage(async (route) => {
      calls++;
      await route.fulfill(calls === 1 ? { status: 503 } : { json: [] });
    }, async (page) => {
      await page.locator("#games-error").waitFor();
      expect(await page.locator("#load-more").innerText()).toBe("Retry loading");
      await page.locator("#load-more").click();
      await page.locator("#games-empty").waitFor();
      expect(await page.locator("#games-error").isVisible()).toBe(false);
      await page.locator("#on-sale").check();
      await page.locator("#games-empty").waitFor();
      expect(await page.locator("#games-empty").innerText()).toContain("Missing, stale or unmatched");
      const before = calls;
      await page.clock.runFor(120_000);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(calls).toBe(before);
    });
  });

  test("Steam-only expiry resets pagination and explains empty results despite a current non-Steam offer", async () => {
    let calls = 0;
    await withPage(async (route) => {
      calls++;
      await route.fulfill({ json: [game(1, deals({ offers: [
        offer({ id: "steam-key", drm: ["Steam"], validUntil: now + 10 }),
        offer({ id: "gog", drm: ["GOG"], validUntil: now + 600 }),
      ] }))] });
    }, async (page) => {
      await page.waitForSelector("#games-list tr");
      await page.locator("#steam-only").check();
      await page.waitForSelector("#games-list tr");
      expect(calls).toBe(2);
      await page.clock.setSystemTime((now + 20) * 1000);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.locator("#games-empty").waitFor();
      expect(await page.locator("#games-list tr").count()).toBe(0);
      expect(await page.locator("#games-empty").innerText()).toContain("Steam-activating");
      expect(await page.locator("#games-empty").innerText()).toContain("unconfirmed activation");
      expect(calls).toBe(3);
      await page.clock.runFor(120_000);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(calls).toBe(3);
      await page.locator("#steam-only").uncheck();
      await page.locator("#games-list .deal-badge").waitFor();
      expect(await page.locator("#games-empty").isVisible()).toBe(false);
    });
  });

  test("replaces expired offers with a neutral placeholder without refetching the unfiltered list", async () => {
    let calls = 0;
    await withPage(async (route) => {
      calls++;
      await route.fulfill({ json: [game(1, deals({ offers: [offer({ validUntil: now + 10, expiresAt: now + 10 })] })), game(2, deals({ offers: [] }))] });
    }, async (page) => {
      const root = page.locator("#games-list");
      await root.getByRole("link", { name: "60% off" }).waitFor();
      await page.clock.runFor(30_000);
      expect(await root.locator(".deal-badge").count()).toBe(0);
      expect(await root.locator("td.deals").allTextContents()).toEqual(["—", "—"]);
      await page.clock.fastForward(DEAL_MAX_AGE_SECONDS * 1000);
      expect(await root.locator("td.deals").allTextContents()).toEqual(["—", "—"]);
      expect(calls).toBe(1);
    });
  });

  test("visibility expiry restarts sale pagination once, even if a cached response still contains expired offers", async () => {
    let calls = 0;
    await withPage(async (route) => {
      calls++;
      await route.fulfill({ json: [game(1, deals({ offers: [offer({ validUntil: now + 10 })] }))] });
    }, async (page) => {
      await page.waitForSelector("#games-list tr");
      await page.locator("#on-sale").check();
      await page.waitForSelector("#games-list tr");
      expect(calls).toBe(2);
      await page.clock.setSystemTime((now + 20) * 1000);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.locator("#games-empty").waitFor();
      expect(await page.locator("#games-list .deal-badge").count()).toBe(0);
      expect(calls).toBe(3);
      await page.clock.runFor(120_000);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(calls).toBe(3);
    });
  });
});
