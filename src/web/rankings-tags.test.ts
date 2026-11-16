import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page, Route } from "playwright";
import { buildViewerAssets, closeViewerBrowser, launchViewerBrowser, type ViewerAssets } from "./testing";

const vocabulary = [
  { name: "Strategy", count: 1200 },
  { name: "Action", count: 3000 },
  { name: "Action RPG", count: 400 },
  { name: "City Builder", count: 150 },
  { name: "Real-Time with Pause", count: 20 },
  { name: "Extremely Long Tag Name That Should Wrap Instead Of Overflowing The Page", count: 3 },
];

function game(id: number, name: string, tags: string[] | string | null) {
  return {
    id, steamAppId: id, name, steamReviewScore: 95, steamReviewCount: 1234,
    hltbMain: 8, valueScore: 10000 - id, isOnWishlist: false, isEarlyAccess: false,
    controllerSupport: null, isOwned: false, playtimeMinutes: 0, isIgnored: false,
    hasSinglePlayer: true, hasMultiplayer: false, hasCoOp: false, hasOnlineCoOp: false,
    hasLocalCoOp: false, hasPvP: false, hasOnlinePvP: false, hasLocalPvP: false,
    hasCrossplatform: false, isMMO: false, tags: Array.isArray(tags) ? JSON.stringify(tags) : tags,
    deals: { status: "unknown", checkedAt: null, offers: [] },
  };
}

const catalog = [
  game(1, "Fortress Builder", ["Strategy", "City Builder", "Simulation", "Management", "Building", "Relaxing"]),
  game(2, "Plain Game", null),
  game(3, "Broken Tags", "not json"),
  game(4, '<img src=x onerror="alert(1)">', ['<b>bold</b>', "Strategy"]),
];

async function eventually<T>(read: () => T | Promise<T>, expected: T) {
  let actual = await read();
  for (let attempt = 0; attempt < 100 && !Bun.deepEquals(actual, expected); attempt++) {
    await Bun.sleep(25);
    actual = await read();
  }
  expect(actual).toEqual(expected);
}

interface PageOptions {
  width?: number;
  path?: string;
  tags?: (route: Route) => Promise<void>;
}

