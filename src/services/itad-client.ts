import { DEAL_MAX_AGE_SECONDS, type DealOffer } from "./deal-types";

const API = "https://api.isthereanydeal.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type JsonObject = Record<string, unknown>;
type FetchRequest = (url: string, init: RequestInit) => Promise<Response>;

export interface ItadOptions {
  fetch?: FetchRequest;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  requestDelayMs?: number;
  retries?: number;
}

/** Stable ITAD endpoints only. Keys travel in a header and never appear in errors. */
export class ItadClient {
  private readonly fetcher: FetchRequest;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly delay: number;
  private readonly retries: number;

  constructor(private readonly apiKey: string, options: ItadOptions = {}) {
    if (!apiKey) throw new Error("Missing ITAD_API_KEY");
    this.fetcher = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.delay = options.requestDelayMs ?? 600;
    this.retries = options.retries ?? 3;
  }

  async lookup(appIds: number[]): Promise<Map<number, string | null>> {
    const data = object(await this.request("/lookup/id/shop/61/v1", appIds.map((id) => `app/${id}`)));
    const result = new Map<number, string | null>();
    for (const id of appIds) {
      const value = data[`app/${id}`];
      if (value !== null && (typeof value !== "string" || !UUID.test(value))) {
        throw new Error("Incomplete or invalid ITAD Steam mapping response");
      }
      result.set(id, value);
    }
    return result;
  }

  async prices(ids: string[], country: string): Promise<Map<string, DealOffer[]>> {
    // With deals=true ITAD omits games without discounts entirely. Request regular
    // prices too, so an absent game remains unknown rather than a fresh no-sale claim.
    const fetchedAt = this.now();
    const data = array(await this.request(`/games/prices/v3?country=${country}&deals=false&vouchers=true&capacity=0`, ids));
    const result = new Map<string, DealOffer[]>();
    const requested = new Set(ids);
    for (const value of data) {
      const row = object(value);
      const id = text(row.id);
      if (!requested.has(id) || result.has(id)) throw new Error("Unexpected ITAD price game ID");
      const offers = array(row.deals).flatMap((deal) => {
        const offer = retailOffer(object(deal), fetchedAt);
        return offer ? [offer] : [];
      });
      result.set(id, offers.sort((a, b) => a.priceCents! - b.priceCents!));
    }
    return result;
  }

