#!/usr/bin/env bun

// Downloads steamdb.json from leinstay/steamdb and extracts Steam-to-HLTB mappings
// Source: https://github.com/leinstay/steamdb

// Use LFS media URL for the actual file content
const STEAMDB_URL = "https://media.githubusercontent.com/media/leinstay/steamdb/main/steamdb.json";
const OUTPUT_PATH = "./src/data/steam-hltb-map.json";

interface SteamDbEntry {
  name: string;
  hltb_url?: string;
  hltb_single?: number;
  hltb_complete?: number;
}

interface HltbMapping {
  steamAppId: number;
  hltbId: number;
  name: string;
  hltbSingle: number | null;
  hltbComplete: number | null;
}

async function main() {
  console.log("Downloading steamdb.json from leinstay/steamdb (~170MB)...");
  console.log("This may take a minute...");

  const response = await fetch(STEAMDB_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
  }

  console.log("Download complete, parsing JSON...");
  const text = await response.text();
  console.log(`Received ${(text.length / 1024 / 1024).toFixed(1)}MB`);

  const data: Record<string, SteamDbEntry> = JSON.parse(text);
  const entries = Object.entries(data);
  console.log(`Downloaded ${entries.length} games`);

  // Extract HLTB mappings
  const mappings: HltbMapping[] = [];
  let withHltb = 0;

  for (const [steamAppId, entry] of entries) {
    if (!entry.hltb_url) continue;

    // Extract HLTB ID from URL like "https://howlongtobeat.com/game/12345"
    const match = entry.hltb_url.match(/game\/(\d+)/);
    if (!match) continue;

    const hltbId = parseInt(match[1]);
    if (isNaN(hltbId)) continue;

    mappings.push({
      steamAppId: parseInt(steamAppId),
      hltbId,
      name: entry.name,
      hltbSingle: entry.hltb_single ?? null,
      hltbComplete: entry.hltb_complete ?? null,
    });
    withHltb++;
  }

  console.log(`Found ${withHltb} games with HLTB mappings`);

  // Sort by steamAppId for binary search
  mappings.sort((a, b) => a.steamAppId - b.steamAppId);

  // Save to file
  await Bun.write(OUTPUT_PATH, JSON.stringify(mappings, null, 2));
  console.log(`Saved to ${OUTPUT_PATH}`);

  // Show some stats
  const withTimes = mappings.filter(m => m.hltbSingle !== null);
  console.log(`\nStats:`);
  console.log(`  Total mappings: ${mappings.length}`);
  console.log(`  With playtime data: ${withTimes.length}`);

  // Sample some entries
  console.log(`\nSample entries:`);
  const samples = [292030, 413150, 289070, 620]; // Witcher 3, Stardew, Civ 6, Portal 2
  for (const steamId of samples) {
    const m = mappings.find(m => m.steamAppId === steamId);
    if (m) {
      console.log(`  ${m.name}: Steam ${m.steamAppId} -> HLTB ${m.hltbId} (${m.hltbSingle}h)`);
    }
  }
}

main().catch(console.error);
