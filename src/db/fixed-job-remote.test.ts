import { expect, test } from "bun:test";
import { constants } from "node:fs";
import { link, mkdtemp, open, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { createLocalD1, disposeD1Runtime } from "./local-d1";
import { applyMigrations, loadMigrations, migrationChecksum } from "./migrations";
import { createD1TransferSource, createProtectedImportReceiptPublisher, exportSnapshot } from "./transfer";
import { privateDirectory, writeJson } from "./transfer-artifacts";
import type { SnapshotRow } from "./transfer";
import { headersRecord, ownedUid, pageReply, recordReply, recordValue, type FixedD1TestPage } from "./fixed-job-test-protocol";
import { buildFixedD1JobWorker, createLocalFixedD1JobRunner, createRemoteFixedD1JobRunner, prepareFixedD1Job } from "./fixed-job-host";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sv32-remote-"));
  const source = await createLocalD1();
  let runtime: Miniflare | undefined;
  try {
    await applyMigrations(source.binding, await loadMigrations());
    await source.binding.batch([
      source.binding.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<130) INSERT INTO games (id,steam_app_id,name,hltb_main,value_score,is_owned,tags,created_at,updated_at) SELECT x,10000+x,'遠隔 é '||x,12.5,9.75,NULL,'[ \"City Builder\" ]',1700000000,1700000001 FROM n"),
      source.binding.prepare("INSERT INTO __drizzle_migrations (rowid,id,hash,created_at) VALUES (-3,NULL,'retained ü',12.5),(8,NULL,'retained text','not-a-time')"),
      source.binding.prepare("INSERT INTO games (id,steam_app_id,name) VALUES (950,99999,'Deleted high-water')"),
      source.binding.prepare("DELETE FROM games WHERE id=950"),
    ]);
    const transfer = createD1TransferSource(source.binding, { id: "synthetic-remote-source", freezeRecord: {
      mode: "frozen-writers", sourceId: "synthetic-remote-source", recordId: "native-fixture", frozenAt: 1700000000, evidence: "isolated synthetic fixture",
      writersPaused: ["fixture"], writersDrained: ["fixture"], manualWritersDrained: true, holdsUntilRelease: true,
    } });
    const snapshot = await exportSnapshot(transfer, join(root, "snapshot"), transfer.freezeRecord);
    const capability = "synthetic-remote-run-only-capability";
    const packet = await prepareFixedD1Job(snapshot, join(root, "job"), {
      runId: crypto.randomUUID(), expiresAt: Math.floor(Date.now() / 1000) + 600, targetId: `synthetic-remote-${crypto.randomUUID()}`, intent: "staging", capabilityDigest: await migrationChecksum(capability),
    });
    const artifact = await buildFixedD1JobWorker({ jobDirectory: packet.directory, reviewedJobDigest: packet.digest, destination: join(root, "artifact") });
    const script = await Bun.file(artifact.scriptPath).text();
    const databaseId = crypto.randomUUID();
    runtime = new Miniflare({ modules: true, script, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"], d1Databases: { DB: databaseId }, d1Persist: false, cf: false, host: "127.0.0.1", port: 0 });
    const approvedDeployment = { accountId: "a".repeat(32), databaseId, workerName: "synthetic-fixed-32", endpoint: "https://synthetic-fixed-32.invalid/job", scriptDigest: artifact.scriptDigest, captureDigest: await migrationChecksum("synthetic-control-plane-capture-not-cloud-certification") };
    const record = {
      version: 1, kind: "fixed-d1-deployment", ...approvedDeployment, binding: { name: "DB", databaseId: approvedDeployment.databaseId },
      runId: packet.job.runId, targetId: packet.job.target.id, intent: packet.job.target.intent, expiresAt: packet.job.expiresAt,
      capabilityDigest: packet.job.capabilityDigest, jobDigest: packet.digest, scriptBytes: artifact.scriptBytes,
    };
    const deploymentRecordPath = join(root, "deployment.json");
    await writeJson(deploymentRecordPath, record, true);
    const calls: { request: Request; body: Record<string, unknown> }[] = [];
    const owned = runtime;
    const transport = async (request: Request): Promise<Response> => {
      const body = await request.text();
      calls.push({ request, body: JSON.parse(body) });
      const worker = await owned.getWorker();
      const response = await worker.fetch(request.url, { method: request.method, headers: headersRecord(request.headers), body, redirect: request.redirect });
      const reader = response.body?.getReader();
      return new Response(reader ? new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await reader.read();
          if (next.done) { reader.releaseLock(); controller.close(); }
          else controller.enqueue(next.value);
        },
        async cancel() { try { await reader.cancel(); } finally { reader.releaseLock(); } },
      }) : null, { status: response.status, headers: Object.fromEntries(response.headers) });
    };
    const options = { jobDirectory: packet.directory, reviewedJobDigest: packet.digest, snapshot, receiptPath: join(root, "import.json"), capability,
      deploymentRecordPath, reviewedDeploymentDigest: await migrationChecksum(JSON.stringify(record)), approvedDeployment, workerArtifactPath: artifact.scriptPath, transport };
    return { root, packet, artifact, options, record, calls, transport, runtime: owned, async dispose() { await disposeD1Runtime(owned); await source.dispose(); await rm(root, { recursive: true }); } };
  } catch (error) {
    if (runtime) await disposeD1Runtime(runtime);
    await source.dispose();
    await rm(root, { recursive: true });
    throw error;
  }
}

