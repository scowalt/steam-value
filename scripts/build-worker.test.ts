import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("the actual build ships application and vendor licenses without bundling runtime data", async () => {
  const root = await mkdtemp(join(tmpdir(), "steam-value-build-licenses-"));
  roots.push(root);
  await symlink(new URL("../src", import.meta.url).pathname, join(root, "src"), "dir");
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) await copyFile(new URL(`../${name}`, import.meta.url), join(root, name));
  const child = Bun.spawn([process.execPath, "--no-env-file", new URL("./build-worker.ts", import.meta.url).pathname], {
    cwd: root, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  for (const [source, output] of [
    ["LICENSE", "LICENSE.txt"], ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.txt"],
    ["src/web/vendor/0build/0.6.13/LICENSE.md", "vendor/0build/0.6.13/LICENSE.md"],
  ]) {
    expect(await Bun.file(join(root, "dist/assets", output!)).text()).toBe(await Bun.file(new URL(`../${source}`, import.meta.url)).text());
  }
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: join(root, "dist"), dot: true, onlyFiles: true }));
  expect(files.sort()).toEqual([
    "assets/LICENSE.txt", "assets/THIRD_PARTY_NOTICES.txt", "assets/app.js", "assets/city-builders.html",
    "assets/city-builders.js", "assets/index.html", "assets/styles.css", "assets/vendor/0build/0.6.13/LICENSE.md",
    "assets/vendor/0build/0.6.13/kit.min.css", "worker/index.js",
  ]);
}, 30_000);
