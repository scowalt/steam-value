import { join } from "node:path";
import { Miniflare } from "miniflare";
import { byteLength, DB_LIMITS, exactKeys, isRecord, isRequestId, readBoundedJson } from "./access";
import { migrationChecksum } from "./migrations-native";
import { loadMigrations } from "./migrations";
import { collectReleasedD1Owners, disposeD1Runtime } from "./local-d1";
import { artifactRows, createProtectedImportReceiptPublisher, reviewedSchema, verifyArtifact, type ImportReceipt, type ImportReceiptPublisher, type Snapshot } from "./transfer";
import { createGuardedImportReceiptPublication, privateDirectory, privateFile, readJson, writeJson } from "./transfer-artifacts";
import { TransferError } from "./transfer-error";
import { packTransferRows, TRANSFER_LIMITS } from "./transfer-native";
import { authenticateFixedD1Capability, validateFixedD1Job, type FixedD1Group, type FixedD1Job } from "./fixed-job-worker";

export interface FixedD1JobOptions {
  runId: string;
  expiresAt: number;
  targetId: string;
  intent: "empty" | "staging";
  capabilityDigest: string;
}

export interface PreparedFixedD1Job {
  directory: string;
  job: FixedD1Job;
  digest: string;
}

export async function prepareFixedD1Job(input: Snapshot | string, destination: string, options: FixedD1JobOptions): Promise<PreparedFixedD1Job> {
  const now = Math.floor(Date.now() / 1000);
  if (!isRequestId(options.runId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(options.targetId) || !["empty", "staging"].includes(options.intent) ||
    !/^[a-f0-9]{64}$/.test(options.capabilityDigest) || !Number.isSafeInteger(options.expiresAt) || options.expiresAt <= now || options.expiresAt > now + 3600) throw new TransferError("ARTIFACT_INVALID");
  const snapshot = await verifyArtifact(input);
  const reviewed = await reviewedSchema();
  const directory = await privateDirectory(destination, true);
  const job: FixedD1Job = {
    version: 1, runId: options.runId, expiresAt: options.expiresAt,
    target: { id: options.targetId, binding: "DB", intent: options.intent }, capabilityDigest: options.capabilityDigest,
    snapshotId: snapshot.manifest.snapshotId, snapshotDigest: await migrationChecksum(JSON.stringify(snapshot.manifest)),
    sourceSchemaFingerprint: snapshot.manifest.schemaFingerprint, sourceProfile: snapshot.manifest.schemaCompatibility.profile,
    targetSchemaFingerprint: snapshot.manifest.schemaCompatibility.targetSchemaFingerprint,
    schemaObjectsDigest: await migrationChecksum(JSON.stringify(reviewed.schema.objects)),
    excludedMetadataDigest: await migrationChecksum(JSON.stringify(reviewed.excluded)), ledgerDigest: await migrationChecksum(JSON.stringify(reviewed.ledger)),
    migrationFingerprint: snapshot.manifest.migrationFingerprint, migrations: reviewed.history,
    tables: snapshot.manifest.tables, sequence: snapshot.manifest.sequence, groups: [],
  };
  for (const table of reviewed.schema.tables) {
    for await (const group of packTransferRows(table, artifactRows(snapshot, table), true)) {
      const payload: FixedD1Group = { index: job.groups.length, table: table.name, rows: group.rows };
      job.groups.push({ index: payload.index, table: table.name, rowCount: group.rows.length, lastRowid: group.rows.at(-1)!.rowid, digest: await migrationChecksum(JSON.stringify(payload)) });
      await writeJson(join(directory, `${payload.index}.json`), payload, true);
    }
  }
  if (byteLength(JSON.stringify(job)) > TRANSFER_LIMITS.maxManifestBytes) throw new TransferError("ARTIFACT_INVALID");
  await writeJson(join(directory, "job.json"), job, true);
  return { directory, job, digest: await migrationChecksum(JSON.stringify(job)) };
}

async function readGroup(directory: string, index: number): Promise<unknown> {
  const file = await privateFile(join(directory, `${index}.json`));
  try {
    if ((await file.stat()).size > DB_LIMITS.maxRequestBytes - 4096) throw new TransferError("ARTIFACT_INVALID");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.readFile());
    const value: unknown = JSON.parse(text);
    if (JSON.stringify(value) + "\n" !== text) throw new TransferError("ARTIFACT_INVALID");
    return value;
  } catch (error) { throw error instanceof TransferError ? error : new TransferError("ARTIFACT_INVALID"); }
  finally { await file.close(); }
}

