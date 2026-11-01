#!/usr/bin/env bun
import { cp, mkdir, rm } from "node:fs/promises";

const staticFiles = ["index.html", "city-builders.html", "logo.svg", "favicon.svg", "favicon.ico"];

await rm("dist", { recursive: true, force: true });
await mkdir("dist/assets", { recursive: true });
await mkdir("dist/worker", { recursive: true });

for (const file of staticFiles) {
  await Bun.write(`dist/assets/${file}`, Bun.file(`src/web/${file}`));
}

await cp("src/web/vendor/0build/0.6.13", "dist/assets/vendor/0build/0.6.13", { recursive: true });
await cp("LICENSE", "dist/assets/LICENSE.txt");
await cp("THIRD_PARTY_NOTICES.md", "dist/assets/THIRD_PARTY_NOTICES.txt");

await buildOrExit(
  Bun.build({
    entrypoints: ["src/web/app.ts", "src/web/city-builders.ts", "src/web/styles.css"],
    target: "browser",
    minify: true,
    outdir: "dist/assets",
    naming: "[name].[ext]",
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
