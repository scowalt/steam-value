import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const file = "/app/api/build/services/cdp/cdp.service.js";
const source = readFileSync(file, "utf8");
const expected = "9f26a8d43249f4f2e878a208672c9910ad0ac0bd225c8cfe01d2f135be708d8c";
if (createHash("sha256").update(source).digest("hex") !== expected) throw new Error("Unexpected pinned Steel shutdown source; no patch");
const before = "            this.removeAllHandlers();\n            await this.browserInstance?.close();";
const after = "            await this.browserInstance?.close();\n            this.removeAllHandlers();";
if (source.split(before).length !== 2) throw new Error("Steel shutdown patch site is not unique");
writeFileSync(file, source.replace(before, after));
console.log("Applied pinned Steel shutdown-order fix");
