#!/usr/bin/env bun
/**
 * Backwards-compatible alias for the SteamSpy catalog refresh job.
 */
import { main } from "./refresh-steamspy-catalog";

if (import.meta.main) {
  main().catch((error) => {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
