export interface Identity { repository: string; provider: "github-actions"; run: string; attempt: string; commit: string }
type Environment = Record<string, string | undefined>;
const positive = (value: string | undefined) => typeof value === "string" && /^[1-9][0-9]*$/.test(value);

export function validateIdentity(identity: Identity) {
  if (identity.repository !== "scowalt/steam-value" || identity.provider !== "github-actions" || !positive(identity.run) || !positive(identity.attempt) || !/^[a-f0-9]{40}$/.test(identity.commit)) throw new Error("Invalid Actions artifact identity");
}

export function productionIdentity(env: Environment = process.env): Identity {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== "scowalt/steam-value" || env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== "refs/heads/main") throw new Error("Production requires a main push from scowalt/steam-value in GitHub Actions");
  if (env.STEAM_VALUE_RELEASE_CONTROLLER !== "github-actions") throw new Error("Actions publication is not activated");
  const identity: Identity = { repository: env.GITHUB_REPOSITORY, provider: "github-actions", run: env.GITHUB_RUN_ID ?? "", attempt: env.GITHUB_RUN_ATTEMPT ?? "", commit: env.GITHUB_SHA ?? "" };
  validateIdentity(identity);
  return identity;
}

export function checkedProductionIdentity(): Identity {
  const identity = productionIdentity();
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
  if (head.exitCode !== 0 || head.stdout.toString().trim() !== identity.commit) throw new Error("Checkout identity mismatch");
  return identity;
}