async function loadReviewedJob(directory: string, expectedDigest: string, input: Snapshot | string, capability: string) {
  await privateDirectory(directory);
  const value = await readJson(join(directory, "job.json"));
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) || await migrationChecksum(JSON.stringify(value)) !== expectedDigest) throw new TransferError("ARTIFACT_INVALID");
  if (!isRecord(value) || typeof value.capabilityDigest !== "string" || typeof capability !== "string" || !await authenticateFixedD1Capability(value.capabilityDigest, capability)) throw new TransferError("ARTIFACT_INVALID");
  const job = value as unknown as FixedD1Job;
  const migrations = await loadMigrations();
  try { await validateFixedD1Job(job, migrations); }
  catch { throw new TransferError("ARTIFACT_INVALID"); }
  const snapshot = await verifyArtifact(input);
  const reviewed = await reviewedSchema();
  if (job.snapshotId !== snapshot.manifest.snapshotId || job.snapshotDigest !== await migrationChecksum(JSON.stringify(snapshot.manifest)) ||
    job.sourceSchemaFingerprint !== snapshot.manifest.schemaFingerprint || job.sourceProfile !== snapshot.manifest.schemaCompatibility.profile ||
    job.targetSchemaFingerprint !== snapshot.manifest.schemaCompatibility.targetSchemaFingerprint ||
    job.schemaObjectsDigest !== await migrationChecksum(JSON.stringify(reviewed.schema.objects)) || job.excludedMetadataDigest !== await migrationChecksum(JSON.stringify(reviewed.excluded)) || job.ledgerDigest !== await migrationChecksum(JSON.stringify(reviewed.ledger)) ||
    JSON.stringify(job.tables) !== JSON.stringify(snapshot.manifest.tables) || JSON.stringify(job.sequence) !== JSON.stringify(snapshot.manifest.sequence)) throw new TransferError("ARTIFACT_INVALID");
  let index = 0;
  for (const table of reviewed.schema.tables) {
    for await (const group of packTransferRows(table, artifactRows(snapshot, table), true)) {
      const payload = { index, table: table.name, rows: group.rows };
      const fixed = job.groups[index];
      if (!fixed || fixed.index !== index || fixed.table !== table.name || fixed.rowCount !== group.rows.length || fixed.lastRowid !== group.rows.at(-1)!.rowid || fixed.digest !== await migrationChecksum(JSON.stringify(payload)) || JSON.stringify(await readGroup(directory, index)) !== JSON.stringify(payload)) throw new TransferError("ARTIFACT_INVALID");
      index++;
    }
  }
  if (index !== job.groups.length || Math.floor(Date.now() / 1000) >= job.expiresAt) throw new TransferError("ARTIFACT_INVALID");
  return { job, migrations };
}

async function buildJob(directory: string, job: FixedD1Job, migrations: Awaited<ReturnType<typeof loadMigrations>>) {
  const entry = join(directory, "worker-entry.ts");
  const file = await privateFile(entry, true);
  try {
    await file.writeFile(`import { createFixedD1JobWorker } from ${JSON.stringify(new URL("./fixed-job-worker.ts", import.meta.url).pathname)}; export default createFixedD1JobWorker(${JSON.stringify(job)},${JSON.stringify(migrations)});`);
    await file.sync();
  } finally { await file.close(); }
  const checked = await privateFile(entry);
  await checked.close();
  const result = await Bun.build({ entrypoints: [entry], target: "browser", minify: true, plugins: [{
    name: "native-worker-crypto", setup(build) {
      build.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: "node:crypto", external: true }));
    },
  }] });
  if (!result.success || result.outputs.length !== 1 || !result.outputs[0]) throw new TransferError("TRANSFER_FAILED");
  const script = await result.outputs[0].text();
  if (/\bBun\b|node:fs|node:path|cryptoBrowserify|crypto-browserify/.test(script)) throw new TransferError("TRANSFER_FAILED");
  const output = await privateFile(join(directory, "worker.js"), true);
  try { await output.writeFile(script); await output.sync(); } finally { await output.close(); }
  return script;
}

export interface LocalFixedD1JobOptions {
  jobDirectory: string;
  reviewedJobDigest: string;
  snapshot: Snapshot | string;
  persistTo: string;
  receiptPath: string;
  capability: string;
  acknowledge?: (acknowledgement: { op: string; index?: number; result: unknown }) => Promise<void>;
  receiptPublisher?: ImportReceiptPublisher;
}

export type FixedD1Read = { op: "inventory" | "validate" } | { op: "page"; table: string; cursor: number | null };