describe("Rankings tag filters", () => {
  let browser: Browser;
  let assets: ViewerAssets;
  beforeAll(async () => {
    assets = await buildViewerAssets();
    browser = await launchViewerBrowser();
  });
  afterAll(async () => { await closeViewerBrowser(browser); });

  async function withPage(run: (page: Page, requests: URLSearchParams[]) => Promise<void>, options: PageOptions = {}) {
    const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors: string[] = [];
    const unexpected: string[] = [];
    const requests: URLSearchParams[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === "https://steam-value.test") {
        const asset = assets.get(url.pathname);
        if (asset) return route.fulfill(asset);
        if (url.pathname === "/api/games") {
          requests.push(url.searchParams);
          return route.fulfill({ json: catalog });
        }
        if (url.pathname === "/api/tags") return options.tags ? options.tags(route) : route.fulfill({ json: vocabulary });
        if (url.pathname === "/api/sync-state") return route.fulfill({ json: null });
        if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204 });
      }
      unexpected.push(url.href);
      return route.abort();
    });
    try {
      await page.goto(`https://steam-value.test${options.path ?? "/"}`);
      await page.waitForFunction(() => document.querySelectorAll("#games-list tr").length > 0);
      await run(page, requests);
      expect(errors).toEqual([]);
      expect(unexpected).toEqual([]);
    } finally {
      await context.close();
    }
  }

  const include = (page: Page) => page.getByRole("combobox", { name: "Include tags", exact: true });
  const exclude = (page: Page) => page.getByRole("combobox", { name: "Exclude tags", exact: true });
  const chips = (page: Page, list: "include" | "exclude") => page.locator(`#${list}-tag-chips button`).evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
  const lastRequest = (requests: URLSearchParams[]) => requests.at(-1)!;
  async function addTag(requests: URLSearchParams[], box: ReturnType<typeof include>, text: string) {
    const before = requests.length;
    await box.fill(text);
    await box.press("Enter");
    await eventually(() => requests.length > before, true);
  }

  test("suggests the tag vocabulary with game counts", async () => {
    await withPage(async (page) => {
      await eventually(() => page.locator("#tag-options option").count(), vocabulary.length);
      const options = await page.locator("#tag-options option").evaluateAll((nodes) => nodes.map((node) => [(node as HTMLOptionElement).value, (node as HTMLOptionElement).label]));
      expect(options[0]).toEqual(["Strategy", "1,200 games"]);
      expect(await include(page).getAttribute("list")).toBe("tag-options");
      expect(await exclude(page).getAttribute("list")).toBe("tag-options");
    });
  });

  test("shows each game's first three Top Tags, escaped, in the table and cards", async () => {
    await withPage(async (page) => {
      const names = page.locator("#games-list .game-name");
      expect(await names.nth(0).locator(".top-tags").innerText()).toBe("Strategy, City Builder, Simulation");
      expect(await names.nth(1).locator(".top-tags").count()).toBe(0);
      expect(await names.nth(2).locator(".top-tags").count()).toBe(0);
      expect(await names.nth(3).locator(".top-tags").innerText()).toBe("<b>bold</b>, Strategy");
      expect(await page.locator("#games-list b, #games-list img").count()).toBe(0);
      expect(await page.locator("#games-cards .game-card").nth(0).locator(".top-tags").textContent()).toBe("Strategy, City Builder, Simulation");
    });
  });

  test("adds and removes chips, sending repeated includeTag and excludeTag parameters", async () => {
    await withPage(async (page, requests) => {
      expect(Object.fromEntries(lastRequest(requests))).toEqual({ hideIgnored: "true", limit: "100", offset: "0" });
      await addTag(requests, include(page), "strategy");
      expect(await chips(page, "include")).toEqual(["Remove Strategy"]);
      expect(await include(page).inputValue()).toBe("");
      expect(lastRequest(requests).getAll("includeTag")).toEqual(["Strategy"]);
      await addTag(requests, include(page), "CITY BUILDER");
      expect(lastRequest(requests).getAll("includeTag")).toEqual(["Strategy", "City Builder"]);
      await addTag(requests, exclude(page), "Action");
      expect(lastRequest(requests).getAll("excludeTag")).toEqual(["Action"]);
      expect(lastRequest(requests).getAll("includeTag")).toEqual(["Strategy", "City Builder"]);

      await page.getByRole("button", { name: "Remove Strategy", exact: true }).click();
      await eventually(() => lastRequest(requests).getAll("includeTag"), ["City Builder"]);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("include-tag");
      await page.getByRole("button", { name: "Remove City Builder", exact: true }).click();
      await page.getByRole("button", { name: "Remove Action", exact: true }).click();
      await eventually(() => Object.fromEntries(lastRequest(requests)), { hideIgnored: "true", limit: "100", offset: "0" });
      expect(await page.locator(".tag-chips button").count()).toBe(0);
    });
  });

  test("a tag lives in one list at a time", async () => {
    await withPage(async (page, requests) => {
      await addTag(requests, exclude(page), "Action");
      await addTag(requests, include(page), "action");
      expect(await chips(page, "include")).toEqual(["Remove Action"]);
      expect(await chips(page, "exclude")).toEqual([]);
      expect(lastRequest(requests).getAll("includeTag")).toEqual(["Action"]);
      expect(lastRequest(requests).has("excludeTag")).toBe(false);
      await addTag(requests, include(page), "Action");
      expect(await chips(page, "include")).toEqual(["Remove Action"]);
    });
  });

  test("typing alone never adds a tag; a list pick or Enter does; unknown tags are refused with a message", async () => {
    await withPage(async (page, requests) => {
      const before = requests.length;
      await include(page).pressSequentially("Action");
      expect(await chips(page, "include")).toEqual([]);
      expect(requests.length).toBe(before);

      await include(page).press("Space");
      await include(page).pressSequentially("RPG");
      await include(page).press("Enter");
      expect(await chips(page, "include")).toEqual(["Remove Action RPG"]);
      await eventually(() => requests.length > before, true);

      const afterEnter = requests.length;
      await exclude(page).evaluate((input: HTMLInputElement) => {
        input.value = "city builder";
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }));
      });
      await eventually(() => chips(page, "exclude"), ["Remove City Builder"]);
      await eventually(() => requests.length > afterEnter, true);

      const afterPick = requests.length;
      await include(page).fill("Not A Real Tag");
      await include(page).press("Enter");
      expect(await page.locator("#tag-message").innerText()).toBe('No tag named "Not A Real Tag". Choose one of the suggestions.');
      expect(await include(page).getAttribute("aria-invalid")).toBe("true");
      expect(await chips(page, "include")).toEqual(["Remove Action RPG"]);
      expect(requests.length).toBe(afterPick);
      await include(page).fill("Stra");
      expect(await page.locator("#tag-message").innerText()).toBe("");
    });
  });

  test("keeps filter state in the URL and restores it on reload, writing only non-default controls", async () => {
    await withPage(async (page, requests) => {
      expect(page.url()).toBe("https://steam-value.test/");
      await addTag(requests, include(page), "Strategy");
      await addTag(requests, include(page), "City Builder");
      await addTag(requests, exclude(page), "Action");
      await page.getByRole("checkbox", { name: "Hide Ignored", exact: true }).uncheck();
      await page.getByRole("checkbox", { name: "Hide Played", exact: true }).check();
      await page.getByLabel("Co-op", { exact: true }).selectOption("online-coop");
      await eventually(() => requests.at(-1)?.get("coop"), "online-coop");
      const search = new URL(page.url()).searchParams;
      expect([...search.keys()].sort()).toEqual(["coop", "excludeTag", "hideIgnored", "hidePlayed", "includeTag", "includeTag"]);
      expect(Object.fromEntries(search)).toMatchObject({ hideIgnored: "false", hidePlayed: "true", coop: "online-coop", excludeTag: "Action" });
      expect(search.getAll("includeTag")).toEqual(["Strategy", "City Builder"]);
      const savedUrl = page.url();

      const before = requests.length;
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll("#games-list tr").length > 0);
      expect(requests.length).toBe(before + 1);
      const restored = lastRequest(requests);
      expect(restored.getAll("includeTag")).toEqual(["Strategy", "City Builder"]);
      expect(restored.getAll("excludeTag")).toEqual(["Action"]);
      expect(restored.has("hideIgnored")).toBe(false);
      expect(restored.get("hidePlayed")).toBe("true");
      expect(restored.get("coop")).toBe("online-coop");
      expect(page.url()).toBe(savedUrl);
      expect(await page.getByRole("checkbox", { name: "Hide Ignored", exact: true }).isChecked()).toBe(false);
      expect(await page.getByRole("checkbox", { name: "Hide Played", exact: true }).isChecked()).toBe(true);
      expect(await page.getByLabel("Co-op", { exact: true }).inputValue()).toBe("online-coop");
      expect(await chips(page, "include")).toEqual(["Remove Strategy", "Remove City Builder"]);
      expect(await chips(page, "exclude")).toEqual(["Remove Action"]);

      await page.getByRole("checkbox", { name: "Hide Ignored", exact: true }).check();
      await page.getByRole("checkbox", { name: "Hide Played", exact: true }).uncheck();
      await page.getByLabel("Co-op", { exact: true }).selectOption("any");
      for (const name of ["Strategy", "City Builder", "Action"]) await page.getByRole("button", { name: `Remove ${name}`, exact: true }).click();
      await eventually(() => page.url(), "https://steam-value.test/");
    });
  });

  test("a URL with no parameters keeps today's defaults", async () => {
    await withPage(async (page, requests) => {
      expect(requests).toHaveLength(1);
      expect(Object.fromEntries(requests[0]!)).toEqual({ hideIgnored: "true", limit: "100", offset: "0" });
      expect(await page.getByRole("checkbox", { name: "Hide Ignored", exact: true }).isChecked()).toBe(true);
      expect(await page.locator(".tag-chips button").count()).toBe(0);
      expect(page.url()).toBe("https://steam-value.test/");
    });
  });

  test("ignores unusable URL values and keeps a tag in only one list", async () => {
    await withPage(async (page, requests) => {
      expect(Object.fromEntries(requests[0]!)).toEqual({ hideIgnored: "true", hidePlayed: "true", includeTag: "Strategy", limit: "100", offset: "0" });
      expect(await page.getByLabel("Co-op", { exact: true }).inputValue()).toBe("any");
      expect(requests[0]!.getAll("includeTag")).toEqual(["Strategy"]);
      expect(requests[0]!.has("excludeTag")).toBe(false);
      expect(await chips(page, "include")).toEqual(["Remove Strategy"]);
    }, { path: "/?coop=bogus&hideIgnored=maybe&hidePlayed=true&includeTag=Strategy&includeTag=strategy&excludeTag=STRATEGY&includeTag=" });
  });

  for (const width of [1440, 390, 320]) {
    test(`filter card and chips fit without page overflow at ${width}px`, async () => {
      const longName = vocabulary.at(-1)!.name;
      await withPage(async (page, requests) => {
        for (const name of ["Strategy", "City Builder", longName]) await addTag(requests, include(page), name);
        for (const name of ["Action", "Action RPG", "Real-Time with Pause"]) await addTag(requests, exclude(page), name);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        for (const box of [include(page), exclude(page)]) {
          expect(await box.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
          await box.focus();
          expect(await box.evaluate((element) => getComputedStyle(element).outlineWidth)).not.toBe("0px");
        }
        const rects = await page.locator(".tag-chip").evaluateAll((buttons) => buttons.map((button) => {
          const { left, right } = button.getBoundingClientRect();
          return { left, right };
        }));
        expect(rects.every(({ left, right }) => left >= 0 && right <= width)).toBe(true);
        const root = page.locator(width > 900 ? "#games-list" : "#games-cards");
        expect(await root.getByText("Strategy, City Builder, Simulation").count()).toBe(1);
      }, { width });
    });
  }

  test("an /api/tags failure leaves games and the page working, and lets a typed tag through", async () => {
    await withPage(async (page, requests) => {
      expect(await page.locator("#games-list tr").count()).toBe(catalog.length);
      expect(await page.locator("#tag-options option").count()).toBe(0);
      await addTag(requests, include(page), "Roguelike");
      expect(lastRequest(requests).getAll("includeTag")).toEqual(["Roguelike"]);
      expect(await chips(page, "include")).toEqual(["Remove Roguelike"]);
    }, { tags: async (route) => route.fulfill({ status: 500, json: { error: "boom" } }) });
  });
});
