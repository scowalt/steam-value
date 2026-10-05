#!/usr/bin/env bun

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

async function query(sparql: string) {
  const url = new URL(SPARQL_ENDPOINT);
  url.searchParams.set("query", sparql);
  url.searchParams.set("format", "json");

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "SteamValueBot/1.0",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Query failed: ${response.status}`);
  }

  return response.json();
}

async function main() {
  const countQuery = `
    SELECT (COUNT(*) as ?count) WHERE {
      ?game wdt:P31 wd:Q7889;
            wdt:P1733 ?steamId;
            wdt:P2816 ?hltbId.
    }
  `;

  const countData = await query(countQuery);
  console.log("Total Steam-HLTB mappings in Wikidata:", countData.results.bindings[0].count.value);

  const bmwQuery = `
    SELECT ?game ?gameLabel ?steamId ?hltbId WHERE {
      ?game wdt:P1733 "2358720";
            wdt:P2816 ?hltbId.
      OPTIONAL { ?game wdt:P1733 ?steamId }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
  `;

  console.log("\nSearching for Black Myth Wukong (Steam 2358720)...");
  const bmwData = await query(bmwQuery);

  if (bmwData.results.bindings.length > 0) {
    const b = bmwData.results.bindings[0];
    console.log("Found:", b.gameLabel.value);
    console.log("HLTB ID:", b.hltbId.value);
  } else {
    console.log("Not found with HLTB mapping");

    const gameQuery = `
      SELECT ?game ?gameLabel ?steamId WHERE {
        ?game wdt:P1733 "2358720".
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }
    `;
    const gameData = await query(gameQuery);
    if (gameData.results.bindings.length > 0) {
      console.log("Game exists but no HLTB ID:", gameData.results.bindings[0].gameLabel.value);
    }
  }

  const missingIds = ["739630", "892970", "990080", "1687950"];  
  console.log("\nChecking other missing games:");

  for (const steamId of missingIds) {
    const q = `
      SELECT ?gameLabel ?hltbId WHERE {
        ?game wdt:P1733 "${steamId}".
        OPTIONAL { ?game wdt:P2816 ?hltbId }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }
    `;
    const data = await query(q);
    if (data.results.bindings.length > 0) {
      const b = data.results.bindings[0];
      const hltb = b.hltbId?.value || "NO HLTB";
      console.log(`  Steam ${steamId}: ${b.gameLabel.value} -> HLTB: ${hltb}`);
    } else {
      console.log(`  Steam ${steamId}: Not in Wikidata`);
    }
  }
}

main().catch(console.error);
