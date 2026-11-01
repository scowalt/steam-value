import { expect, test } from "bun:test";
import { productionIdentity } from "./context";

const commit = "1234567890123456789012345678901234567890";
const woodpecker = { CI_REPO: "scowalt/steam-value", CI_PIPELINE_EVENT: "push", CI_COMMIT_REF: "refs/heads/main", CI_PIPELINE_NUMBER: "42", CI_COMMIT_SHA: commit };
const github = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "scowalt/steam-value", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: commit, STEAM_VALUE_RELEASE_CONTROLLER: "github-actions" };

test("accepts only the activated Actions publisher, with provider/run/attempt identity", () => {
  expect(productionIdentity(github)).toEqual({ repository: github.GITHUB_REPOSITORY, provider: "github-actions", run: "42", attempt: "2", commit });
  expect(() => productionIdentity(woodpecker)).toThrow("in GitHub Actions");
  expect(() => productionIdentity({})).toThrow("in GitHub Actions");
});

test("Actions requires explicit controller activation, a canonical main push and valid run identity", () => {
  for (const change of [
    { STEAM_VALUE_RELEASE_CONTROLLER: undefined }, { STEAM_VALUE_RELEASE_CONTROLLER: "woodpecker" },
    { GITHUB_ACTIONS: "false" }, { GITHUB_REPOSITORY: "someone/steam-value" },
    { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "pull_request_target" },
    { GITHUB_EVENT_NAME: "workflow_run" }, { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/pull/1/merge" }, { GITHUB_REF: "refs/tags/main" }, { GITHUB_REF: "refs/heads/topic" },
    { GITHUB_RUN_ID: "0" }, { GITHUB_RUN_ID: "../42" }, { GITHUB_RUN_ATTEMPT: undefined },
    { GITHUB_RUN_ATTEMPT: "0" }, { GITHUB_RUN_ATTEMPT: "01" }, { GITHUB_SHA: "main" },
  ]) expect(() => productionIdentity({ ...woodpecker, ...github, ...change })).toThrow();
});

test("legacy Woodpecker variables cannot authorize any production entrypoint", () => {
  for (const change of [
    { CI_REPO: "someone/steam-value" }, { CI_PIPELINE_EVENT: "pull_request" },
    { CI_PIPELINE_EVENT: "deployment" }, { CI_COMMIT_REF: "refs/tags/main" },
    { CI_COMMIT_REF: "refs/heads/topic" }, { CI_PIPELINE_NUMBER: "0" }, { CI_COMMIT_SHA: "main" },
  ]) expect(() => productionIdentity({ ...woodpecker, ...change })).toThrow();
});

test("production entrypoints reject PR execution before credentials or provider access", async () => {
  for (const entrypoint of ["artifact.ts", "current-main.ts", "retired-secrets.ts"]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", `ci/${entrypoint}`, "upload"], {
      env: { ...github, GITHUB_EVENT_NAME: "pull_request" }, stdout: "pipe", stderr: "pipe",
    });
    const [, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("requires a main push");
    expect(stderr).not.toContain("Missing");
  }
});