export async function createLocalFixedD1JobRunner(options: LocalFixedD1JobOptions) {
  const { job, migrations } = await loadReviewedJob(options.jobDirectory, options.reviewedJobDigest, options.snapshot, options.capability);
  let runtime: Miniflare | undefined;
  let running: Promise<ImportReceipt> | undefined;
  let disposed = false;
  let closing: Promise<void> | undefined;
  const cancellation = new AbortController();
  const reads = new Set<Promise<Response>>();
  const assertActive = () => { if (cancellation.signal.aborted) throw new TransferError("INCOMPLETE_IMPORT"); };
  const common = { version: 1, runId: job.runId, targetId: job.target.id, intent: job.target.intent, snapshotDigest: job.snapshotDigest };
  const receipt: ImportReceipt = {
    version: 1, kind: "import", targetId: job.target.id, snapshotId: job.snapshotId, manifestDigest: job.snapshotDigest,
    status: "incomplete", phase: "preflight", confirmedRows: Object.fromEntries(job.tables.map((table) => [table.name, 0])), writeOutcome: "not-started",
  };
  const publisher = options.receiptPublisher ?? createProtectedImportReceiptPublisher(options.receiptPath);
  const publish = createGuardedImportReceiptPublication(options.receiptPath, publisher);
  const request = async (operation: Record<string, unknown>): Promise<Response> => {
    if (!runtime || disposed) throw new TransferError("INCOMPLETE_IMPORT");
    const body = JSON.stringify({ ...common, ...operation });
    if (byteLength(body) > DB_LIMITS.maxRequestBytes) throw new TransferError("UNSUPPORTED_DATA");
    const worker = await runtime.getWorker();
    const response = await worker.fetch("https://fixed-job.invalid/job", { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${options.capability}`, "Content-Type": "application/json" }, body });
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > DB_LIMITS.maxResponseBytes) throw new TransferError("TRANSFER_FAILED");
    return new Response(bytes, { status: response.status, headers: Object.fromEntries(response.headers) });
  };
  const send = async (operation: Record<string, unknown>, expected: unknown) => {
    assertActive();
    const response = await request(operation);
    const value = await readBoundedJson(response.body, DB_LIMITS.maxResponseBytes, "RESULT_LIMIT", "PROTOCOL_ERROR");
    if (response.status !== 200 || JSON.stringify(value) !== JSON.stringify(expected)) throw new TransferError("TRANSFER_FAILED");
    await options.acknowledge?.({ op: String(operation.op), ...(isRecord(operation.group) && typeof operation.group.index === "number" ? { index: operation.group.index } : {}), result: structuredClone(value) });
    assertActive();
  };
  const perform = async (): Promise<ImportReceipt> => {
    if (disposed) throw new TransferError("INCOMPLETE_IMPORT");
    await publish(receipt, true);
    try {
      assertActive();
      await writeJson(join(options.jobDirectory, "attempt.json"), { runId: job.runId, jobDigest: options.reviewedJobDigest, receiptPath: options.receiptPath, targetPath: options.persistTo }, true);
      const script = await buildJob(options.jobDirectory, job, migrations);
      assertActive();
      await privateDirectory(options.persistTo, true);
      assertActive();
      collectReleasedD1Owners();
      runtime = new Miniflare({ modules: true, script, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"], d1Persist: join(options.persistTo, "v3", "d1"), cf: false, host: "127.0.0.1", port: 0 });
      receipt.writeOutcome = "partial-or-unknown";
      await publish(receipt);
      await send({ op: "bootstrap" }, { ok: true, state: "prepared", schemaFingerprint: job.targetSchemaFingerprint });
      receipt.phase = "rows";
      for (const group of job.groups) {
        const payload = await readGroup(options.jobDirectory, group.index);
        if (await migrationChecksum(JSON.stringify(payload)) !== group.digest) throw new TransferError("ARTIFACT_INVALID");
        await publish(receipt);
        await send({ op: "rows", group: payload }, { ok: true, index: group.index, rows: group.rowCount, digest: group.digest });
        assertActive();
        receipt.confirmedRows[group.table]! += group.rowCount;
        await publish(receipt);
      }
      receipt.phase = "sequence";
      await publish(receipt);
      const games = job.groups.filter((group) => group.table === "games");
      const generated = games.length ? [{ name: "games", seq: Math.max(0, ...games.map((group) => group.lastRowid)) }] : [];
      await send({ op: "sequence" }, { ok: true, phase: "sequence", changed: JSON.stringify(generated) !== JSON.stringify(job.sequence) });
      await send({ op: "validate" }, { ok: true, status: "data-verified", schemaFingerprint: job.targetSchemaFingerprint, tables: job.tables, sequence: job.sequence });
      assertActive();
      const complete: ImportReceipt = { ...receipt, status: "imported", phase: "complete", writeOutcome: "imported" };
      await publish(complete);
      assertActive();
      return complete;
    } catch (error) {
      receipt.phase = "failed";
      receipt.errorCode = error instanceof TransferError ? error.code : "TRANSFER_FAILED";
      await publish(receipt).catch(() => {});
      throw error instanceof TransferError ? error : new TransferError("TRANSFER_FAILED");
    }
  };
  const close = () => closing ??= (async () => {
    cancellation.abort();
    if (running) await running.catch(() => {});
    disposed = true;
    await Promise.allSettled(reads);
    if (runtime) await disposeD1Runtime(runtime);
  })();
  return {
    run() { return running ??= perform(); },
    async read(operation: FixedD1Read) {
      if (!isRecord(operation) || !["inventory", "validate", "page"].includes(operation.op) || !exactKeys(operation, operation.op === "page" ? ["op", "table", "cursor"] : ["op"])) throw new TransferError("ARTIFACT_INVALID");
      const pending = request(operation);
      reads.add(pending);
      try { return await pending; } finally { reads.delete(pending); }
    },
    async cancel() { await close(); return { status: "cancelled" as const, nativeDisposed: true as const }; },
    dispose: close,
  };
}
