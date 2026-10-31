import { expect, test } from "bun:test";
import { retireLegacyWorkerSecrets } from "./retired-secrets";

const accountId = "0123456789abcdef0123456789abcdef";
const application = "STEAM_VALUE_DB_TOKEN";
const retired = ["TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL"];
function fixture(names = [application, ...retired, "TURSO_UNRELATED"]) {
  const secrets = new Set(names);
  const events: string[] = [];
  return {
    secrets, events,
    options: {
      accountId, apiToken: "synthetic-publisher-token",
      assertCurrentMain: async () => { events.push("current-main"); },
      fetch: async (request: Request) => {
        expect(request.redirect).toBe("error");
        expect(request.headers.get("Authorization")).toBe("Bearer synthetic-publisher-token");
        const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/steam-value/secrets`;
        if (request.method === "GET") {
          expect(request.url).toBe(base);
          events.push("GET");
          return Response.json({ success: true, result: [...secrets].map(name => ({ name, type: "secret_text" })) });
        }
        expect(request.method).toBe("DELETE");
        const name = request.url.slice(base.length + 1);
        expect(retired).toContain(name);
        events.push(`DELETE ${name}`);
        secrets.delete(name);
        return Response.json({ success: true, result: null });
      },
    },
  };
}

test("removes only the two retired names, guarding each mutation and preserving other secrets", async () => {
  const f = fixture();
  expect(await retireLegacyWorkerSecrets(f.options)).toEqual(retired);
  expect([...f.secrets]).toEqual([application, "TURSO_UNRELATED"]);
  expect(f.events).toEqual(["GET", "current-main", "DELETE TURSO_AUTH_TOKEN", "current-main", "DELETE TURSO_DATABASE_URL", "GET"]);
});

test("is a read-only no-op once retirement is complete", async () => {
  const f = fixture([application, "OTHER"]);
  expect(await retireLegacyWorkerSecrets(f.options)).toEqual([]);
  expect(f.events).toEqual(["GET", "GET"]);
  expect([...f.secrets]).toEqual([application, "OTHER"]);
});

test("stale main prevents deletion and a changed main stops before the next mutation", async () => {
  for (const permitted of [0, 1]) {
    const f = fixture();
    let checks = 0;
    f.options.assertCurrentMain = async () => { if (checks++ >= permitted) throw new Error("Stale main"); };
    await expect(retireLegacyWorkerSecrets(f.options)).rejects.toThrow("Stale main");
    expect(f.events.filter(event => event.startsWith("DELETE"))).toHaveLength(permitted);
    expect(f.secrets.has(application)).toBe(true);
    expect(f.secrets.has("TURSO_DATABASE_URL")).toBe(true);
  }
});

test("missing application authorization or malformed inventory fails before mutation", async () => {
  const responses = [
    { success: true, result: [] },
    { success: true, result: [{ name: application, type: "secret_text" }, { name: application, type: "secret_text" }] },
    { success: true, result: [{ name: application, type: "secret_text" }, { name: "TURSO_AUTH_TOKEN", type: "unexpected" }] },
    { success: true, result: null },
    { success: false, errors: [{ message: "private upstream value" }] },
  ];
  for (const body of responses) {
    const f = fixture();
    f.options.fetch = async request => { expect(request.method).toBe("GET"); return Response.json(body); };
    await expect(retireLegacyWorkerSecrets(f.options)).rejects.toThrow();
    expect(f.events).toEqual([]);
  }
});

test.each(["http", "transport", "malformed"])("failed or uncertain deletion stops without retry or value disclosure: %s", async failure => {
  const f = fixture();
  const send = f.options.fetch;
  let deletes = 0;
  f.options.fetch = async request => {
    if (request.method === "GET") return send(request);
    deletes++;
    if (failure === "http") return Response.json({ errors: [{ message: "private upstream value" }] }, { status: 503 });
    await send(request);
    if (failure === "transport") throw new Error("private transport value");
    return new Response("private malformed response");
  };
  let error: unknown;
  try { await retireLegacyWorkerSecrets(f.options); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain("private");
  expect(String(error)).not.toContain("synthetic-publisher-token");
  expect(deletes).toBe(1);
  expect(f.secrets.has(application)).toBe(true);
  expect(f.secrets.has("TURSO_DATABASE_URL")).toBe(true);
});

test("readback must confirm retired names absent and all protected names retained", async () => {
  for (const corrupt of ["retired-remains", "protected-missing"]) {
    const f = fixture();
    const send = f.options.fetch;
    let reads = 0;
    f.options.fetch = async request => {
      if (request.method === "GET" && reads++ === 1) {
        if (corrupt === "retired-remains") f.secrets.add("TURSO_AUTH_TOKEN");
        else f.secrets.delete("TURSO_UNRELATED");
      }
      return send(request);
    };
    await expect(retireLegacyWorkerSecrets(f.options)).rejects.toThrow("readback differs");
  }
});

test("invalid publisher configuration never contacts Cloudflare", async () => {
  for (const override of [{ accountId: "wrong-account" }, { apiToken: "" }]) {
    const f = fixture();
    await expect(retireLegacyWorkerSecrets({ ...f.options, ...override })).rejects.toThrow("configuration");
    expect(f.events).toEqual([]);
  }
});

test("the cleanup entrypoint refuses PR execution before looking up credentials", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "ci/retired-secrets.ts"], { env: { CI_REPO: "scowalt/steam-value", CI_PIPELINE_EVENT: "pull_request", CI_COMMIT_REF: "refs/heads/main" }, stdout: "pipe", stderr: "pipe" });
  const [, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).not.toBe(0);
  expect(stderr).toContain("requires a main push");
});
