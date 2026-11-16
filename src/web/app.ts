import type { GameDeals } from "../services/deal-types";
import { activeOffers, escapeHtml, nextDealChange, renderDeals } from "./deal-display";

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
  tags: string | null;
}

type TagMode = "include" | "exclude";

interface TagList {
  param: string;
  input: HTMLInputElement;
  chips: HTMLElement;
  tags: string[];
}

const TOP_TAGS_SHOWN = 3;
const MAX_TAGS_PER_LIST = 20;
const MAX_TAG_LENGTH = 100;
const ANY = "any";
const TAG_MODES: TagMode[] = ["include", "exclude"];

const tbody = document.getElementById("games-list")!;
const gamesCards = document.getElementById("games-cards")!;
const loading = document.getElementById("loading")!;
const loadMoreBtn = document.getElementById("load-more") as HTMLButtonElement;
const syncStatus = document.getElementById("sync-status")!;
const gamesError = document.getElementById("games-error")!;
const emptyMessage = document.getElementById("games-empty")!;
const onSaleCheckbox = document.getElementById("on-sale") as HTMLInputElement;
const steamOnlyCheckbox = document.getElementById("steam-only") as HTMLInputElement;
const hideEaCheckbox = document.getElementById("hide-ea") as HTMLInputElement;
const hidePlayedCheckbox = document.getElementById("hide-played") as HTMLInputElement;
const hideMMOCheckbox = document.getElementById("hide-mmo") as HTMLInputElement;
const hideIgnoredCheckbox = document.getElementById("hide-ignored") as HTMLInputElement;
const singleOnlyCheckbox = document.getElementById("single-only") as HTMLInputElement;
const coopFilter = document.getElementById("coop-filter") as HTMLSelectElement;
const controllerFilter = document.getElementById("controller-filter") as HTMLSelectElement;
const tagOptions = document.getElementById("tag-options")!;
const tagMessage = document.getElementById("tag-message")!;

const checkboxFilters = [
  ["onSale", onSaleCheckbox],
  ["steamOnly", steamOnlyCheckbox],
  ["hideEa", hideEaCheckbox],
  ["hidePlayed", hidePlayedCheckbox],
  ["hideMMO", hideMMOCheckbox],
  ["hideIgnored", hideIgnoredCheckbox],
  ["singleOnly", singleOnlyCheckbox],
] as const;
const selectFilters = [["coop", coopFilter], ["controller", controllerFilter]] as const;
const tagLists: Record<TagMode, TagList> = {
  include: {
    param: "includeTag",
    input: document.getElementById("include-tag") as HTMLInputElement,
    chips: document.getElementById("include-tag-chips")!,
    tags: [],
  },
  exclude: {
    param: "excludeTag",
    input: document.getElementById("exclude-tag") as HTMLInputElement,
    chips: document.getElementById("exclude-tag-chips")!,
    tags: [],
  },
};
let knownTags = new Map<string, string>();

let offset = 0;
const limit = 100;
let allLoaded = false;
let allGames: Game[] = [];
let gamesRequest: AbortController | null = null;
let requestVersion = 0;
let gamesLoadFailed = false;
let nextExpiry: number | null = null;

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

function getFilterParams(forPageUrl = false): URLSearchParams {
  const params = new URLSearchParams();
  for (const [param, checkbox] of checkboxFilters) {
    if (forPageUrl ? checkbox.checked !== checkbox.defaultChecked : checkbox.checked) params.set(param, String(checkbox.checked));
  }
  for (const [param, select] of selectFilters) {
    if (select.value !== ANY) params.set(param, select.value);
  }
  for (const { param, tags } of Object.values(tagLists)) {
    for (const tag of tags) params.append(param, tag);
  }
  return params;
}

function applyPageParams(params: URLSearchParams) {
  for (const [param, checkbox] of checkboxFilters) {
    const value = params.get(param);
    if (value === "true" || value === "false") checkbox.checked = value === "true";
  }
  for (const [param, select] of selectFilters) {
    const value = params.get(param);
    if (value !== null && Array.from(select.options).some((option) => option.value === value)) select.value = value;
  }
  for (const tag of params.getAll(tagLists.include.param)) addTag("include", tag);
  for (const tag of params.getAll(tagLists.exclude.param)) {
    if (!tagLists.include.tags.some((included) => sameTag(included, tag))) addTag("exclude", tag);
  }
  renderTagChips();
}

function filtersChanged() {
  const query = getFilterParams(true).toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  resetAndLoad();
}

