#!/usr/bin/env bun
import { main, reportMigrationError } from "./db-migrate";

if (import.meta.main) await main(Bun.argv.slice(2)).catch(reportMigrationError);
