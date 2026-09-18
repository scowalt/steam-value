import type { DealRefreshStatus, GameDeals } from "../services/deal-types";
import { activeOffers, escapeHtml, formatDealRefreshStatus, nextDealChange, renderDeals } from "./deal-display";

interface Game {
  deals: GameDeals;
  id: number;
  steamAppId: number;
  name: string;
  steamReviewScore: number;
  steamReviewCount: number;
  hltbMain: number | null;
  valueScore: number | null;
  isOnWishlist: boolean;
  isEarlyAccess: boolean;
  controllerSupport: "full" | "partial" | null;
  isOwned: boolean;
  playtimeMinutes: number | null;
  isIgnored: boolean;
  // Game modes
  hasSinglePlayer: boolean;
  hasMultiplayer: boolean;
  hasCoOp: boolean;
  hasOnlineCoOp: boolean;
  hasLocalCoOp: boolean;
  hasPvP: boolean;
  hasOnlinePvP: boolean;
  hasLocalPvP: boolean;
  hasCrossplatform: boolean;
  isMMO: boolean;
}

const tbody = document.getElementById("games-list")!;
const gamesCards = document.getElementById("games-cards")!;
const loading = document.getElementById("loading")!;
const loadMoreBtn = document.getElementById("load-more") as HTMLButtonElement;
const syncStatus = document.getElementById("sync-status")!;
const dealStatus = document.getElementById("deal-status")!;
const gamesError = document.getElementById("games-error")!;
const emptyMessage = document.getElementById("games-empty")!;
const onSaleCheckbox = document.getElementById("on-sale") as HTMLInputElement;
const hideEaCheckbox = document.getElementById("hide-ea") as HTMLInputElement;
const hidePlayedCheckbox = document.getElementById("hide-played") as HTMLInputElement;
const hideMMOCheckbox = document.getElementById("hide-mmo") as HTMLInputElement;
const hideIgnoredCheckbox = document.getElementById("hide-ignored") as HTMLInputElement;
const singleOnlyCheckbox = document.getElementById("single-only") as HTMLInputElement;
const coopFilter = document.getElementById("coop-filter") as HTMLSelectElement;
const controllerFilter = document.getElementById("controller-filter") as HTMLSelectElement;

let offset = 0;
const limit = 100;
let allLoaded = false;
let allGames: Game[] = [];
let gamesRequest: AbortController | null = null;
let requestVersion = 0;
let gamesLoadFailed = false;
let nextExpiry: number | null = null;
let dealRefreshState: DealRefreshStatus | null = null;
let dealStatusLoading = false;
let lastDealStatusAttempt = -Infinity;

interface SyncState {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  isRunning: boolean;
  ignoredCount: number;
  wishlistCount: number;
  ownedCount: number;
  gamesUpdated: number;
  gamesRemoved: number;
}

function getFilterParams(): URLSearchParams {
  const params = new URLSearchParams();
  if (onSaleCheckbox.checked) params.set("onSale", "true");
  if (hideEaCheckbox.checked) params.set("hideEa", "true");
  if (hidePlayedCheckbox.checked) params.set("hidePlayed", "true");
  if (hideMMOCheckbox.checked) params.set("hideMMO", "true");
  if (hideIgnoredCheckbox.checked) params.set("hideIgnored", "true");
  if (singleOnlyCheckbox.checked) params.set("singleOnly", "true");
  if (coopFilter.value !== "any") params.set("coop", coopFilter.value);
  if (controllerFilter.value !== "any") params.set("controller", controllerFilter.value);
  return params;
}