test("remote host imports through actual bundled native Worker with only the fixed capability and complete 64-row typed pages", async () => {
  const f = await fixture();
  try {
    const runner = await createRemoteFixedD1JobRunner(f.options);
    try {
      const receipt = await runner.run();
      expect(receipt).toMatchObject({ status: "imported", phase: "complete", writeOutcome: "imported", confirmedRows: { games: 130, __drizzle_migrations: 2 } });
      expect(await Bun.file(f.options.receiptPath).json()).toEqual(receipt);
      const ids: number[] = [];
      let cursor: number | null = null;
      for (;;) {
        const page: FixedD1TestPage = await pageReply(await runner.read({ op: "page", table: "games", cursor }));
        expect(page.rows.length).toBeLessThanOrEqual(64);
        for (const row of page.rows) {
          ids.push(row.rowid);
          expect([row.values[2], row.values[6], row.values[15], row.values[28]]).toEqual([["text", `遠隔 é ${row.rowid}`], ["real", 12.5], ["null", null], ["text", '[ "City Builder" ]']]);
        }
        if (page.complete) break;
        cursor = page.cursor;
      }
      expect(ids).toEqual(Array.from({ length: 130 }, (_, i) => i + 1));
      expect(await (await runner.read({ op: "validate" })).json()).toMatchObject({ status: "data-verified", tables: f.packet.job.tables, sequence: [{ name: "games", seq: 950 }] });
      for (const call of f.calls) {
        expect(call.request.url).toBe(f.options.approvedDeployment.endpoint);
        expect(call.request.redirect).toBe("error");
        expect(headersRecord(call.request.headers)).toEqual({ authorization: `Bearer ${f.options.capability}`, "content-type": "application/json" });
      }
      expect(await runner.cancel()).toEqual({ status: "cancelled", resourceOutcome: "retained" });
      expect(await Bun.file(f.options.receiptPath).json()).toEqual(receipt);
    } finally { await runner.dispose(); }
  } finally { await f.dispose(); }
}, 15000);

function envelope(f: Awaited<ReturnType<typeof fixture>>, op: string, extra = {}) {
  return { version: 1, runId: f.packet.job.runId, targetId: f.packet.job.target.id, intent: f.packet.job.target.intent, snapshotDigest: f.packet.job.snapshotDigest, op, ...extra };
}

