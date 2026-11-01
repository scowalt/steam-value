import { expect, test } from "bun:test";

interface Rule { event: string | string[]; branch?: string; status?: string }
interface Step { name: string; image: string; commands: string[]; when?: Rule[]; failure?: string }
interface Workflow { when: Rule[]; depends_on?: string[]; concurrency?: { limit: number; group: string }; steps: Step[] }
const load = async (name: string): Promise<Workflow> => Bun.YAML.parse(await Bun.file(new URL(`../docs/ci/legacy-woodpecker/${name}.yaml`, import.meta.url)).text()) as Workflow;

test("archived Woodpecker verification preserves the historical policy/artifact barrier", async () => {
  const verify = await load("verify");
  const policy = (await load("no-comments")).steps[0]!;
  const policyIndex = verify.steps.findIndex(step => step.name === policy.name);
  const buildIndex = verify.steps.findIndex(step => step.commands.includes("bun run build"));
  const uploadIndex = verify.steps.findIndex(step => step.commands.includes("bun ci/artifact.ts upload"));
  expect(policyIndex).toBeGreaterThanOrEqual(0);
  expect(buildIndex).toBeGreaterThan(policyIndex);
  expect(uploadIndex).toBeGreaterThan(buildIndex);
  expect(verify.steps[policyIndex]).toEqual(policy);
  expect(verify.steps[buildIndex]!.commands).toContain("bun test");
  for (const step of verify.steps.slice(0, uploadIndex)) {
    expect(step.failure).toBeUndefined();
    expect(step.when).toBeUndefined();
  }
  expect(verify.steps[uploadIndex]!.failure).toBeUndefined();
  expect(verify.steps[uploadIndex]!.when).toEqual([{ event: "push", branch: "main", status: "success" }]);
});

test("archived Woodpecker deployment preserves the historical serialization and current-main checks", async () => {
  const deploy = await load("deploy");
  expect(deploy.when).toEqual([{ event: "push", branch: "main", status: "success" }]);
  expect(deploy.depends_on).toEqual(["verify", "no-comments"]);
  expect(deploy.concurrency).toEqual({ limit: 1, group: "production" });
  const download = deploy.steps.findIndex(step => step.commands.includes("bun ci/artifact.ts download"));
  const publish = deploy.steps.findIndex(step => step.commands.some(command => command.includes("wrangler deploy")));
  expect(download).toBeGreaterThanOrEqual(0);
  expect(publish).toBeGreaterThan(download);
  for (const step of deploy.steps) {
    expect(step.failure).toBeUndefined();
    expect(step.when).toBeUndefined();
    expect(step.commands.some(command => command.includes("bun run build"))).toBe(false);
  }
  const commands = deploy.steps[publish]!.commands;
  expect(commands.filter(command => command === "bun ci/current-main.ts")).toHaveLength(2);
  const cleanup = commands.indexOf("bun ci/retired-secrets.ts");
  expect(cleanup).toBeGreaterThan(commands.findIndex(command => command.includes("wrangler secret put STEAM_VALUE_DB_TOKEN")));
  expect(cleanup).toBeLessThan(commands.lastIndexOf("bun ci/current-main.ts"));
  expect(cleanup).toBeLessThan(commands.findIndex(command => command.includes("wrangler deploy")));
});

test("Woodpecker configurations and bootstrap are documentation, not active entrypoints", async () => {
  for (const name of ["verify", "deploy", "no-comments"]) {
    expect(await Bun.file(new URL(`../.woodpecker/${name}.yaml`, import.meta.url)).exists()).toBe(false);
    expect(await Bun.file(new URL(`../docs/ci/legacy-woodpecker/${name}.yaml`, import.meta.url)).exists()).toBe(true);
  }
  expect(await Bun.file(new URL("./bun.sh", import.meta.url)).exists()).toBe(false);
  expect(await Bun.file(new URL("../docs/ci/legacy-woodpecker/bun.sh", import.meta.url)).exists()).toBe(true);
});
