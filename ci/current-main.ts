import { productionIdentity } from "./context";

export async function assertCurrentMain(tested: string, readMain: () => Promise<string>) {
  if (!/^[a-f0-9]{40}$/.test(tested) || await readMain() !== tested) {
    throw new Error("Refusing to deploy a tested commit that is no longer current main.");
  }
}

export async function checkCurrentMain(env: Record<string, string | undefined> = process.env, send: (request: Request) => Promise<Response> = request => fetch(request)) {
  const identity = productionIdentity(env);
  const token = env.STEAM_VALUE_CONTENTS_READ_TOKEN;
  if (!token) throw new Error("Missing repository contents-read binding");
  await assertCurrentMain(identity.commit, async () => {
    let response: Response;
    try {
      response = await send(new Request("https://api.github.com/repos/scowalt/steam-value/commits/main", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        redirect: "error", signal: AbortSignal.timeout(30000),
      }));
    } catch { throw new Error("Cannot read current main (transport failure)"); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Cannot read current main (HTTP ${response.status})`);
    }
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error("Invalid current main response"); }
    if (value === null || typeof value !== "object" || !("sha" in value) || typeof value.sha !== "string") throw new Error("Invalid current main response");
    return value.sha;
  });
}

if (import.meta.main) await checkCurrentMain();
