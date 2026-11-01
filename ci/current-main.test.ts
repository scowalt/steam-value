import { expect, test } from "bun:test";
import { assertCurrentMain, checkCurrentMain } from "./current-main";

const sha = "1234567890123456789012345678901234567890";
test("allows the exact tested current main and rejects delayed or rerun old commits", async () => {
  await assertCurrentMain(sha, async () => sha);
  await expect(assertCurrentMain(sha, async () => "a".repeat(40))).rejects.toThrow("no longer current main");
  await expect(assertCurrentMain(sha, async () => { throw new Error("Unavailable main"); })).rejects.toThrow();
  await expect(assertCurrentMain("main", async () => "main")).rejects.toThrow();
});

test("the production main check validates context and credentials before a bounded read", async () => {
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "scowalt/steam-value", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: sha, STEAM_VALUE_RELEASE_CONTROLLER: "github-actions", STEAM_VALUE_CONTENTS_READ_TOKEN: "synthetic-contents-reader" };
  const requests: Request[] = [];
  const read = async (request: Request) => {
    requests.push(request);
    expect(request.url).toBe("https://api.github.com/repos/scowalt/steam-value/commits/main");
    expect(request.redirect).toBe("error");
    expect(request.headers.get("Authorization")).toBe("Bearer synthetic-contents-reader");
    return Response.json({ sha });
  };
  for (const change of [{ GITHUB_EVENT_NAME: "pull_request" }, { STEAM_VALUE_RELEASE_CONTROLLER: "" }, { STEAM_VALUE_CONTENTS_READ_TOKEN: "" }]) {
    await expect(checkCurrentMain({ ...env, ...change }, read)).rejects.toThrow();
  }
  expect(requests).toHaveLength(0);
  await checkCurrentMain(env, read);
  expect(requests).toHaveLength(1);
  await expect(checkCurrentMain(env, async () => Response.json({ sha: "a".repeat(40) }))).rejects.toThrow("no longer current main");
  await expect(checkCurrentMain(env, async () => new Response("private upstream detail", { status: 403 }))).rejects.toThrow("HTTP 403");
});
