import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactKey, createArtifact, restoreArtifact, transferArtifact } from "./artifact";

const identity = { repository: "scowalt/steam-value", run: "42", commit: "1234567890123456789012345678901234567890" };
const now = 1_800_000_000;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "steam-value-artifact-"));
  roots.push(root);
  await mkdir(join(root, "dist/worker"), { recursive: true });
  await writeFile(join(root, "dist/worker/index.js"), new Uint8Array([0, 255, 42]));
  return root;
}

test("rejects another run, another commit, and expired or future artifacts", async () => {
  const root = await workspace();
  const artifact = await createArtifact(join(root, "dist"), identity, now);
  for (const [expected, time] of [
    [{ ...identity, run: "43" }, now], [{ ...identity, commit: "a".repeat(40) }, now],
    [{ ...identity, repository: "other/repository" }, now], [identity, now + 604800], [identity, now - 1],
  ] as const) {
    await expect(restoreArtifact(artifact, join(root, "rejected"), expected, time)).rejects.toThrow();
  }
});

test("rejects corruption, unsafe paths, duplicates and empty output before restoring any file", async () => {
  const root = await workspace();
  const artifact = JSON.parse(await createArtifact(join(root, "dist"), identity, now));
  for (const files of [
    [{ ...artifact.files[0], content: "changed" }],
    [{ ...artifact.files[0], path: "../escaped" }],
    [{ ...artifact.files[0], path: "/absolute" }],
    [{ ...artifact.files[0], path: "worker/../escaped" }],
    [artifact.files[0], artifact.files[0]], [],
  ]) {
    await expect(restoreArtifact(JSON.stringify({ ...artifact, files }), join(root, "rejected"), identity, now)).rejects.toThrow();
    expect(await Bun.file(join(root, "rejected/worker/index.js")).exists()).toBe(false);
  }
});

test("fails for missing, empty or non-regular output instead of publishing an empty artifact", async () => {
  const root = await workspace();
  await expect(createArtifact(join(root, "missing"), identity, now)).rejects.toThrow();
  await mkdir(join(root, "empty"));
  await expect(createArtifact(join(root, "empty"), identity, now)).rejects.toThrow();
  await symlink(join(root, "dist/worker/index.js"), join(root, "dist/linked"));
  await expect(createArtifact(join(root, "dist"), identity, now)).rejects.toThrow();
});

test("addresses only the triggering repository, run and commit without an older-run fallback", () => {
  expect(artifactKey(identity)).toBe("steam-value/42/1234567890123456789012345678901234567890.json");
  for (const invalid of [{ ...identity, run: "../41" }, { ...identity, commit: "main" }, { ...identity, repository: "other/repo" }]) {
    expect(() => artifactKey(invalid)).toThrow();
  }
});

test("transfers through retained storage and fails closed on missing storage objects", async () => {
  const root = await workspace();
  const objects = new Map<string, string>();
  const store = {
    put: async (key: string, text: string) => { objects.set(key, text); },
    get: async (key: string) => { const text = objects.get(key); if (!text) throw new Error("Missing artifact"); return text; },
  };
  await writeFile(join(root, "dist/another.txt"), "retained too");
  await transferArtifact("upload", store, join(root, "dist"), identity, now);
  await transferArtifact("download", store, join(root, "downloaded"), identity, now + 1);
  expect([...await readFile(join(root, "downloaded/worker/index.js"))]).toEqual([0, 255, 42]);
  await expect(transferArtifact("download", store, join(root, "wrong"), { ...identity, run: "43" }, now + 1)).rejects.toThrow("Missing artifact");
  const key = artifactKey(identity);
  const value = JSON.parse(objects.get(key)!);
  value.files = value.files.filter((file: { path: string }) => file.path !== "another.txt");
  objects.set(key, JSON.stringify(value));
  await expect(transferArtifact("download", store, join(root, "tampered"), identity, now + 1)).rejects.toThrow("integrity");
});

test("keeps the original upload-artifact default exclusion of hidden output", async () => {
  const root = await workspace();
  await writeFile(join(root, "dist/.hidden"), "not selected");
  await mkdir(join(root, "dist/.private"));
  await writeFile(join(root, "dist/.private/data"), "not selected");
  const artifact = await createArtifact(join(root, "dist"), identity, now);
  await restoreArtifact(artifact, join(root, "visible"), identity, now);
  expect(await Bun.file(join(root, "visible/.hidden")).exists()).toBe(false);
  expect(await Bun.file(join(root, "visible/.private/data")).exists()).toBe(false);
});

test("restores the successful run's exact binary output, not a rebuild", async () => {
  const root = await workspace();
  const artifact = await createArtifact(join(root, "dist"), identity, now);
  await restoreArtifact(artifact, join(root, "restored"), identity, now + 1);
  expect([...await readFile(join(root, "restored/worker/index.js"))]).toEqual([0, 255, 42]);
});