async function loadGames() {
  if (allLoaded || gamesRequest) return;

  const request = new AbortController();
  gamesRequest = request;
  const version = ++requestVersion;
  loadMoreBtn.disabled = true;
  loading.style.display = "block";
  gamesError.hidden = true;
  emptyMessage.hidden = true;
  gamesLoadFailed = false;

  const params = getFilterParams();
  params.set("limit", limit.toString());
  params.set("offset", offset.toString());

  try {
    const res = await fetch(`/api/games?${params.toString()}`, { signal: request.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const games = (await res.json()) as Game[];
    if (!Array.isArray(games)) throw new Error("Invalid games response");
    // Aborting alone is insufficient when an earlier response is already being decoded.
    if (version !== requestVersion) return;

    allLoaded = games.length < limit;
    loadMoreBtn.style.display = allLoaded ? "none" : "block";
    loadMoreBtn.textContent = "Load More";
    allGames = allGames.concat(games);
    offset += games.length;
    updateNextExpiry();
    renderGames();
  } catch {
    if (version !== requestVersion) return;
    gamesLoadFailed = true;
    gamesError.textContent = "Could not load games. Check your connection and retry.";
    gamesError.hidden = false;
    loadMoreBtn.textContent = "Retry loading";
    loadMoreBtn.style.display = "block";
  } finally {
    if (version === requestVersion) {
      gamesRequest = null;
      loading.style.display = "none";
      loadMoreBtn.disabled = false;
      renderEmptyState();
    }
  }
}

function resetAndLoad() {
  // Invalidate both in-flight pages and filter responses before starting the new ranking.
  requestVersion++;
  gamesRequest?.abort();
  gamesRequest = null;
  tbody.innerHTML = "";
  gamesCards.innerHTML = "";
  offset = 0;
  allLoaded = false;
  allGames = [];
  nextExpiry = null;
  void loadGames();
}

function visibleGames(now: number): Game[] {
  // The server filters BEFORE pagination. This only removes offers that expired in this tab.
  return onSaleCheckbox.checked ? allGames.filter((game) => activeOffers(game.deals, now).length > 0) : allGames;
}

function renderEmptyState() {
  emptyMessage.hidden = Boolean(gamesRequest) || gamesLoadFailed || visibleGames(Date.now() / 1000).length > 0;
  emptyMessage.textContent = onSaleCheckbox.checked
    ? "No games with current discounts or bundles match these filters. Missing, stale or unmatched sale data does not qualify; try disabling On sale."
    : "No games match these filters.";
}

function updateNextExpiry() {
  const now = Date.now() / 1000;
  const deadlines = allGames.map((game) => nextDealChange(game.deals, now))
    .filter((deadline): deadline is number => deadline !== null);
  nextExpiry = deadlines.length ? Math.min(...deadlines) : null;
}

function checkDealExpiry() {
  void loadDealState();
  dealStatus.textContent = formatDealRefreshStatus(dealRefreshState, Date.now() / 1000);
  if (nextExpiry === null || nextExpiry > Date.now() / 1000) return;
  updateNextExpiry();
  if (onSaleCheckbox.checked) {
    // Restart server pagination because expiry can change membership anywhere in the ranking.
    resetAndLoad();
  } else {
    renderGames();
    renderEmptyState();
  }
  void loadDealState();
}

function renderGames() {
  tbody.innerHTML = "";
  gamesCards.innerHTML = "";
  const tableFragment = document.createDocumentFragment();
  const cardsFragment = document.createDocumentFragment();

  const now = Date.now() / 1000;
  visibleGames(now).forEach((game, i) => {
    const dealsHtml = renderDeals(game.deals, now);
    const rank = i + 1;
    const tr = document.createElement("tr");

    let controllerHtml = "-";
    if (game.controllerSupport === "full") {
      controllerHtml = '<span class="controller-full">Full</span>';
    } else if (game.controllerSupport === "partial") {
      controllerHtml = '<span class="controller-partial">Partial</span>';
    }

    // Format playtime in hours (from minutes)
    let playtimeHtml = "-";
    if (game.playtimeMinutes !== null && game.playtimeMinutes > 0) {
      const hours = game.playtimeMinutes / 60;
      playtimeHtml = hours >= 1 ? `${hours.toFixed(1)}h` : `${game.playtimeMinutes}m`;
    }

    // Format game mode
    let modeHtml = "";
    if (game.hasSinglePlayer && !game.hasMultiplayer) {
      modeHtml = '<span class="mode-sp">SP</span>';
    } else if (!game.hasSinglePlayer && game.hasMultiplayer) {
      modeHtml = '<span class="mode-mp">MP</span>';
    } else if (game.hasSinglePlayer && game.hasMultiplayer) {
      modeHtml = '<span class="mode-sp">SP</span>/<span class="mode-mp">MP</span>';
    }

    tr.innerHTML = `
      <td class="wishlist">${game.isOnWishlist ? '<span class="wishlist-check">✓</span>' : ''}</td>
      <td class="owned">${game.isOwned ? '<span class="owned-check">✓</span>' : ''}</td>
      <td class="rank">${rank}</td>
      <td class="game-name">
        <a href="https://store.steampowered.com/app/${game.steamAppId}" target="_blank" rel="noopener noreferrer">
          ${escapeHtml(game.name)}
        </a>
        ${dealsHtml}
      </td>
      <td class="score">${game.valueScore?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? "N/A"}</td>
      <td class="reviews">
        <span class="review-pct">${game.steamReviewScore}%</span>
        <span class="review-count">(${game.steamReviewCount.toLocaleString()})</span>
      </td>
      <td class="hours">${game.hltbMain?.toFixed(1) ?? "?"} hrs</td>
      <td class="playtime">${playtimeHtml}</td>
      <td class="mode">${modeHtml}</td>
      <td class="ea">${game.isEarlyAccess ? '<span class="ea-check">✓</span>' : ''}</td>
      <td class="controller">${controllerHtml}</td>
    `;
    tableFragment.appendChild(tr);

    const tags = [];
    if (game.isOwned) tags.push('<span class="game-tag game-tag-owned">✓ Owned</span>');
    if (game.isOnWishlist) tags.push('<span class="game-tag game-tag-wishlist">✓ Wishlist</span>');
    if (game.hasSinglePlayer) tags.push('<span class="game-tag game-tag-sp">Single-player</span>');
    if (game.hasMultiplayer) tags.push('<span class="game-tag game-tag-mp">Multiplayer</span>');
    if (game.isEarlyAccess) tags.push('<span class="game-tag game-tag-ea">Early Access</span>');
    if (game.controllerSupport === "full") {
      tags.push('<span class="game-tag game-tag-controller-full">Full controller</span>');
    } else if (game.controllerSupport === "partial") {
      tags.push('<span class="game-tag game-tag-controller-partial">Partial controller</span>');
    }

    const card = document.createElement("article");
    card.className = "game-card";
    card.innerHTML = `
      <div class="game-card-header">
        <h2 class="game-card-title">
          <span class="game-card-rank">#${rank}</span>
          <a href="https://store.steampowered.com/app/${game.steamAppId}" target="_blank" rel="noopener noreferrer">
            ${escapeHtml(game.name)}
          </a>
        </h2>
        <div class="game-card-score">
          <span>Score</span>
          <strong>${game.valueScore?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? "N/A"}</strong>
        </div>
      </div>
      <dl class="game-card-stats">
        <div>
          <dt>Reviews</dt>
          <dd><span class="review-pct">${game.steamReviewScore}%</span> <span class="review-count">(${game.steamReviewCount.toLocaleString()})</span></dd>
        </div>
        <div>
          <dt>HLTB</dt>
          <dd>${game.hltbMain?.toFixed(1) ?? "?"} hrs</dd>
        </div>
        <div>
          <dt>Played</dt>
          <dd>${playtimeHtml}</dd>
        </div>
      </dl>
      <div class="game-card-tags">${tags.length > 0 ? tags.join("") : '<span class="game-tag">Mode and controller unknown</span>'}</div>
      ${dealsHtml}
    `;
    cardsFragment.appendChild(card);
  });

  tbody.appendChild(tableFragment);
  gamesCards.appendChild(cardsFragment);
}

async function loadDealState() {
  // Visibility/expiry checks can coincide; don't hammer a failed or empty status endpoint.
  if (dealStatusLoading || Date.now() - lastDealStatusAttempt < 60_000) return;
  dealStatusLoading = true;
  lastDealStatusAttempt = Date.now();
  try {
    const res = await fetch("/api/deal-state");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dealRefreshState = (await res.json()) as DealRefreshStatus | null;
  } catch {
    dealRefreshState = null;
  } finally {
    dealStatusLoading = false;
    dealStatus.textContent = formatDealRefreshStatus(dealRefreshState, Date.now() / 1000);
  }
}

async function loadSyncState() {
  try {
    const res = await fetch("/api/sync-state");
    if (!res.ok) return;

    const state = (await res.json()) as SyncState | null;
    renderSyncState(state);
  } catch {
    // Keep the games list usable even if status metadata fails to load.
  }
}

function renderSyncState(state: SyncState | null) {
  if (!state) {
    syncStatus.textContent = "Never refreshed";
    return;
  }

  if (state.isRunning) {
    syncStatus.textContent = "Refresh running...";
    return;
  }

  const parts = [];
  if (state.lastSuccessAt) parts.push(`Last refreshed ${formatUnixTime(state.lastSuccessAt)}`);
  if (state.gamesUpdated > 0) parts.push(`${state.gamesUpdated} updated`);
  if (state.lastError) parts.push(`Last error: ${state.lastError}`);

  syncStatus.textContent = parts.length > 0 ? parts.join(" · ") : "No refresh yet";
}

function formatUnixTime(value: number): string {
  return new Date(value * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

loadMoreBtn.addEventListener("click", loadGames);
onSaleCheckbox.addEventListener("change", resetAndLoad);
hideEaCheckbox.addEventListener("change", resetAndLoad);
hidePlayedCheckbox.addEventListener("change", resetAndLoad);
hideMMOCheckbox.addEventListener("change", resetAndLoad);
hideIgnoredCheckbox.addEventListener("change", resetAndLoad);
singleOnlyCheckbox.addEventListener("change", resetAndLoad);
coopFilter.addEventListener("change", resetAndLoad);
controllerFilter.addEventListener("change", resetAndLoad);
document.querySelector(".filters")!.addEventListener("submit", (event) => event.preventDefault());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    checkDealExpiry();
    void loadDealState();
  }
});
// Background tabs may throttle timers; visibilitychange also checks before showing old offers.
setInterval(checkDealExpiry, 30_000);
void loadGames();
void loadSyncState();
void loadDealState();
