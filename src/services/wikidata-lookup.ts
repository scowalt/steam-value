
const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "SteamValueBot/1.0 (https://github.com/steam-value)";

export interface WikidataCandidate {
  steamAppId: number;
  hltbId: number;
  name: string;
  source: "wikidata";
}

const wikidataCache = new Map<number, WikidataCandidate | null>();

async function querySparql<T>(sparql: string): Promise<T> {
  const url = new URL(SPARQL_ENDPOINT);
  url.searchParams.set("query", sparql);
  url.searchParams.set("format", "json");

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Wikidata query failed: ${response.status}`);
  }

  return response.json();
}

export async function getWikidataCandidate(
  steamAppId: number
): Promise<WikidataCandidate | null> {
  if (wikidataCache.has(steamAppId)) {
    return wikidataCache.get(steamAppId) ?? null;
  }

  const query = `
    SELECT ?gameLabel ?hltbId WHERE {
      ?game wdt:P1733 "${steamAppId}";
            wdt:P2816 ?hltbId.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 1
  `;

  try {
    const data = await querySparql<{
      results: { bindings: Array<{ gameLabel: { value: string }; hltbId: { value: string } }> };
    }>(query);

    if (data.results.bindings.length === 0) {
      wikidataCache.set(steamAppId, null);
      return null;
    }

    const binding = data.results.bindings[0];
    const candidate: WikidataCandidate = {
      steamAppId,
      hltbId: parseInt(binding.hltbId.value, 10),
      name: binding.gameLabel.value,
      source: "wikidata",
    };

    wikidataCache.set(steamAppId, candidate);
    return candidate;
  } catch (error) {
    console.error(`[Wikidata] Query failed for Steam ${steamAppId}:`, error);
    return null;
  }
}

export async function getWikidataCandidatesBatch(
  steamAppIds: number[]
): Promise<Map<number, WikidataCandidate>> {
  const results = new Map<number, WikidataCandidate>();

  const batchSize = 50;
  for (let i = 0; i < steamAppIds.length; i += batchSize) {
    const batch = steamAppIds.slice(i, i + batchSize);
    const steamIdValues = batch.map((id) => `"${id}"`).join(" ");

    const query = `
      SELECT ?steamId ?gameLabel ?hltbId WHERE {
        VALUES ?steamId { ${steamIdValues} }
        ?game wdt:P1733 ?steamId;
              wdt:P2816 ?hltbId.
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }
    `;

    try {
      const data = await querySparql<{
        results: {
          bindings: Array<{
            steamId: { value: string };
            gameLabel: { value: string };
            hltbId: { value: string };
          }>;
        };
      }>(query);

      for (const binding of data.results.bindings) {
        const steamAppId = parseInt(binding.steamId.value, 10);
        const candidate: WikidataCandidate = {
          steamAppId,
          hltbId: parseInt(binding.hltbId.value, 10),
          name: binding.gameLabel.value,
          source: "wikidata",
        };
        results.set(steamAppId, candidate);
        wikidataCache.set(steamAppId, candidate);
      }
    } catch (error) {
      console.error(`[Wikidata] Batch query failed:`, error);
    }
  }

  return results;
}

export async function downloadAllWikidataMappings(): Promise<WikidataCandidate[]> {
  console.log("[Wikidata] Downloading all Steam-HLTB mappings...");

  const query = `
    SELECT ?steamId ?gameLabel ?hltbId WHERE {
      ?game wdt:P31 wd:Q7889;
            wdt:P1733 ?steamId;
            wdt:P2816 ?hltbId.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
  `;

  const data = await querySparql<{
    results: {
      bindings: Array<{
        steamId: { value: string };
        gameLabel: { value: string };
        hltbId: { value: string };
      }>;
    };
  }>(query);

  const candidates: WikidataCandidate[] = data.results.bindings.map((b) => ({
    steamAppId: parseInt(b.steamId.value, 10),
    hltbId: parseInt(b.hltbId.value, 10),
    name: b.gameLabel.value,
    source: "wikidata" as const,
  }));

  console.log(`[Wikidata] Downloaded ${candidates.length} mappings`);
  return candidates;
}
