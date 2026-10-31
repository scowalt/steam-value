import { expect, spyOn, test } from "bun:test";
import { createSteamCatalogProvider, parseArgs } from "../../scripts/refresh-steam-catalog";
import { SteamClient } from "./steam-client";

const summary = { total_positive: 91, total_negative: 9, total_reviews: 100 };
const options = parseArgs(["--retries", "0", "--review-delay-ms", "0"]);

function expectReviewRequest(url: URL, appId: number) {
  expect(url.origin).toBe("https://api.steampowered.com");
  expect(url.pathname).toBe("/IUserReviewsService/GetAppReviews/v1/");
  expect([...url.searchParams.keys()]).toEqual(["input_json"]);
  expect(JSON.parse(url.searchParams.get("input_json")!)).toEqual({ appid: appId, filter: 0, languages: ["all"], review_type: 0, purchase_type: 1, num_per_page: 1 });
}

test("catalog reads the documented review service envelope without a success flag or publisher key", async () => {
  const provider = createSteamCatalogProvider("private-app-list-key", async (url) => {
    expectReviewRequest(url, 10);
    return Response.json({ response: { query_summary: summary } });
  });
  expect(await provider.fetchReviewSummary({ appid: 10, name: "Example" }, options)).toEqual({ totalPositive: 91, totalNegative: 9, totalReviews: 100 });
});

test("manual Steam client preserves score, name and cache with the new review service", async () => {
  const calls: string[] = [];
  const transport = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.href);
    if (url.pathname === "/api/appdetails") return Response.json({ "10": { success: true, data: { name: "Example" } } });
    expectReviewRequest(url, 10);
    return Response.json({ response: { query_summary: summary } });
  }, { preconnect: fetch.preconnect }));
  try {
    const client = new SteamClient({ minDelayMs: 0, maxRetries: 0 });
    expect(await client.fetchSteamData(10)).toEqual({ appId: 10, name: "Example", reviewScore: 91, reviewCount: 100 });
    expect(await client.fetchSteamData(10)).toEqual({ appId: 10, name: "Example", reviewScore: 91, reviewCount: 100 });
    expect(calls).toHaveLength(2);
    expect(client.getStats()).toEqual({ requests: 2, cacheHits: 1, retries: 0 });
  } finally { transport.mockRestore(); }
});

test("zero reviews are data, but a missing or malformed service summary is not zero", async () => {
  const empty = createSteamCatalogProvider("unused", async () => Response.json({ response: { query_summary: { total_positive: 0, total_negative: 0, total_reviews: 0 } } }));
  expect(await empty.fetchReviewSummary({ appid: 10, name: "Example" }, options)).toEqual({ totalPositive: 0, totalNegative: 0, totalReviews: 0 });
  for (const value of [{}, { response: {} }, { response: { query_summary: { ...summary, total_reviews: -1 } } }, { response: { query_summary: { ...summary, total_positive: "private-invalid-value" } } }]) {
    const provider = createSteamCatalogProvider("unused", async () => Response.json(value));
    await expect(provider.fetchReviewSummary({ appid: 10, name: "Example" }, options)).rejects.toThrow("Steam review summary is missing or invalid");
  }
});

test.each([403, 429, 503])("HTTP %s is not accepted as a successful review summary", async (status) => {
  const provider = createSteamCatalogProvider("unused", async () => Response.json({ response: { query_summary: summary } }, { status }));
  await expect(provider.fetchReviewSummary({ appid: 10, name: "Example" }, options)).rejects.toThrow(`HTTP ${status}`);
  const transport = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ response: { query_summary: summary } }, { status }));
  try {
    await expect(new SteamClient({ minDelayMs: 0, maxRetries: 0 }).fetchSteamData(10)).rejects.toThrow(status === 429 ? "rate limit" : `HTTP ${status}`);
  } finally { transport.mockRestore(); }
});
