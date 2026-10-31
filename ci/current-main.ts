export async function assertCurrentMain(tested: string, readMain: () => Promise<string>) {
  if (!/^[a-f0-9]{40}$/.test(tested) || await readMain() !== tested) {
    throw new Error("Refusing to deploy a tested commit that is no longer current main.");
  }
}

if (import.meta.main) {
  const token = process.env.STEAM_VALUE_CONTENTS_READ_TOKEN;
  if (!token) throw new Error("Missing repository contents-read binding");
  await assertCurrentMain(process.env.CI_COMMIT_SHA ?? "", async () => {
    const response = await fetch("https://api.github.com/repos/scowalt/steam-value/commits/main", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Cannot read current main (HTTP ${response.status})`);
    const value = await response.json();
    return value.sha;
  });
}
