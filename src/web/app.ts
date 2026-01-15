interface Game {
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
const loading = document.getElementById("loading")!;
const loadMoreBtn = document.getElementById("load-more") as HTMLButtonElement;
const syncBtn = document.getElementById("sync-btn") as HTMLButtonElement;
const syncStatus = document.getElementById("sync-status")!;
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

interface SyncResult {
  success: boolean;
  ignoredCount: number;
  wishlistCount: number;
  ownedCount: number;
  gamesUpdated: number;
  gamesRemoved: number;
  error?: string;
}

function getFilterParams(): URLSearchParams {
  const params = new URLSearchParams();
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
  if (allLoaded) return;

  loadMoreBtn.disabled = true;
  loading.style.display = "block";

  const params = getFilterParams();
  params.set("limit", limit.toString());
  params.set("offset", offset.toString());

  const res = await fetch(`/api/games?${params.toString()}`);
  const games: Game[] = await res.json();

  if (games.length < limit) {
    allLoaded = true;
    loadMoreBtn.style.display = "none";
  } else {
    loadMoreBtn.style.display = "block";
  }

  allGames = allGames.concat(games);
  offset += games.length;
  loading.style.display = "none";
  loadMoreBtn.disabled = false;

  renderGames();
}

function resetAndLoad() {
  // Reset state when filters change
  tbody.innerHTML = "";
  offset = 0;
  allLoaded = false;
  allGames = [];
  loadGames();
}

function renderGames() {
  tbody.innerHTML = "";
  allGames.forEach((game, i) => {
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
      <td>
        <a href="https://store.steampowered.com/app/${game.steamAppId}" target="_blank">
          ${escapeHtml(game.name)}
        </a>
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
    tbody.appendChild(tr);
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

async function syncWithSteam() {
  syncBtn.disabled = true;
  syncBtn.textContent = "Syncing...";
  syncStatus.textContent = "";

  try {
    const res = await fetch("/api/sync", { method: "POST" });
    const result: SyncResult = await res.json();

    if (result.success) {
      const parts = [];
      if (result.gamesRemoved > 0) parts.push(`${result.gamesRemoved} removed`);
      if (result.gamesUpdated > 0) parts.push(`${result.gamesUpdated} updated`);
      syncStatus.textContent = parts.length > 0 ? parts.join(", ") : "Already in sync";

      if (result.gamesUpdated > 0 || result.gamesRemoved > 0) {
        // Refresh the list if games were changed
        resetAndLoad();
      }
    } else {
      syncStatus.textContent = result.error || "Sync failed";
    }
  } catch (error) {
    syncStatus.textContent = "Sync error";
  }

  syncBtn.disabled = false;
  syncBtn.textContent = "Sync with Steam";
}

loadMoreBtn.addEventListener("click", loadGames);
syncBtn.addEventListener("click", syncWithSteam);
hideEaCheckbox.addEventListener("change", resetAndLoad);
hidePlayedCheckbox.addEventListener("change", resetAndLoad);
hideMMOCheckbox.addEventListener("change", resetAndLoad);
hideIgnoredCheckbox.addEventListener("change", resetAndLoad);
singleOnlyCheckbox.addEventListener("change", resetAndLoad);
coopFilter.addEventListener("change", resetAndLoad);
controllerFilter.addEventListener("change", resetAndLoad);
loadGames();
