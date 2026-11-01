import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

interface Step { name?: string; uses?: string; run?: string; shell?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown>; "continue-on-error"?: boolean }
interface Job { if?: string; needs?: string; environment?: string; env?: Record<string, string>; steps: Step[]; "runs-on": string; concurrency?: { group: string; "cancel-in-progress": boolean }; "continue-on-error"?: boolean }
interface Workflow { on: unknown; permissions: Record<string, string>; defaults?: { run: { shell: string } }; concurrency: { group: string; "cancel-in-progress": string }; jobs: Record<string, Job> }
const load = async (name: string): Promise<Workflow> => Bun.YAML.parse(await Bun.file(new URL(`../.github/workflows/${name}.yml`, import.meta.url)).text()) as Workflow;
const verification = async (): Promise<Step[]> => (Bun.YAML.parse(await Bun.file(new URL("../.github/actions/verify/action.yml", import.meta.url)).text()) as { runs: { steps: Step[] } }).runs.steps;
const gate = "github.repository == 'scowalt/steam-value' && github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.STEAM_VALUE_RELEASE_CONTROLLER == 'github-actions'";
const workflowGate = `\${{ ${gate} }}`;
const mainCheck = "bun --no-env-file ci/current-main.ts";

function failFast(steps: Step[]) {
  for (const step of steps) {
    expect(step["continue-on-error"]).toBeUndefined();
    expect(step.if).toBeUndefined();
  }
}

test("Actions is verification-only until explicitly selected; forks and PRs get no protected job", async () => {
  const ci = await load("ci");
  expect(ci.on).toEqual({ pull_request: null, push: { branches: ["main"] } });
  expect(ci.jobs.verify!.if).toBe(`\${{ !(${gate}) }}`);
  expect(ci.jobs["verify-main"]!.if).toBe(workflowGate);
  expect(ci.jobs.deploy!.if).toBe(workflowGate);
  expect(ci.jobs.verify!.environment).toBeUndefined();
  expect(ci.jobs.verify!.env).toBeUndefined();
  expect(JSON.stringify(ci.jobs.verify)).not.toContain("secrets.");
  expect(JSON.stringify(await verification())).not.toContain("secrets.");
  expect(ci.jobs["verify-main"]!.environment).toBe("artifact-publication");
  expect(ci.jobs.deploy!.environment).toBe("production");
  for (const name of ["verify-main", "deploy"]) {
    expect(ci.jobs[name]!.env).toEqual({ STEAM_VALUE_RELEASE_CONTROLLER: "${{ vars.STEAM_VALUE_RELEASE_CONTROLLER }}" });
  }
});

test("public and main verification share fail-fast policy/test/build steps before private artifact publication", async () => {
  const ci = await load("ci");
  const policy = (await load("no-comments")).jobs["no-comments"]!.steps.filter(step => step.run);
  const steps = await verification();
  const commands = steps.flatMap(step => step.run ? [step.run] : []);
  expect(commands.slice(1, 3)).toEqual(policy.map(step => step.run!));
  expect(commands).toEqual([
    "git show --no-patch --format='tested commit=%H tree=%T parents=%P'",
    ...policy.map(step => step.run!),
    "bun --no-env-file install --frozen-lockfile",
    "bun --no-env-file x --no-install playwright install --with-deps chromium",
    "bun --no-env-file test",
    "bun --no-env-file run build",
  ]);
  failFast(steps);
  for (const step of steps.filter(step => step.run)) expect(step.shell).toBe("bash");
  expect(ci.defaults).toEqual({ run: { shell: "bash" } });
  expect(ci.jobs.verify!.steps.map(step => step.uses)).toEqual([expect.stringContaining("actions/checkout@"), "./.github/actions/verify"]);
  const main = ci.jobs["verify-main"]!.steps;
  expect(main[1]!.uses).toBe("./.github/actions/verify");
  expect(main.slice(2).map(step => step.run)).toEqual([mainCheck, "bun --no-env-file ci/artifact.ts upload"]);
  expect(main.at(-1)!.env!.STEAM_VALUE_ARTIFACT_SECRET_KEY).toBe("${{ secrets.STEAM_VALUE_CI_ARTIFACT_WRITE_SECRET_KEY }}");
  expect(JSON.stringify(main)).not.toContain("CLOUDFLARE_API_TOKEN");
  expect(JSON.stringify(main)).not.toContain("STEAM_VALUE_DB_TOKEN");
  failFast(main);
});

test("one serialized publisher consumes only verified same-run output and checks main before mutations", async () => {
  expect((await readdir(new URL("../.github/workflows", import.meta.url))).filter(name => name.endsWith(".yml")).sort()).toEqual(["ci.yml", "no-comments.yml"]);
  const ci = await load("ci");
  const job = ci.jobs.deploy!;
  expect(job.needs).toBe("verify-main");
  expect(job.concurrency).toEqual({ group: "production", "cancel-in-progress": false });
  expect(ci.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  expect(job.steps[0]!.with!.ref).toBe("${{ github.sha }}");
  expect(ci.jobs["verify-main"]!.steps[0]!.with!.ref).toBe("${{ github.sha }}");
  const commands = job.steps.flatMap(step => step.run ? [step.run] : []);
  expect(commands.slice(0, 3)).toEqual([mainCheck, "bun --no-env-file install --frozen-lockfile", "bun --no-env-file ci/artifact.ts download"]);
  expect(commands[3]!.trim().split("\n")).toEqual([
    mainCheck,
    'test -n "$STEAM_VALUE_DB_TOKEN"',
    'printf \'%s\' "$STEAM_VALUE_DB_TOKEN" | bun --no-env-file x --no-install wrangler secret put STEAM_VALUE_DB_TOKEN --name steam-value',
    "bun --no-env-file ci/retired-secrets.ts",
    mainCheck,
    'bun --no-env-file x --no-install wrangler deploy --no-bundle --strict --keep-vars --message "GitHub commit $GITHUB_SHA" --tag "$GITHUB_SHA"',
  ]);
  expect(JSON.stringify(job.steps)).not.toContain("./.github/actions/verify");
  expect(commands.join("\n")).not.toMatch(/\bbuild\b/);
  expect(JSON.stringify(job)).not.toContain("ARTIFACT_WRITE");
  expect(JSON.stringify(ci)).not.toContain("actions/upload-artifact");
  expect(JSON.stringify(ci)).not.toContain("actions/download-artifact");
  failFast(job.steps);
});

test("active workflows use hosted runners, read-only tokens, pinned actions and no shared caches or checkout credentials", async () => {
  const steps = await verification();
  for (const name of ["ci", "no-comments"]) {
    const workflow = await load(name);
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(workflow.jobs)) {
      expect(job["runs-on"]).toBe("ubuntu-24.04");
      expect(job["continue-on-error"]).toBeUndefined();
      steps.push(...job.steps);
    }
  }
  for (const step of steps) {
    if (step.uses && !step.uses.startsWith("./")) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
    if (step.uses?.startsWith("actions/checkout@")) expect(step.with!["persist-credentials"]).toBe(false);
    if (step.uses?.startsWith("jdx/mise-action@")) expect(step.with).toEqual({ cache: false, env: false });
    if (step.uses?.startsWith("astral-sh/setup-uv@")) expect(step.with!["enable-cache"]).toBe(false);
    expect(step.uses ?? "").not.toContain("actions/cache");
  }
});