async function direct(f: Awaited<ReturnType<typeof fixture>>, op: string, extra = {}, capability = f.options.capability) {
  return f.transport(new Request(f.options.approvedDeployment.endpoint, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/json" }, body: JSON.stringify(envelope(f, op, extra)) }));
}

test("dedicated artifact builds reproducibly from only the job manifest and immutable migrations", async () => {
  const f = await fixture();
  try {
    const manifestOnly = join(f.root, "manifest-only");
    await privateDirectory(manifestOnly, true);
    await writeJson(join(manifestOnly, "job.json"), f.packet.job, true);
    const other = await buildFixedD1JobWorker({ jobDirectory: manifestOnly, reviewedJobDigest: f.packet.digest, destination: join(f.root, "rebuilt") });
    expect([other.scriptDigest, other.scriptBytes]).toEqual([f.artifact.scriptDigest, f.artifact.scriptBytes]);
    const script = await Bun.file(other.scriptPath).text();
    for (const forbidden of ["遠隔", "retained ü", f.options.capability, "Bun", "node:fs", "node:path", "Miniflare", "CF-Access-Client", "STEAM_VALUE_DB_TOKEN"]) expect(script.includes(forbidden)).toBe(false);
    for (const path of [other.scriptPath, join(other.directory, "artifact.json"), join(other.directory, "worker-entry.ts")]) {
      const info = await stat(path);
      expect([info.mode & 0o777, info.uid, info.nlink]).toEqual([0o600, ownedUid(), 1]);
    }
  } finally { await f.dispose(); }
}, 15000);

test.each(["account", "database", "name", "endpoint", "http", "query", "credentials", "capture", "script", "reviewed-job", "reviewed-deployment", "capability", "snapshot", "expiry"] as const)("remote preflight refuses %s binding before receipt creation or native dispatch", async (fault) => {
  const f = await fixture();
  try {
    const options = { ...f.options, approvedDeployment: { ...f.options.approvedDeployment } };
    if (fault === "account") options.approvedDeployment.accountId = "b".repeat(32);
    if (fault === "database") options.approvedDeployment.databaseId = crypto.randomUUID();
    if (fault === "name") options.approvedDeployment.workerName = "another-worker";
    if (fault === "endpoint") options.approvedDeployment.endpoint = "https://another.invalid/job";
    if (fault === "http") options.approvedDeployment.endpoint = "http://synthetic-fixed-32.invalid/job";
    if (fault === "query") options.approvedDeployment.endpoint += "?database=other";
    if (fault === "credentials") options.approvedDeployment.endpoint = "https://user:password@synthetic-fixed-32.invalid/job";
    if (fault === "capture") options.approvedDeployment.captureDigest = "0".repeat(64);
    if (fault === "script") options.approvedDeployment.scriptDigest = "0".repeat(64);
    if (fault === "reviewed-job") options.reviewedJobDigest = "0".repeat(64);
    if (fault === "reviewed-deployment") options.reviewedDeploymentDigest = "0".repeat(64);
    if (fault === "capability") options.capability = "synthetic-viewer-not-a-run-capability";
    if (fault === "snapshot") options.snapshot = { ...options.snapshot, directory: join(f.root, "not-the-original") };
    if (fault === "expiry") {
      const expired = { ...f.packet.job, expiresAt: 1700000000 };
      await writeJson(join(f.packet.directory, "job.json"), expired);
      options.reviewedJobDigest = await migrationChecksum(JSON.stringify(expired));
    }
    await expect(createRemoteFixedD1JobRunner(options)).rejects.toMatchObject({ code: fault === "snapshot" ? "ARTIFACT_UNSAFE" : "ARTIFACT_INVALID" });
    expect(f.calls).toHaveLength(0);
    expect(await stat(options.receiptPath).catch(() => undefined)).toBeUndefined();
    expect(await recordReply(await direct(f, "inventory"))).toEqual({ ok: true, state: "uninitialized" });
  } finally { await f.dispose(); }
}, 15000);

test.each(["record-mode", "record-link", "record-symlink", "artifact-bytes", "artifact-mode", "group-resigned"] as const)("remote preflight retains and refuses unsafe or changed %s originals", async (fault) => {
  const f = await fixture();
  try {
    const options = { ...f.options };
    if (fault === "record-mode" || fault === "artifact-mode") {
      const path = join(f.root, "unsafe-input");
      const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o644);
      try { await file.writeFile(fault === "record-mode" ? JSON.stringify(f.record) : await Bun.file(f.artifact.scriptPath).text()); } finally { await file.close(); }
      if (fault === "record-mode") options.deploymentRecordPath = path;
      else options.workerArtifactPath = path;
    }
    if (fault === "record-link") await link(options.deploymentRecordPath, join(f.root, "record-alias"));
    if (fault === "record-symlink") {
      const path = join(f.root, "symlink-record");
      await symlink(options.deploymentRecordPath, path);
      options.deploymentRecordPath = path;
    }
    if (fault === "artifact-bytes") {
      const path = join(f.root, "changed-script");
      const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
      try { await file.writeFile((await Bun.file(f.artifact.scriptPath).text()).replace("no-store", "no-cache")); } finally { await file.close(); }
      options.workerArtifactPath = path;
    }
    if (fault === "group-resigned") {
      const path = join(f.packet.directory, "0.json");
      const group = await Bun.file(path).json();
      group.rows[0].values[1][1] = "not the original snapshot";
      await writeJson(path, group);
      const job = structuredClone(f.packet.job);
      job.groups[0]!.digest = await migrationChecksum(JSON.stringify(group));
      await writeJson(join(f.packet.directory, "job.json"), job);
      options.reviewedJobDigest = await migrationChecksum(JSON.stringify(job));
    }
    await expect(createRemoteFixedD1JobRunner(options)).rejects.toMatchObject({ code: ["artifact-bytes", "group-resigned"].includes(fault) ? "ARTIFACT_INVALID" : "ARTIFACT_UNSAFE" });
    expect(f.calls).toHaveLength(0);
    expect(await stat(options.receiptPath).catch(() => undefined)).toBeUndefined();
    if (fault.endsWith("mode")) expect((await stat(join(f.root, "unsafe-input"))).mode & 0o777).toBe(0o644);
    if (fault === "record-link") expect((await stat(options.deploymentRecordPath)).nlink).toBe(2);
  } finally { await f.dispose(); }
}, 15000);

test("actual bundled HTTP rejects viewer authorization, changed identity and replay with native transactional rollback", async () => {
  const f = await fixture();
  try {
    expect((await direct(f, "bootstrap", {}, "synthetic-viewer")).status).toBe(401);
    expect((await direct(f, "bootstrap", { targetId: "wrong" })).status).toBe(400);
    expect((await direct(f, "bootstrap", { sql: "DELETE FROM games" })).status).toBe(400);
    expect((await direct(f, "bootstrap")).status).toBe(200);
    const group = await Bun.file(join(f.packet.directory, "0.json")).json();
    expect((await direct(f, "rows", { group })).status).toBe(200);
    const replay = await direct(f, "rows", { group });
    expect(replay.status).toBe(409);
    expect(await recordReply(replay)).toEqual({ ok: false, code: "ORDER_REFUSED", outcome: "rolled-back" });
    expect(await (await direct(f, "page", { table: "__drizzle_migrations", cursor: null })).json()).toMatchObject({ rows: [
      { rowid: -3, values: [["null", null], ["text", "retained ü"], ["real", 12.5]] },
      { rowid: 8, values: [["null", null], ["text", "retained text"], ["text", "not-a-time"]] },
    ], complete: true });
  } finally { await f.dispose(); }
}, 15000);

test.each(["rows", "sequence", "redirect"] as const)("real remote %s commit without trustworthy acknowledgement stops without replay and requires a fresh target", async (fault) => {
  const f = await fixture();
  let runner: Awaited<ReturnType<typeof createRemoteFixedD1JobRunner>> | undefined;
  try {
    const transport = async (request: Request) => {
      const body = recordValue(await request.clone().json());
      const response = await f.transport(request);
      if ((fault === "rows" && body.op === "rows") || (fault === "sequence" && body.op === "sequence") || (fault === "redirect" && body.op === "bootstrap")) {
        await response.arrayBuffer();
        if (fault === "redirect") return new Response(null, { status: 302, headers: { Location: "https://unapproved.invalid/job" } });
        throw new Error("synthetic SQL provider capability diagnostics must not escape");
      }
      return response;
    };
    runner = await createRemoteFixedD1JobRunner({ ...f.options, transport });
    await expect(runner.run()).rejects.toMatchObject({ code: "TRANSFER_FAILED" });
    const receipt = await Bun.file(f.options.receiptPath).json();
    expect(receipt).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: "partial-or-unknown", confirmedRows: { __drizzle_migrations: fault === "sequence" ? 2 : 0 } });
    expect(JSON.stringify(receipt)).not.toContain("provider capability");
    const count = f.calls.length;
    await expect(runner.run()).rejects.toMatchObject({ code: "TRANSFER_FAILED" });
    expect(f.calls).toHaveLength(count);
    const repeated = await createRemoteFixedD1JobRunner({ ...f.options, receiptPath: join(f.root, "no-reopen.json") });
    try { await expect(repeated.run()).rejects.toMatchObject({ code: "ARTIFACT_UNSAFE" }); } finally { await repeated.dispose(); }
    expect(f.calls).toHaveLength(count);
    expect(await (await runner.read({ op: "inventory" })).json()).toMatchObject({ ok: true, state: "prepared" });
    if (fault !== "redirect") expect(await (await runner.read({ op: "page", table: "__drizzle_migrations", cursor: null })).json()).toMatchObject({ rows: [
      { rowid: -3, values: [["null", null], ["text", "retained ü"], ["real", 12.5]] },
      { rowid: 8, values: [["null", null], ["text", "retained text"], ["text", "not-a-time"]] },
    ] });
    const fresh = await fixture();
    try {
      expect(fresh.packet.job.target.id).not.toBe(f.packet.job.target.id);
      expect(fresh.record.databaseId).not.toBe(f.record.databaseId);
      const recovery = await createRemoteFixedD1JobRunner(fresh.options);
      try { expect(await recovery.run()).toMatchObject({ status: "imported", confirmedRows: { games: 130 } }); } finally { await recovery.dispose(); }
    } finally { await fresh.dispose(); }
    expect(await Bun.file(f.options.receiptPath).json()).toEqual(receipt);
  } finally { await runner?.dispose(); await f.dispose(); }
}, 15000);