  async bundles(country: string): Promise<{ fetchedAt: number; games: Map<string, DealOffer[]> }> {
    const fetchedAt = this.now();
    const games = new Map<string, DealOffer[]>();
    const seen = new Set<number>();
    // A bounded, complete feed: never publish a partial feed as an empty result.
    for (let offset = 0; offset < 5000; offset += 50) {
      const page = array(await this.request(`/bundles/v1?country=${country}&expired=false&mature=true&limit=50&offset=${offset}`));
      for (const value of page) {
        const bundle = object(value);
        const id = integer(bundle.id);
        if (seen.has(id)) throw new Error("ITAD bundle pagination repeated an ID; retry later");
        seen.add(id);
        for (const [gameId, offer] of bundleOffers(bundle, fetchedAt)) {
          const offers = games.get(gameId) ?? [];
          offers.push(offer);
          games.set(gameId, offers);
        }
      }
      if (page.length < 50) return { fetchedAt, games };
    }
    throw new Error("ITAD bundle pagination exceeded safety limit");
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      await this.sleep(this.delay);
      let response: Response;
      try {
        response = await this.fetcher(`${API}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "ITAD-API-Key": this.apiKey, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        });
      } catch {
        if (attempt >= this.retries) throw new Error("ITAD network request failed");
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (response.ok) {
        try { return await response.json(); }
        catch { throw new Error("ITAD returned invalid JSON"); }
      }
      const retryable = response.status === 429 || response.status >= 500;
      const retryAfter = response.headers.get("Retry-After");
      await response.body?.cancel();
      if (!retryable || attempt >= this.retries) throw new Error(`ITAD request failed (HTTP ${response.status})`);
      let wait = 1000 * 2 ** attempt;
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - this.now() * 1000;
        if (Number.isFinite(delay)) wait = Math.max(wait, delay);
      }
      // Fail instead of sleeping past our refresh lease, never shorten Retry-After.
      if (wait > 120_000) throw new Error("ITAD requested a long retry delay; next scheduled run will retry");
      await this.sleep(wait);
    }
  }
}

function retailOffer(deal: JsonObject, fetchedAt: number): DealOffer | null {
  const price = money(deal.price);
  const regular = money(deal.regular);
  const cut = integer(deal.cut);
  const expiresAt = expiry(deal.expiry);
  if (cut > 100) throw new Error("Invalid ITAD discount");
  if (price === null || regular === null || cut === 0 || price >= regular || (expiresAt !== null && expiresAt <= fetchedAt)) return null;
  const shop = object(deal.shop);
  const store = text(shop.name);
  return {
    kind: "retail", id: `shop:${integer(shop.id)}:${text(deal.url)}`, title: store, store,
    url: link(deal.url), priceCents: price, currency: "USD", discountPercent: cut,
    drm: array(deal.drm).map((item) => text(object(item).name)),
    voucher: nullableText(deal.voucher), note: null, expiresAt,
    validUntil: Math.min(fetchedAt + DEAL_MAX_AGE_SECONDS, expiresAt ?? Infinity),
  };
}

function bundleOffers(bundle: JsonObject, fetchedAt: number): [string, DealOffer][] {
  const id = integer(bundle.id);
  const title = text(bundle.title);
  const expiresAt = expiry(bundle.expiry);
  const publishAt = expiry(bundle.publish);
  if (publishAt === null) throw new Error("Missing ITAD bundle publication date");
  if (publishAt > fetchedAt || (expiresAt !== null && expiresAt <= fetchedAt)) return [];
  const store = text(object(bundle.page).name);
  const url = link(bundle.url);
  const note = nullableText(bundle.note);
  const result: [string, DealOffer][] = [];
  for (const [index, value] of array(bundle.tiers).entries()) {
    const tier = object(value);
    if (typeof tier.addon !== "boolean") throw new Error("Invalid ITAD bundle tier");
    const price = tier.price === null ? null : money(tier.price);
    // Don't relabel a non-USD tier. Unknown prices still permit honest bundle links.
    if (tier.price !== null && price === null) continue;
    const ambiguous = tier.addon || /build your own|pick.?and.?mix|choose/i.test(`${title} ${note ?? ""}`);
    const offer: DealOffer = {
      kind: "bundle", id: `bundle:${id}:tier:${index}`, title, store, url,
      priceCents: ambiguous ? null : price, currency: ambiguous || price === null ? null : "USD",
      discountPercent: null, drm: [], voucher: null,
      note: [note, tier.addon ? "Add-on tier; prerequisite purchase required." : "Check tier contents, selection rules and activation details."].filter(Boolean).join("\n"),
      expiresAt, validUntil: Math.min(fetchedAt + DEAL_MAX_AGE_SECONDS, expiresAt ?? Infinity),
    };
    for (const game of array(tier.games)) {
      const gameId = text(object(game).id);
      if (!UUID.test(gameId)) throw new Error("Invalid ITAD bundle game ID");
      result.push([gameId, offer]);
    }
  }
  return result;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ITAD object");
  return value as JsonObject;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid ITAD array");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("Invalid ITAD text");
  return value;
}
function nullableText(value: unknown): string | null {
  if (value === null) return null;
  return text(value);
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid ITAD number");
  return value;
}
function money(value: unknown): number | null {
  const price = object(value);
  const cents = integer(price.amountInt);
  return text(price.currency) === "USD" ? cents : null;
}
function expiry(value: unknown): number | null {
  if (value === null) return null;
  const parsed = Date.parse(text(value));
  if (!Number.isFinite(parsed)) throw new Error("Invalid ITAD expiry");
  return Math.floor(parsed / 1000);
}
function link(value: unknown): string {
  const original = text(value);
  const url = new URL(original);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid ITAD offer URL");
  return original;
}
