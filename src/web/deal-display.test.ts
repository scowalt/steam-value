import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { DEAL_MAX_AGE_SECONDS, type DealOffer, type DealRefreshStatus, type GameDeals } from "../services/deal-types";
import { activeOffers, formatDealRefreshStatus, nextDealChange, renderDeals } from "./deal-display";

const now = 1_800_000_000;
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
function refresh(overrides: Partial<DealRefreshStatus> = {}): DealRefreshStatus {
  return {
    country: "US", currency: "USD", maxAgeSeconds: DEAL_MAX_AGE_SECONDS,
    lastAttemptAt: now, lastSuccessAt: now, lastError: null, isRunning: false,
    gamesChecked: 10, totalGames: 10, freshGames: 10, ...overrides,
  };
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

// These test normalized display semantics, not the backend's ITAD parser/eligibility rules.
describe("deal display", () => {
  test("uses the earliest normalized deadline and expires at the exact boundary", () => {
    const data = deals({ offers: [offer({ validUntil: now }), offer({ id: "later", validUntil: now + 1 })] });
    expect(activeOffers(data, now).map((value) => value.id)).toEqual(["later"]);
    expect(nextDealChange(data, now)).toBe(now + 1);
    expect(activeOffers(data, now + 1)).toEqual([]);
    expect(nextDealChange(deals({ offers: [] }), now + DEAL_MAX_AGE_SECONDS)).toBeNull();
    expect(renderDeals(deals({ offers: [] }), now + DEAL_MAX_AGE_SECONDS)).toContain("Sale data stale");
  });

  test("distinguishes incomplete states and expired data from confirmed empty results", () => {
    expect(renderDeals(deals({ offers: [] }), now)).toContain("No current discounts or bundles reported");
    expect(renderDeals(deals({ status: "unknown", offers: [] }), now)).toContain("not available yet");
    expect(renderDeals(deals({ status: "unmapped", offers: [] }), now)).toContain("No IsThereAnyDeal match");
    expect(renderDeals(deals({ status: "partial", offers: [] }), now)).toContain("some sources unavailable");
    expect(renderDeals(deals({ status: "stale", offers: [] }), now)).toContain("Sale data stale");
    expect(renderDeals(deals(), now + 600)).toContain("Cached offers expired");
    expect(renderDeals(undefined, now)).toContain("not available yet");
  });

  test("never treats bundle totals as per-game prices or null as free", () => {
    const html = renderDeals(deals({ offers: [
      offer({ kind: "bundle", title: "Fixed tier", priceCents: 1800 }),
      offer({ kind: "bundle", id: "choice", title: "Choice bundle", priceCents: null, currency: null, note: "Choose 3; add-on purchase may be required" }),
    ] }), now);
    expect(html).toContain("Bundle tier total: $18.00 USD");
    expect(html).toContain("see provider for price and selection requirements");
    expect(html).toContain("Choose 3; add-on purchase may be required");
    expect(html).not.toContain("60% off");
    expect(html).not.toContain("$0.00");
  });

  test("escapes source strings/attributes and does not emit executable URLs", () => {
    const html = renderDeals(deals({ offers: [offer({
      store: '<img src=x onerror="alert(1)">', url: "javascript:alert(1)",
      voucher: '<script>alert(1)</script>', note: '"<script>bad</script>',
    })] }), now);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href=");
    expect(html).toContain("&lt;script&gt;");
  });

  test("global status ages without another fetch and exposes failed/partial refresh information", () => {
    expect(formatDealRefreshStatus(refresh(), now)).toContain("within 24h");
    expect(formatDealRefreshStatus(refresh(), now + DEAL_MAX_AGE_SECONDS)).toContain("stale");
    expect(formatDealRefreshStatus(refresh({ isRunning: true, lastError: "Source unavailable", freshGames: 2 }), now))
      .toContain("Coverage at status check: 2/10 games fresh");
    expect(formatDealRefreshStatus(refresh({ lastSuccessAt: null }), now)).toContain("No successful sale refresh yet");
    expect(formatDealRefreshStatus(null, now)).toContain("status unavailable");
  });
});

// Browser smoke tests use only in-process route interception: no server, real API or secrets.
describe("mocked frontend behavior", () => {
  let browser: Browser;
  let html: string;
  let script: string;
  beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [new URL("./app.ts", import.meta.url).pathname], target: "browser" });
    if (!build.success || !build.outputs[0]) throw new Error("Frontend bundle failed");
    script = await build.outputs[0].text();
    html = await Bun.file(new URL("./index.html", import.meta.url)).text();
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => { await browser?.close(); });

  async function withPage(
    gamesHandler: (route: Route, url: URL) => Promise<void>,
    run: (page: Page) => Promise<void>,
    options: { width?: number; failedStatus?: boolean } = {},
  ) {
    const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install({ time: now * 1000 });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://steam-value.test") return route.abort();
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
      if (url.pathname === "/app.js") return route.fulfill({ contentType: "application/javascript", body: script });
      if (url.pathname === "/api/games") return gamesHandler(route, url);
      if (url.pathname === "/api/sync-state") return route.fulfill({ json: null });
      if (url.pathname === "/api/deal-state") return route.fulfill(options.failedStatus ? { status: 503 } : { json: refresh() });
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
    test(`retail and bundle details, links and filters are usable at ${width}px`, async () => {
      await withPage(async (route) => route.fulfill({ json: [game(1, deals({ offers: [
        offer({ id: "expensive", store: "Expensive Store", priceCents: 1299, drm: ["GOG"] }),
        offer(),
        offer({ kind: "bundle", id: "fixed", title: "Big bundle", store: "Bundle Store", priceCents: 1500, drm: ["Steam"], voucher: null }),
        offer({ kind: "bundle", id: "choice", title: "Choice bundle", priceCents: null, currency: null, note: "Choose 3 / add-on conditions apply" }),
      ] }))] }), async (page) => {
        const root = page.locator(width > 900 ? "#games-list" : "#games-cards");
        await root.locator(".deal-offer").first().waitFor();
        expect(await root.locator(".deal-offer").first().innerText()).toContain("Other Store");
        expect(await root.locator(".deal-offer").first().innerText()).toContain("$7.99 USD · 60% off");
        expect(await root.locator(".deal-offer").first().innerText()).toContain("DRM not reported");
        expect(await root.locator(".deal-offer").first().innerText()).toContain("Requires voucher: SAVE20");
        expect(await root.locator(".deal-offer a").first().getAttribute("href")).toBe(offer().url);
        expect(await root.innerText()).toContain("Bundle tier total: $15.00 USD");
        expect(await root.innerText()).not.toContain("$12.99");
        await root.getByText("More retail offers (1)", { exact: true }).click();
        expect(await root.innerText()).toContain("$12.99 USD");
        expect(await root.innerText()).toContain("DRM: GOG");
        await root.getByText("More bundle opportunities (1)", { exact: true }).click();
        expect(await root.innerText()).toContain("Choose 3 / add-on conditions apply");
        expect(await root.innerText()).not.toContain("$0.00");
        expect(await page.locator("#on-sale").isVisible()).toBe(true);
        expect(await page.locator("#sale-explanation").innerText()).toContain("other stores");
        expect(await page.locator("#deal-status").innerText()).toContain("within 24h");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const filtered = page.waitForResponse((res) => new URL(res.url()).searchParams.get("onSale") === "true");
        await page.locator("#on-sale").check();
        await filtered;
        await root.locator(".deal-offer").first().waitFor();
      }, { width });
    });
  }

  test("combines all filters server-side, preserves pagination and resets offset on changes", async () => {
    const requests: URLSearchParams[] = [];
    await withPage(async (route, url) => {
      requests.push(url.searchParams);
      const offset = Number(url.searchParams.get("offset"));
      const games = offset === 0 ? Array.from({ length: 100 }, (_, index) => game(index + 1)) : [game(101)];
      await route.fulfill({ json: games });
    }, async (page) => {
      await page.waitForFunction(() => document.querySelectorAll("#games-list tr").length === 100);
      await page.locator("#on-sale").check();
      await page.locator("#hide-ea").check();
      await page.locator("#hide-played").check();
      await page.locator("#hide-mmo").check();
      await page.locator("#single-only").check();
      await page.locator("#coop-filter").selectOption("online-coop");
      await page.locator("#controller-filter").selectOption("full");
      await page.waitForFunction(() => document.querySelectorAll("#games-list tr").length === 100 && !document.querySelector<HTMLButtonElement>("#load-more")!.disabled);
      const expected = { onSale: "true", hideEa: "true", hidePlayed: "true", hideMMO: "true", hideIgnored: "true", singleOnly: "true", coop: "online-coop", controller: "full", limit: "100", offset: "0" };
      expect(Object.fromEntries(requests.at(-1)!)).toEqual(expected);
      await page.locator("#load-more").click();
      await page.waitForFunction(() => document.querySelectorAll("#games-list tr").length === 101);
      expect(Object.fromEntries(requests.at(-1)!)).toEqual({ ...expected, offset: "100" });
      expect(await page.locator("#load-more").isVisible()).toBe(false);
      await page.locator("#on-sale").uncheck();
      await page.waitForFunction(() => document.querySelectorAll("#games-list tr").length === 100);
      expect(requests.at(-1)!.has("onSale")).toBe(false);
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
      // Model a response already past the network/abort boundary, testing the generation guard.
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
      // Let the stale JSON continuation finish before asserting it didn't append or replace rows.
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
      expect(await page.locator("#deal-status").innerText()).toContain("status unavailable");
      await page.locator("#on-sale").check();
      await page.locator("#games-empty").waitFor();
      expect(await page.locator("#games-empty").innerText()).toContain("Missing, stale or unmatched");
      const before = calls;
      await page.clock.runFor(120_000);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(calls).toBe(before);
    }, { failedStatus: true });
  });

  test("removes expired offers in an open tab and stale empty data is not confirmed no offers", async () => {
    let calls = 0;
    await withPage(async (route) => {
      calls++;
      await route.fulfill({ json: [game(1, deals({ offers: [offer({ validUntil: now + 10, expiresAt: now + 10 })] })), game(2, deals({ offers: [] }))] });
    }, async (page) => {
      await page.waitForSelector("#games-list .deal-offer");
      await page.clock.runFor(30_000);
      expect(await page.locator("#games-list .deal-offer").count()).toBe(0);
      expect(await page.locator("#games-list").innerText()).toContain("Cached offers expired");
      expect(await page.locator("#games-list").innerText()).toContain("No current discounts or bundles reported");
      await page.clock.fastForward(DEAL_MAX_AGE_SECONDS * 1000);
      expect(await page.locator("#games-list").innerText()).toContain("Sale data stale");
      expect(await page.locator("#games-list").innerText()).not.toContain("No current discounts or bundles reported");
      expect(await page.locator("#deal-status").innerText()).toContain("stale");
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
      // Advance wall time without firing the interval, like a suspended/background tab.
      await page.clock.setSystemTime((now + 20) * 1000);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.locator("#games-empty").waitFor();
      expect(await page.locator("#games-list .deal-offer").count()).toBe(0);
      expect(calls).toBe(3);
      await page.clock.runFor(120_000);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(calls).toBe(3);
    });
  });
});