test("remote cancellation fences new dispatch and drains actual native acknowledgement plus an in-flight response stream", async () => {
  const f = await fixture();
  const committed = Promise.withResolvers<void>();
  const acknowledge = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  const readRelease = Promise.withResolvers<void>();
  let gate = false;
  const runner = await createRemoteFixedD1JobRunner({ ...f.options,
    async transport(request) {
      const operation = recordValue(await request.clone().json());
      const response = await f.transport(request);
      if (!gate || operation.op !== "page" || !response.body) return response;
      const reader = response.body.getReader();
      return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
        reading.resolve();
        await readRelease.promise;
        const chunk = await reader.read();
        if (chunk.done) { reader.releaseLock(); controller.close(); } else controller.enqueue(chunk.value);
      }, async cancel() { try { await reader.cancel(); } finally { reader.releaseLock(); } } }), { headers: response.headers });
    },
    async acknowledge(ack) { if (ack.op === "rows" && ack.index === 0) { committed.resolve(); await acknowledge.promise; } },
  });
  const result = runner.run();
  const settled = result.catch(() => {});
  let read: Promise<Response> | undefined;
  try {
    await committed.promise;
    gate = true;
    read = runner.read({ op: "page", table: "__drizzle_migrations", cursor: null });
    await reading.promise;
    let closed = false;
    const cancellation = runner.cancel().then((value) => { closed = true; return value; });
    await expect(runner.read({ op: "inventory" })).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
    expect(closed).toBe(false);
    acknowledge.resolve();
    await expect(result).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
    expect(closed).toBe(false);
    readRelease.resolve();
    expect(await (await read).json()).toMatchObject({ rows: [{ rowid: -3 }, { rowid: 8 }], complete: true });
    expect(await cancellation).toEqual({ status: "cancelled", resourceOutcome: "retained" });
    expect(await Bun.file(f.options.receiptPath).json()).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: "partial-or-unknown", confirmedRows: { __drizzle_migrations: 0 } });
    expect(await (await direct(f, "inventory")).json()).toMatchObject({ state: "prepared" });
  } finally { acknowledge.resolve(); readRelease.resolve(); await settled; await read?.catch(() => {}); await runner.dispose(); await f.dispose(); }
}, 15000);