function sameTag(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function addTag(mode: TagMode, raw: string): boolean {
  const trimmed = raw.trim().slice(0, MAX_TAG_LENGTH);
  if (!trimmed) return false;
  const name = knownTags.get(trimmed.toLowerCase()) ?? trimmed;
  const list = tagLists[mode];
  if (list.tags.some((tag) => sameTag(tag, name))) return true;
  if (list.tags.length >= MAX_TAGS_PER_LIST) return false;
  const opposite = tagLists[mode === "include" ? "exclude" : "include"];
  opposite.tags = opposite.tags.filter((tag) => !sameTag(tag, name));
  list.tags.push(name);
  return true;
}

function renderTagChips() {
  const removeIcon = '<svg class="status-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  for (const { tags, chips } of Object.values(tagLists)) {
    chips.replaceChildren(...tags.map((tag) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tag-chip z-button z-button-small z-button-default";
      button.dataset.tag = tag;
      button.setAttribute("aria-label", `Remove ${tag}`);
      button.innerHTML = `${escapeHtml(tag)}${removeIcon}`;
      item.append(button);
      return item;
    }));
  }
}

function showTagMessage(message: string, input?: HTMLInputElement) {
  tagMessage.textContent = message;
  if (input) input.setAttribute("aria-invalid", String(message !== ""));
}

function commitTagInput(mode: TagMode) {
  const { input } = tagLists[mode];
  const typed = input.value.trim();
  if (!typed) return;
  if (knownTags.size > 0 && !knownTags.has(typed.toLowerCase())) {
    showTagMessage(`No tag named "${typed}". Choose one of the suggestions.`, input);
    return;
  }
  if (!addTag(mode, typed)) {
    showTagMessage(`Use at most ${MAX_TAGS_PER_LIST} tags per list.`, input);
    return;
  }
  input.value = "";
  showTagMessage("", input);
  renderTagChips();
  filtersChanged();
}

function parseTopTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const tags: unknown = JSON.parse(raw);
    return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string").slice(0, TOP_TAGS_SHOWN) : [];
  } catch {
    return [];
  }
}

function topTagsHtml(game: Game): string {
  const tags = parseTopTags(game.tags);
  return tags.length > 0 ? `<div class="top-tags">${tags.map((tag) => escapeHtml(tag)).join(", ")}</div>` : "";
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
  return onSaleCheckbox.checked || steamOnlyCheckbox.checked
    ? allGames.filter((game) => activeOffers(game.deals, now, steamOnlyCheckbox.checked).length > 0)
    : allGames;
}

function renderEmptyState() {
  emptyMessage.hidden = Boolean(gamesRequest) || gamesLoadFailed || visibleGames(Date.now() / 1000).length > 0;
  emptyMessage.textContent = steamOnlyCheckbox.checked
    ? "No games with current Steam-activating deals match these filters. Non-Steam and unconfirmed activation offers are excluded; try disabling Activates on Steam only."
    : onSaleCheckbox.checked
      ? "No games with current discounts or bundles match these filters. Missing, stale or unmatched sale data does not qualify; try disabling On sale or in bundle."
      : "No games match these filters.";
}

function updateNextExpiry() {
  const now = Date.now() / 1000;
  const deadlines = allGames.map((game) => nextDealChange(game.deals, now, steamOnlyCheckbox.checked))
    .filter((deadline): deadline is number => deadline !== null);
  nextExpiry = deadlines.length ? Math.min(...deadlines) : null;
}

function checkDealExpiry() {
  if (nextExpiry === null || nextExpiry > Date.now() / 1000) return;
  updateNextExpiry();
  if (onSaleCheckbox.checked || steamOnlyCheckbox.checked) {
    resetAndLoad();
  } else {
    renderGames();
    renderEmptyState();
  }
}

