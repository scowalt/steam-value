import { escapeHtml } from "./deal-display";

interface CityBuilder {
  idx: number;
  steam_app_id: number;
  name: string;
  steam_review_score: number | null;
  steam_review_count: number | null;
  hltb_main: number | null;
  controller_support: "full" | "partial" | null;
  playtime_minutes: number | null;
  tag_rank: number | null;
  value_score: number | null;
  weighted_score: number | null;
}

type SortKey = Exclude<keyof CityBuilder, "steam_app_id">;

const search = document.querySelector<HTMLInputElement>("#search")!;
const tbody = document.getElementById("tbody")!;
const subtitle = document.getElementById("subtitle")!;
const count = document.getElementById("visible-count")!;
const empty = document.getElementById("city-empty")!;
const error = document.getElementById("city-error")!;
const retry = document.querySelector<HTMLButtonElement>("#city-retry")!;
const headers = document.querySelectorAll<HTMLTableCellElement>("th[data-key]");
let games: CityBuilder[] = [];
let sortKey: SortKey = "weighted_score";
let sortAsc = false;
let loaded = false;

function nil(value: string | null): string {
  return value === null ? '<span class="null">—</span>' : value;
}

function controllerLabel(value: CityBuilder["controller_support"]): string {
  if (value === null) return nil(null);
  return value === "full"
    ? '<span class="z-label z-label-success">Full</span>'
    : '<span class="z-label z-label-warning">Partial</span>';
}

function render() {
  const query = search.value.toLowerCase();
  const sorted = games.filter((game) => !query || game.name.toLowerCase().includes(query)).sort((a, b) => {
    let left = a[sortKey];
    let right = b[sortKey];
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    if (typeof left === "string") left = left.toLowerCase();
    if (typeof right === "string") right = right.toLowerCase();
    if (left < right) return sortAsc ? -1 : 1;
    if (left > right) return sortAsc ? 1 : -1;
    return 0;
  });

  tbody.innerHTML = sorted.map((game, index) => `
    <tr>
      <td class="num">${index + 1}</td>
      <td class="name"><a href="https://store.steampowered.com/app/${Number(game.steam_app_id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(game.name)}</a></td>
      <td class="num">${nil(game.steam_review_score === null ? null : `${game.steam_review_score}%`)}</td>
      <td class="num">${nil(game.steam_review_count?.toLocaleString() ?? null)}</td>
      <td class="num">${nil(game.hltb_main === null ? null : `${game.hltb_main.toFixed(1)}h`)}</td>
      <td>${controllerLabel(game.controller_support)}</td>
      <td class="num">${nil(game.playtime_minutes === null ? null : `${(game.playtime_minutes / 60).toFixed(1)}h`)}</td>
      <td class="num">${nil(game.tag_rank === null ? null : `#${game.tag_rank}`)}</td>
      <td class="num">${nil(game.value_score?.toFixed(1) ?? null)}</td>
      <td class="num">${nil(game.weighted_score?.toFixed(1) ?? null)}</td>
    </tr>
  `).join("");

  count.textContent = loaded ? `Showing ${sorted.length} of ${games.length}` : "";
  empty.hidden = !loaded || sorted.length > 0;
  empty.textContent = games.length > 0 ? "No city builders match your search. Try another game name." : "No city builders match this view yet.";
  headers.forEach((header) => header.setAttribute("aria-sort", header.dataset.key === sortKey ? (sortAsc ? "ascending" : "descending") : "none"));
}

async function loadGames() {
  retry.hidden = true;
  retry.disabled = true;
  error.hidden = true;
  subtitle.textContent = "Loading city builders…";
  try {
    const response = await fetch("/api/city-builders");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: Omit<CityBuilder, "idx">[] = await response.json();
    if (!Array.isArray(data)) throw new Error("Invalid city-builder response");
    games = data.map((game, index) => ({ ...game, idx: index + 1 }));
    loaded = true;
    subtitle.textContent = "Default order: weighted score (Value Score × tag relevance)";
    render();
  } catch {
    subtitle.textContent = "City-builder data is unavailable.";
    error.hidden = false;
    retry.hidden = false;
  } finally {
    retry.disabled = false;
  }
}

headers.forEach((header) => {
  header.querySelector("button")!.addEventListener("click", () => {
    const key = header.dataset.key as SortKey;
    if (sortKey === key) sortAsc = !sortAsc;
    else {
      sortKey = key;
      sortAsc = header.dataset.type === "string";
    }
    render();
  });
});
search.addEventListener("input", render);
document.querySelector(".city-controls")!.addEventListener("submit", (event) => event.preventDefault());
retry.addEventListener("click", loadGames);
void loadGames();