test.each(["preflight", "complete"] as const)("remote cancellation at actual durable %s publication cannot acknowledge imported success", async (phase) => {
  const f = await fixture();
  const published = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const real = createProtectedImportReceiptPublisher(f.options.receiptPath);
  const runner = await createRemoteFixedD1JobRunner({ ...f.options, receiptPublisher: { async publish(value, create) {
    await real.publish(value, create);
    if ((phase === "preflight" && create) || (phase === "complete" && value.status === "imported")) {
      expect(await Bun.file(f.options.receiptPath).json()).toEqual(value);
      published.resolve();
      await release.promise;
    }
  } } });
  const result = runner.run();
  const settled = result.catch(() => {});
  try {
    await published.promise;
    const cancellation = runner.cancel();
    release.resolve();
    await expect(result).rejects.toMatchObject({ code: "INCOMPLETE_IMPORT" });
    expect(await cancellation).toEqual({ status: "cancelled", resourceOutcome: "retained" });
    expect(await Bun.file(f.options.receiptPath).json()).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: phase === "preflight" ? "not-started" : "partial-or-unknown" });
    if (phase === "preflight") expect(f.calls).toHaveLength(0);
  } finally { release.resolve(); await settled; await runner.dispose(); await f.dispose(); }
}, 15000);