function renderGames() {
  tbody.innerHTML = "";
  gamesCards.innerHTML = "";
  const tableFragment = document.createDocumentFragment();
  const cardsFragment = document.createDocumentFragment();

  const now = Date.now() / 1000;
  const checkIcon = '<svg class="status-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
  visibleGames(now).forEach((game, i) => {
    const dealsHtml = renderDeals(game.deals, now, steamOnlyCheckbox.checked);
    const rank = i + 1;
    const tr = document.createElement("tr");

    let controllerHtml = "-";
    if (game.controllerSupport === "full") {
      controllerHtml = '<span class="z-label z-label-success">Full</span>';
    } else if (game.controllerSupport === "partial") {
      controllerHtml = '<span class="z-label z-label-warning">Partial</span>';
    }

    let playtimeHtml = "-";
    if (game.playtimeMinutes !== null && game.playtimeMinutes > 0) {
      const hours = game.playtimeMinutes / 60;
      playtimeHtml = hours >= 1 ? `${hours.toFixed(1)}h` : `${game.playtimeMinutes}m`;
    }

    let modeHtml = "";
    if (game.hasSinglePlayer && !game.hasMultiplayer) {
      modeHtml = '<span class="mode-sp">SP</span>';
    } else if (!game.hasSinglePlayer && game.hasMultiplayer) {
      modeHtml = '<span class="mode-mp">MP</span>';
    } else if (game.hasSinglePlayer && game.hasMultiplayer) {
      modeHtml = '<span class="mode-sp">SP</span>/<span class="mode-mp">MP</span>';
    }

    tr.innerHTML = `
      <td class="wishlist">${game.isOnWishlist ? `<span class="wishlist-check" role="img" aria-label="On wishlist">${checkIcon}</span>` : ''}</td>
      <td class="owned">${game.isOwned ? `<span class="owned-check" role="img" aria-label="Owned">${checkIcon}</span>` : ''}</td>
      <td class="rank">${rank}</td>
      <td class="game-name">
        <a href="https://store.steampowered.com/app/${game.steamAppId}" target="_blank" rel="noopener noreferrer">
          ${escapeHtml(game.name)}
        </a>
        ${topTagsHtml(game)}
      </td>
      <td class="deals">${dealsHtml}</td>
      <td class="score">${game.valueScore?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? "N/A"}</td>
      <td class="reviews">
        <span class="review-pct">${game.steamReviewScore}%</span>
        <span class="review-count">(${game.steamReviewCount.toLocaleString()})</span>
      </td>
      <td class="hours">${game.hltbMain?.toFixed(1) ?? "?"} hrs</td>
      <td class="playtime">${playtimeHtml}</td>
      <td class="mode">${modeHtml}</td>
      <td class="ea">${game.isEarlyAccess ? `<span class="ea-check" role="img" aria-label="Early Access">${checkIcon}</span>` : ''}</td>
      <td class="controller">${controllerHtml}</td>
    `;
    tableFragment.appendChild(tr);

    const tags = [];
    if (game.isOwned) tags.push('<span class="z-label z-label-info">Owned</span>');
    if (game.isOnWishlist) tags.push('<span class="z-label z-label-success">Wishlist</span>');
    if (game.hasSinglePlayer) tags.push('<span class="z-label">Single-player</span>');
    if (game.hasMultiplayer) tags.push('<span class="z-label z-label-info">Multiplayer</span>');
    if (game.isEarlyAccess) tags.push('<span class="z-label z-label-warning">Early Access</span>');
    if (game.controllerSupport === "full") {
      tags.push('<span class="z-label z-label-success">Full controller</span>');
    } else if (game.controllerSupport === "partial") {
      tags.push('<span class="z-label z-label-warning">Partial controller</span>');
    }

    const card = document.createElement("article");
    card.className = "game-card z-card";
    card.innerHTML = `
      <div class="game-card-header z-card-header">
        <div class="game-card-heading">
          <h2 class="game-card-title z-card-title">
            <span class="game-card-rank">#${rank}</span>
            <a href="https://store.steampowered.com/app/${game.steamAppId}" target="_blank" rel="noopener noreferrer">
              ${escapeHtml(game.name)}
            </a>
          </h2>
          ${topTagsHtml(game)}
        </div>
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
      <dl class="game-card-deals">
        <dt>Deals</dt>
        <dd>${dealsHtml}</dd>
      </dl>
      <div class="game-card-tags z-card-footer">${tags.length > 0 ? tags.join("") : '<span class="z-label">Mode and controller unknown</span>'}</div>
    `;
    cardsFragment.appendChild(card);
  });

  tbody.appendChild(tableFragment);
  gamesCards.appendChild(cardsFragment);
}

async function loadSyncState() {
  try {
    const res = await fetch("/api/sync-state");
    if (!res.ok) return;

    const state = (await res.json()) as SyncState | null;
    renderSyncState(state);
  } catch {
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

async function loadTagVocabulary() {
  try {
    const res = await fetch("/api/tags");
    if (!res.ok) return;
    const tags: unknown = await res.json();
    if (!Array.isArray(tags)) return;
    const valid = tags.filter((tag): tag is { name: string; count: number } =>
      typeof tag?.name === "string" && tag.name !== "" && typeof tag.count === "number");
    knownTags = new Map(valid.map((tag) => [tag.name.toLowerCase(), tag.name]));
    tagOptions.replaceChildren(...valid.map((tag) => {
      const option = document.createElement("option");
      option.value = tag.name;
      option.label = `${tag.count.toLocaleString()} games`;
      return option;
    }));
  } catch {
  }
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
for (const [, control] of [...checkboxFilters, ...selectFilters]) control.addEventListener("change", filtersChanged);
for (const mode of TAG_MODES) {
  const { input, chips } = tagLists[mode];
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitTagInput(mode);
  });
  input.addEventListener("input", (event) => {
    showTagMessage("", input);
    const isListPick = !(event instanceof InputEvent) || event.inputType === "insertReplacementText";
    if (isListPick) commitTagInput(mode);
  });
  chips.addEventListener("click", (event) => {
    const tag = (event.target as Element).closest<HTMLElement>("button[data-tag]")?.dataset.tag;
    if (tag === undefined) return;
    tagLists[mode].tags = tagLists[mode].tags.filter((existing) => existing !== tag);
    renderTagChips();
    input.focus();
    filtersChanged();
  });
}
document.querySelector(".filters")!.addEventListener("submit", (event) => event.preventDefault());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    checkDealExpiry();
  }
});
setInterval(checkDealExpiry, 30_000);
applyPageParams(new URLSearchParams(location.search));
void loadGames();
void loadSyncState();
void loadTagVocabulary();
