#!/usr/bin/env bun
import { client, db } from "../src/db/client";
import { recalculateScores, reportManualError } from "../src/db/manual";
import { formulaConfig } from "../src/formula/config";

async function main() {
  console.log("Recalculating value scores...");
  console.log(`Formula config: timeMetric=${formulaConfig.timeMetric}, exponent=${formulaConfig.hoursPenaltyExponent}`);
  console.log("-".repeat(60));

  const { updates, unchanged, updated, failed, total } = await recalculateScores(db, client, (batch) => {
    if (batch.error) {
      console.error(`  Batch ${batch.number} failed:`, batch.error);
    } else {
      console.log(`  Batch ${batch.number}: updated ${batch.count} games (${batch.updated}/${batch.total})`);
    }
  });

  if (total === 0) {
    console.log("No games found in database.");
    return;
  }
  console.log(`Computed scores: ${updates.length} to update, ${unchanged} unchanged`);

  for (const update of updates.slice(0, 10)) {
    const change = update.oldScore !== null && update.newScore !== null
      ? `${update.oldScore.toFixed(2)} → ${update.newScore.toFixed(2)}`
      : update.newScore !== null
        ? `N/A → ${update.newScore.toFixed(2)}`
        : `${update.oldScore?.toFixed(2)} → N/A`;
    console.log(`  ${update.name}: ${change}`);
  }

  console.log("-".repeat(60));
  console.log(`Done! Updated: ${updated}, Unchanged: ${unchanged}, Failed: ${failed}`);
}

main().catch(reportManualError);