test.each(["misdirected", "stale"] as const)("remote publication requires equality of the actual selected protected receipt, fault=%s", async (fault) => {
  const f = await fixture();
  const real = createProtectedImportReceiptPublisher(fault === "misdirected" ? join(f.root, "other.json") : f.options.receiptPath);
  const runner = await createRemoteFixedD1JobRunner({ ...f.options, receiptPublisher: { async publish(value, create) {
    if (fault === "stale" && value.status === "imported") return;
    await real.publish(value, create);
  } } });
  try {
    await expect(runner.run()).rejects.toMatchObject({ code: fault === "misdirected" ? "ARTIFACT_UNSAFE" : "ARTIFACT_INVALID" });
    if (fault === "misdirected") expect(f.calls).toHaveLength(0);
    else expect(await Bun.file(f.options.receiptPath).json()).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: "partial-or-unknown" });
  } finally { await runner.dispose(); await f.dispose(); }
}, 15000);

test("independent remote factories compete through an exclusive protected attempt rather than memory-only exclusion", async () => {
  const f = await fixture();
  const first = await createRemoteFixedD1JobRunner(f.options);
  const second = await createRemoteFixedD1JobRunner({ ...f.options, receiptPath: join(f.root, "second.json") });
  try {
    const results = await Promise.allSettled([first.run(), second.run()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure).toMatchObject({ status: "rejected", reason: { code: "ARTIFACT_UNSAFE" } });
    expect(f.calls.filter((call) => call.body.op === "bootstrap")).toHaveLength(1);
    expect((await stat(join(f.packet.directory, "attempt.json"))).mode & 0o777).toBe(0o600);
  } finally { await first.dispose(); await second.dispose(); await f.dispose(); }
}, 15000);

test("remote response byte pressure cancels and drains the real stream without exposing provider diagnostics", async () => {
  const f = await fixture();
  let cancelled = false;
  let chunks = 0;
  const runner = await createRemoteFixedD1JobRunner({ ...f.options, async transport(request) {
    const actual = await f.transport(request);
    await actual.arrayBuffer();
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(1048576).fill(32)); },
      async cancel() { cancelled = true; },
    }), { headers: { "Content-Type": "application/json" } });
  } });
  try {
    await expect(runner.run()).rejects.toMatchObject({ code: "TRANSFER_FAILED" });
    expect(cancelled).toBe(true);
    expect(chunks).toBeLessThanOrEqual(11);
    expect(await Bun.file(f.options.receiptPath).json()).toMatchObject({ status: "incomplete", writeOutcome: "partial-or-unknown" });
    expect(f.calls).toHaveLength(1);
    expect(await (await direct(f, "inventory")).json()).toMatchObject({ state: "prepared" });
  } finally { await runner.dispose(); await f.dispose(); }
}, 15000);

