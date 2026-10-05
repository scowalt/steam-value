#!/usr/bin/env bun

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

const query = `
SELECT ?game ?gameLabel ?steamId ?hltbId WHERE {
  ?game wdt:P31 wd:Q7889;
        wdt:P1733 ?steamId;
        wdt:P2816 ?hltbId.
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 10
`;

async function main() {
  const url = new URL(SPARQL_ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");

  console.log("Querying Wikidata for Steam-HLTB mappings...\n");

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "SteamValueBot/1.0",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Query failed: ${response.status}`);
  }

  const data = await response.json();
  const bindings = data.results.bindings;

  console.log(`Found ${bindings.length} games with both Steam and HLTB IDs:\n`);

  bindings.forEach((b: any, i: number) => {
    console.log(`${i + 1}. ${b.gameLabel.value}`);
    console.log(`   Steam: ${b.steamId.value} -> HLTB: ${b.hltbId.value}`);
  });
}

main().catch(console.error);
