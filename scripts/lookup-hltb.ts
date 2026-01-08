#!/usr/bin/env bun
import { getHltbById } from "../src/scrapers/hltb";

const id = parseInt(process.argv[2], 10);
if (isNaN(id)) {
  console.log("Usage: bun scripts/lookup-hltb.ts <hltb_id>");
  process.exit(1);
}

const data = await getHltbById(id);
console.log(JSON.stringify(data, null, 2));