test("a synthetic constraint fault through the actual dedicated artifact HTTP rolls back earlier native data statements", async () => {
  const f = await fixture();
  let runtime: Miniflare | undefined;
  try {
    const rows: SnapshotRow[] = Array.from({ length: 26 }, (_, index) => ({ rowid: index + 1, values: [["null", null], ["text", "synthetic valid ledger"], ["integer", 1700000000]] }));
    rows[25]!.values[1] = ["null", null];
    const group = { index: 0, table: "__drizzle_migrations", rows };
    const job = { ...f.packet.job, tables: f.packet.job.tables.map((table) => ({ ...table, rowCount: table.name === group.table ? 26 : 0 })), sequence: [],
      groups: [{ index: 0, table: group.table, rowCount: 26, lastRowid: 26, digest: await migrationChecksum(JSON.stringify(group)) }] };
    const directory = await privateDirectory(join(f.root, "constraint-manifest"), true);
    await writeJson(join(directory, "job.json"), job, true);
    const artifact = await buildFixedD1JobWorker({ jobDirectory: directory, reviewedJobDigest: await migrationChecksum(JSON.stringify(job)), destination: join(f.root, "constraint-artifact") });
    runtime = new Miniflare({ modules: true, script: await Bun.file(artifact.scriptPath).text(), compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"], d1Persist: false, cf: false, host: "127.0.0.1", port: 0 });
    const worker = await runtime.getWorker();
    const send = async (op: string, extra = {}) => {
      const response = await worker.fetch(f.options.approvedDeployment.endpoint, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${f.options.capability}`, "Content-Type": "application/json" }, body: JSON.stringify(envelope(f, op, extra)) });
      return new Response(await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) });
    };
    expect((await send("bootstrap")).status).toBe(200);
    const response = await send("rows", { group });
    expect(response.status).toBe(422);
    expect(await recordReply(response)).toEqual({ ok: false, code: "GROUP_ROLLED_BACK", outcome: "rolled-back" });
    expect(await pageReply(await send("page", { table: group.table, cursor: null }))).toEqual({ ok: true, columns: ["rowid", "id", "hash", "created_at"], rows: [], cursor: null, complete: true });
  } finally { if (runtime) await disposeD1Runtime(runtime); await f.dispose(); }
}, 15000);

test.each(["columns", "typed-value", "cursor", "complete"] as const)("remote read rejects a corrupted actual native page, field=%s", async (fault) => {
  const f = await fixture();
  const runner = await createRemoteFixedD1JobRunner({ ...f.options, async transport(request) {
    const operation = recordValue(await request.clone().json());
    const response = await f.transport(request);
    if (operation.op !== "page") return response;
    const page = await pageReply(response);
    const value = fault === "columns" ? { ...page, columns: [] }
      : fault === "typed-value" ? { ...page, rows: [{ rowid: 1, values: [["integer", "not-numeric"]] }] }
      : fault === "cursor" ? { ...page, cursor: 900000 }
      : { ...page, complete: "yes" };
    return Response.json(value);
  } });
  try {
    const receipt = await runner.run();
    await expect(runner.read({ op: "page", table: "games", cursor: null })).rejects.toMatchObject({ code: "TRANSFER_FAILED" });
    expect(await Bun.file(f.options.receiptPath).json()).toEqual(receipt);
  } finally { await runner.dispose(); await f.dispose(); }
}, 15000);

test("the unchanged local factory needs no remote deployment record and keeps its native disposal acknowledgement", async () => {
  const f = await fixture();
  const receiptPath = join(f.root, "local.json");
  const persistTo = join(f.root, "local-target");
  const runner = await createLocalFixedD1JobRunner({ jobDirectory: f.packet.directory, reviewedJobDigest: f.packet.digest, snapshot: f.options.snapshot, capability: f.options.capability, receiptPath, persistTo });
  try {
    expect(await runner.run()).toMatchObject({ status: "imported", confirmedRows: { games: 130, __drizzle_migrations: 2 } });
    expect(await recordReply(await runner.read({ op: "validate" }))).toMatchObject({ status: "data-verified", tables: f.packet.job.tables, sequence: [{ name: "games", seq: 950 }] });
    expect(await runner.cancel()).toEqual({ status: "cancelled", nativeDisposed: true });
    expect(f.calls).toHaveLength(0);
    expect((await stat(persistTo)).mode & 0o777).toBe(0o700);
  } finally { await runner.dispose(); await f.dispose(); }
}, 15000);

test("remote deployment record replacement after preflight cannot authorize a later write", async () => {
  const f = await fixture();
  const runner = await createRemoteFixedD1JobRunner(f.options);
  try {
    await writeJson(f.options.deploymentRecordPath, { ...f.record, accountId: "b".repeat(32) });
    await expect(runner.run()).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    expect(f.calls).toHaveLength(0);
    expect(await Bun.file(f.options.receiptPath).json()).toMatchObject({ status: "incomplete", phase: "failed", writeOutcome: "not-started" });
  } finally { await runner.dispose(); await f.dispose(); }
}, 15000);
