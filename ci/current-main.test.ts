import { expect, test } from "bun:test";
import { assertCurrentMain } from "./current-main";

const sha = "1234567890123456789012345678901234567890";
test("allows the exact tested current main and rejects delayed or rerun old commits", async () => {
  await assertCurrentMain(sha, async () => sha);
  await expect(assertCurrentMain(sha, async () => "a".repeat(40))).rejects.toThrow("no longer current main");
  await expect(assertCurrentMain(sha, async () => { throw new Error("Unavailable main"); })).rejects.toThrow();
  await expect(assertCurrentMain("main", async () => "main")).rejects.toThrow();
});
