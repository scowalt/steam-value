#!/usr/bin/env bun
import { getHltbById } from "../src/scrapers/hltb";

const searchTerm = process.argv[2]?.toLowerCase() ?? "";
const startId = parseInt(process.argv[3] ?? "1");
const endId = parseInt(process.argv[4] ?? "100");

if (!searchTerm) {
  console.log("Usage: bun scripts/search-hltb.ts <search_term> [start_id] [end_id]");
  process.exit(1);
}

console.log(`Searching for "${searchTerm}" in IDs ${startId}-${endId}...`);

for (let id = startId; id <= endId; id++) {
  try {
    const data = await getHltbById(id);
    if (data && data.name.toLowerCase().includes(searchTerm)) {
      console.log(`Found: ${id} -> ${data.name} (${data.main?.toFixed(1)}h)`);
    }
  } catch {}
  await new Promise(r => setTimeout(r, 150));
}

console.log("Done.");
