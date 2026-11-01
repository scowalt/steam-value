import type { DealOffer } from "./deal-types";

export function activatesOnSteam(offer: DealOffer): boolean {
  return (offer.kind === "retail" && offer.id.startsWith("shop:61:")) || offer.drm.includes("Steam");
}
