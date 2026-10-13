#!/usr/bin/env bun
import { main } from "./refresh-steam-catalog";
export { main };

if (import.meta.main) {
  main().catch((error) => {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
