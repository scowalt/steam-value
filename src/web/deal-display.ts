import {
  DEAL_MAX_AGE_SECONDS,
  type DealOffer,
  type DealRefreshStatus,
  type GameDeals,
} from "../services/deal-types";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    };
    return entities[character]!;
  });
}

export function activeOffers(deals: GameDeals | undefined, now: number): DealOffer[] {
  return (deals?.offers ?? []).filter((offer) => Number.isFinite(offer.validUntil) && offer.validUntil > now);
}

// Only future deadlines are watched. An empty/stale response must not cause a refetch loop.
export function nextDealChange(deals: GameDeals | undefined, now: number): number | null {
  if (!deals) return null;
  const deadlines = activeOffers(deals, now).map((offer) => offer.validUntil);
  if ((deals.status === "fresh" || deals.status === "partial") && deals.checkedAt !== null) {
    deadlines.push(deals.checkedAt + DEAL_MAX_AGE_SECONDS);
  }
  const future = deadlines.filter((deadline) => deadline > now);
  return future.length ? Math.min(...future) : null;
}

function formatTime(value: number): string {
  return new Date(value * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function offerLink(offer: DealOffer, label: string): string {
  // Validate the scheme without rewriting the original URL or its affiliate parameters.
  try {
    const url = new URL(offer.url);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return `<a href="${escapeHtml(offer.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
    }
  } catch {
    // Invalid links should never become executable markup.
  }
  return escapeHtml(label);
}

function renderOffer(offer: DealOffer): string {
  const price = offer.currency === "USD" && offer.priceCents !== null
    ? `${usd.format(offer.priceCents / 100)} USD`
    : null;
  const heading = offer.kind === "bundle"
    ? `${offerLink(offer, offer.title)} <span class="deal-provider">· ${escapeHtml(offer.store)}</span>`
    : offerLink(offer, offer.store);
  const cost = offer.kind === "bundle"
    ? (price ? `Bundle tier total: ${price}` : "Bundle opportunity · see provider for price and selection requirements")
    : `${price ?? "Price not reported"}${offer.discountPercent !== null ? ` · ${offer.discountPercent}% off` : ""}`;
  const drm = offer.drm.length ? `DRM: ${offer.drm.join(", ")}` : "DRM not reported — check provider";
  return `<div class="deal-offer deal-${offer.kind}">
    <div class="deal-heading">${heading}</div>
    <div class="deal-price">${escapeHtml(cost)}</div>
    <div class="deal-condition">${escapeHtml(drm)}</div>
    ${offer.voucher ? `<div class="deal-voucher">Requires voucher: <strong>${escapeHtml(offer.voucher)}</strong></div>` : ""}
    ${offer.note ? `<div class="deal-condition">${escapeHtml(offer.note)}</div>` : ""}
    ${offer.expiresAt !== null ? `<div class="deal-condition">Reported end: ${escapeHtml(formatTime(offer.expiresAt))}</div>` : ""}
  </div>`;
}

function renderGroup(offers: DealOffer[], title: string, extraLabel: string): string {
  if (!offers.length) return "";
  return `<section class="deal-group" aria-label="${title}">
    <h3>${title}</h3>
    ${renderOffer(offers[0]!)}
    ${offers.length > 1 ? `<details><summary>More ${extraLabel} (${offers.length - 1})</summary>${offers.slice(1).map(renderOffer).join("")}</details>` : ""}
  </section>`;
}

export function renderDeals(deals: GameDeals | undefined, now: number): string {
  const offers = activeOffers(deals, now);
  const retail = offers.filter((offer) => offer.kind === "retail")
    .sort((a, b) => (a.priceCents ?? Infinity) - (b.priceCents ?? Infinity));
  const bundles = offers.filter((offer) => offer.kind === "bundle");
  let status: string;
  if (!deals || deals.status === "unknown") {
    status = "Sale data not available yet.";
  } else if (deals.status === "unmapped") {
    status = "No IsThereAnyDeal match found.";
  } else if (!offers.length && (deals.status === "stale" ||
    (deals.checkedAt !== null && deals.checkedAt + DEAL_MAX_AGE_SECONDS <= now))) {
    status = "Sale data stale — awaiting refresh.";
  } else if (deals.status === "partial") {
    status = offers.length
      ? "Partial sale data — some sources unavailable."
      : "Partial sale data — no current offers confirmed; some sources unavailable.";
  } else if (!offers.length && deals.offers.length) {
    status = "Cached offers expired — awaiting refresh.";
  } else {
    status = offers.length ? "" : "No current discounts or bundles reported.";
  }
  const checked = deals?.checkedAt !== null && deals?.checkedAt !== undefined
    ? `Checked ${formatTime(deals.checkedAt)}` : "";
  return `<div class="game-deals">
    ${renderGroup(retail, "Retail discounts · best price first", "retail offers")}
    ${renderGroup(bundles, "Bundles · not individual game prices", "bundle opportunities")}
    <p class="deal-state">${escapeHtml([status, checked].filter(Boolean).join(" "))}</p>
  </div>`;
}

export function formatDealRefreshStatus(state: DealRefreshStatus | null, now: number): string {
  if (!state) return "Sale refresh status unavailable. Per-game offer checks still apply.";
  const parts = [`${state.country}/${state.currency}`];
  if (state.isRunning) parts.push(`Refresh running (${state.gamesChecked}/${state.totalGames} checked)`);
  if (state.lastSuccessAt !== null) {
    const fresh = now < state.lastSuccessAt + state.maxAgeSeconds;
    parts.push(`Last successful refresh ${formatTime(state.lastSuccessAt)} (${fresh ? "within 24h" : "stale"})`);
  } else {
    parts.push("No successful sale refresh yet");
  }
  parts.push(`Coverage at status check: ${state.freshGames}/${state.totalGames} games fresh`);
  if (state.lastAttemptAt !== null) parts.push(`Last attempt ${formatTime(state.lastAttemptAt)}`);
  if (state.lastError) parts.push(`Refresh error: ${state.lastError}`);
  return parts.join(" · ");
}
