#!/usr/bin/env bun
import { mkdir, rm } from "node:fs/promises";

const htmlFiles = ["index.html", "city-builders.html"];

await rm("dist", { recursive: true, force: true });
await mkdir("dist/assets", { recursive: true });
await mkdir("dist/worker", { recursive: true });

for (const file of htmlFiles) {
  const source = Bun.file(`src/web/${file}`);
  if (await source.exists()) {
    await Bun.write(`dist/assets/${file}`, source);
  }
}

await buildOrExit(
  Bun.build({
    entrypoints: ["src/web/app.ts"],
    target: "browser",
    minify: true,
    outdir: "dist/assets",
    naming: "app.js",
  }),
  "browser app"
);

await buildOrExit(
  Bun.build({
    entrypoints: ["src/worker/index.ts"],
    target: "browser",
    minify: true,
    outdir: "dist/worker",
    naming: "index.js",
  }),
  "Cloudflare Worker"
);

async function buildOrExit(build: ReturnType<typeof Bun.build>, label: string) {
  const result = await build;

  if (!result.success) {
    console.error(`Failed to build ${label}`);
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}
