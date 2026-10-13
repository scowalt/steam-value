#!/usr/bin/env bun

const SECRET_KEYS = [
  "STEAM_VALUE_DB_TOKEN",
];

const mode = process.argv[2];

if (mode !== "dev-vars" && mode !== "sync") {
  console.error("Usage: bun scripts/cloudflare-secrets.ts <dev-vars|sync>");
  process.exit(1);
}

const secrets = await loadDopplerSecrets();
const selected = selectRequiredSecrets(secrets);

if (mode === "dev-vars") {
  await Bun.write(
    ".dev.vars",
    Object.entries(selected)
      .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
      .join("\n") + "\n"
  );
  console.log(`Wrote ${Object.keys(selected).length} Worker secrets to .dev.vars`);
} else {
  await syncCloudflareSecrets(selected);
  console.log(`Synced ${Object.keys(selected).length} Worker secrets to Cloudflare`);
}

async function loadDopplerSecrets(): Promise<Record<string, string>> {
  const proc = Bun.spawn(
    [
      "doppler",
      "secrets",
      "download",
      "--project",
      "steam-value",
      "--config",
      "dev",
      "--format",
      "json",
      "--no-file",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    console.error(stderr.trim() || "Failed to read Doppler secrets");
    process.exit(exitCode);
  }

  return JSON.parse(stdout) as Record<string, string>;
}

function selectRequiredSecrets(secrets: Record<string, string>): Record<string, string> {
  const selected: Record<string, string> = {};
  const missing: string[] = [];

  for (const key of SECRET_KEYS) {
    const value = secrets[key];
    if (!value) {
      missing.push(key);
    } else {
      selected[key] = value;
    }
  }

  if (missing.length > 0) {
    console.error(`Missing required Doppler secrets: ${missing.join(", ")}`);
    process.exit(1);
  }

  return selected;
}

async function syncCloudflareSecrets(secrets: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(["bunx", "wrangler", "secret", "bulk", "--name", "steam-value"], {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });

  proc.stdin.write(JSON.stringify(secrets));
  proc.stdin.end();

  const exitCode = await proc.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

function quoteEnvValue(value: string): string {
  return JSON.stringify(value);
}
