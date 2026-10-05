import {
  DEAL_MAX_AGE_SECONDS,
  type DealOffer,
  type GameDeals,
} from "../services/deal-types";

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

export function nextDealChange(deals: GameDeals | undefined, now: number): number | null {
  if (!deals) return null;
  const deadlines = activeOffers(deals, now).map((offer) => offer.validUntil);
  if ((deals.status === "fresh" || deals.status === "partial") && deals.checkedAt !== null) {
    deadlines.push(deals.checkedAt + DEAL_MAX_AGE_SECONDS);
  }
  const future = deadlines.filter((deadline) => deadline > now);
  return future.length ? Math.min(...future) : null;
}

function offerLink(offer: DealOffer, label: string): string {
  try {
    const url = new URL(offer.url);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return `<a href="${escapeHtml(offer.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
    }
  } catch {
  }
  return escapeHtml(label);
}

export function renderDeals(deals: GameDeals | undefined, now: number): string {
  const offers = activeOffers(deals, now);
  const retail = offers.filter((offer) => offer.kind === "retail")
    .sort((a, b) => (a.priceCents ?? Infinity) - (b.priceCents ?? Infinity))[0];
  const bundle = offers.find((offer) => offer.kind === "bundle");
  const badges = [];
  if (retail && retail.discountPercent !== null) {
    badges.push(`<span class="deal-badge">${offerLink(retail, `${retail.discountPercent}% off`)}</span>`);
  }
  if (bundle) {
    badges.push(`<span class="deal-badge">${offerLink(bundle, "In bundle")}</span>`);
  }
  return `<div class="game-deals">${badges.join(" ") || "—"}</div>`;
}
