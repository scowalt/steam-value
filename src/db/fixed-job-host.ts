import { join } from "node:path";
import { Miniflare } from "miniflare";
import { byteLength, DB_LIMITS, exactKeys, isRecord, isRequestId, isJsonMediaType, readBoundedJson } from "./access";
import { migrationChecksum } from "./migrations-native";
import { loadMigrations } from "./migrations";
import { collectReleasedD1Owners, disposeD1Runtime } from "./local-d1";
import { artifactRows, createProtectedImportReceiptPublisher, reviewedSchema, verifyArtifact, type ImportReceipt, type ImportReceiptPublisher, type Snapshot } from "./transfer";
import { createGuardedImportReceiptPublication, privateDirectory, privateFile, readJson, writeJson } from "./transfer-artifacts";
import { TransferError } from "./transfer-error";
import { packTransferRows, scalar, TRANSFER_LIMITS } from "./transfer-native";
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

export interface FixedD1WorkerBuildOptions {
  jobDirectory: string;
  reviewedJobDigest: string;
  destination: string;
}

export async function buildFixedD1JobWorker(options: FixedD1WorkerBuildOptions) {
  await privateDirectory(options.jobDirectory);
  const value = await readJson(join(options.jobDirectory, "job.json"));
  if (!/^[a-f0-9]{64}$/.test(options.reviewedJobDigest) || await migrationChecksum(JSON.stringify(value)) !== options.reviewedJobDigest) throw new TransferError("ARTIFACT_INVALID");
  const job = value as FixedD1Job;
  const migrations = await loadMigrations();
  try { await validateFixedD1Job(job, migrations); }
  catch { throw new TransferError("ARTIFACT_INVALID"); }
  const now = Math.floor(Date.now() / 1000);
  if (job.expiresAt <= now || job.expiresAt > now + 3600) throw new TransferError("ARTIFACT_INVALID");
  const directory = await privateDirectory(options.destination, true);
  const script = await buildJob(directory, job, migrations);
  const artifact = { version: 1, jobDigest: options.reviewedJobDigest, scriptDigest: await migrationChecksum(script), scriptBytes: byteLength(script), compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"], binding: "DB" };
  await writeJson(join(directory, "artifact.json"), artifact, true);
  return { ...artifact, directory, scriptPath: join(directory, "worker.js") };
}

export interface ApprovedFixedD1Deployment {
  accountId: string;
  databaseId: string;
  workerName: string;
  endpoint: string;
  scriptDigest: string;
  captureDigest: string;
}

export interface RemoteFixedD1JobOptions extends Omit<LocalFixedD1JobOptions, "persistTo"> {
  deploymentRecordPath: string;
  reviewedDeploymentDigest: string;
  approvedDeployment: ApprovedFixedD1Deployment;
  workerArtifactPath: string;
  transport?: (request: Request) => Promise<Response>;
}

async function checkFixedD1Deployment(options: RemoteFixedD1JobOptions, job: FixedD1Job) {
  const approved = options.approvedDeployment;
  const fields = ["accountId", "databaseId", "workerName", "endpoint", "scriptDigest", "captureDigest"];
  if (!isRecord(approved) || !exactKeys(approved, fields) || Object.keys(approved).length !== fields.length || !/^[a-f0-9]{32}$/.test(approved.accountId) || !isRequestId(approved.databaseId) ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(approved.workerName) || ![approved.scriptDigest, approved.captureDigest, options.reviewedDeploymentDigest].every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) throw new TransferError("ARTIFACT_INVALID");
  let url: URL;
  try { url = new URL(approved.endpoint); } catch { throw new TransferError("ARTIFACT_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port || url.pathname !== "/job" || url.href !== approved.endpoint || !/^[a-z0-9.-]+$/i.test(url.hostname) || url.hostname === "localhost" || /^[0-9.]+$/.test(url.hostname)) throw new TransferError("ARTIFACT_INVALID");
  const value = await readJson(options.deploymentRecordPath);
  const now = Math.floor(Date.now() / 1000);
  if (!isRecord(value) || !exactKeys(value, ["version", "kind", ...fields, "binding", "runId", "targetId", "intent", "expiresAt", "capabilityDigest", "jobDigest", "scriptBytes"]) || Object.keys(value).length !== 16 ||
    await migrationChecksum(JSON.stringify(value)) !== options.reviewedDeploymentDigest || value.version !== 1 || value.kind !== "fixed-d1-deployment" ||
    fields.some((field) => value[field] !== Reflect.get(approved, field)) || JSON.stringify(value.binding) !== JSON.stringify({ name: "DB", databaseId: approved.databaseId }) ||
    value.runId !== job.runId || value.targetId !== job.target.id || value.intent !== job.target.intent || value.expiresAt !== job.expiresAt || job.expiresAt <= now || job.expiresAt > now + 3600 ||
    value.capabilityDigest !== job.capabilityDigest || value.jobDigest !== options.reviewedJobDigest) throw new TransferError("ARTIFACT_INVALID");
  const file = await privateFile(options.workerArtifactPath);
  try {
    const size = (await file.stat()).size;
    if (size > DB_LIMITS.maxRequestBytes || size !== value.scriptBytes) throw new TransferError("ARTIFACT_INVALID");
    const bytes = new Uint8Array(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!chunk.bytesRead) break;
      offset += chunk.bytesRead;
    }
    if (offset !== size) throw new TransferError("ARTIFACT_INVALID");
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.subarray(0, size))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== approved.scriptDigest) throw new TransferError("ARTIFACT_INVALID");
  } finally { await file.close(); }
}

function checkRemoteFixedD1Page(value: Record<string, unknown>, operation: Record<string, unknown>, job: FixedD1Job) {
  const table = job.tables.find((table) => table.name === operation.table);
  if (!table || !exactKeys(value, ["ok", "columns", "rows", "cursor", "complete"]) || Object.keys(value).length !== 5 ||
    JSON.stringify(value.columns) !== JSON.stringify(["rowid", ...table.columns]) || !Array.isArray(value.rows) || value.rows.length > TRANSFER_LIMITS.pageRows || typeof value.complete !== "boolean") throw new TransferError("TRANSFER_FAILED");
  let cursor = operation.cursor;
  for (const row of value.rows) {
    if (!isRecord(row) || !exactKeys(row, ["rowid", "values"]) || Object.keys(row).length !== 2 || typeof row.rowid !== "number" || !Number.isSafeInteger(row.rowid) || Object.is(row.rowid, -0) ||
      (typeof cursor === "number" && row.rowid <= cursor) || !Array.isArray(row.values) || row.values.length !== table.columns.length) throw new TransferError("TRANSFER_FAILED");
    for (const entry of row.values) {
      if (!Array.isArray(entry) || entry.length !== 2 || JSON.stringify(scalar(entry[0], entry[1])) !== JSON.stringify(entry)) throw new TransferError("TRANSFER_FAILED");
    }
    if (byteLength(JSON.stringify(row) + "\n") > TRANSFER_LIMITS.maxRowBytes) throw new TransferError("TRANSFER_FAILED");
    cursor = row.rowid;
  }
  if (value.cursor !== cursor || (!value.rows.length && !value.complete)) throw new TransferError("TRANSFER_FAILED");
}

export async function createRemoteFixedD1JobRunner(options: RemoteFixedD1JobOptions) {
  options = { ...options, approvedDeployment: { ...options.approvedDeployment } };
  const { job } = await loadReviewedJob(options.jobDirectory, options.reviewedJobDigest, options.snapshot, options.capability);
  await checkFixedD1Deployment(options, job);
  const transport = options.transport ?? ((request: Request) => fetch(request));
  return createGuardedFixedD1Runner(options, job, {
    targetPath: options.approvedDeployment.endpoint,
    async open(assertActive) { await checkFixedD1Deployment(options, job); assertActive(); },
    async request(body, assertActive, operation) {
      await checkFixedD1Deployment(options, job);
      assertActive();
      try {
        const response = await transport(new Request(options.approvedDeployment.endpoint, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${options.capability}`, "Content-Type": "application/json" }, body }));
        const value = await readBoundedJson(response.body, DB_LIMITS.maxResponseBytes, "RESULT_LIMIT", "PROTOCOL_ERROR");
        if (response.status !== 200 || response.redirected || (response.url && response.url !== options.approvedDeployment.endpoint) || !isJsonMediaType(response.headers.get("Content-Type")) || !isRecord(value) || value.ok !== true) throw new TransferError("TRANSFER_FAILED");
        if (operation.op === "page") checkRemoteFixedD1Page(value, operation, job);
        return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      } catch { throw new TransferError("TRANSFER_FAILED"); }
    },
    async close() {},
  }, { status: "cancelled" as const, resourceOutcome: "retained" as const });
}

export type FixedD1Read = { op: "inventory" | "validate" } | { op: "page"; table: string; cursor: number | null };

export async function createLocalFixedD1JobRunner(options: LocalFixedD1JobOptions) {
  const { job, migrations } = await loadReviewedJob(options.jobDirectory, options.reviewedJobDigest, options.snapshot, options.capability);
  let runtime: Miniflare | undefined;
  return createGuardedFixedD1Runner(options, job, {
    targetPath: options.persistTo,
    async open(assertActive) {
      const script = await buildJob(options.jobDirectory, job, migrations);
      assertActive();
      await privateDirectory(options.persistTo, true);
      assertActive();
      collectReleasedD1Owners();
      runtime = new Miniflare({ modules: true, script, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"], d1Persist: join(options.persistTo, "v3", "d1"), cf: false, host: "127.0.0.1", port: 0 });
    },
    async request(body, assertActive) {
      if (!runtime) throw new TransferError("INCOMPLETE_IMPORT");
      const worker = await runtime.getWorker();
      assertActive();
      const response = await worker.fetch("https://fixed-job.invalid/job", { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${options.capability}`, "Content-Type": "application/json" }, body });
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > DB_LIMITS.maxResponseBytes) throw new TransferError("TRANSFER_FAILED");
      return new Response(bytes, { status: response.status, headers: Object.fromEntries(response.headers) });
    },
    async close() { if (runtime) await disposeD1Runtime(runtime); },
  }, { status: "cancelled" as const, nativeDisposed: true as const });
}

type FixedD1RunnerOptions = Omit<LocalFixedD1JobOptions, "persistTo">;
interface FixedD1RunnerDriver {
  targetPath: string;
  open(assertActive: () => void): Promise<void>;
  request(body: string, assertActive: () => void, operation: Record<string, unknown>): Promise<Response>;
  close(): Promise<void>;
}

function createGuardedFixedD1Runner<A>(options: FixedD1RunnerOptions, job: FixedD1Job, driver: FixedD1RunnerDriver, cancellationAcknowledgement: A) {
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
    assertActive();
    if (disposed) throw new TransferError("INCOMPLETE_IMPORT");
    const body = JSON.stringify({ ...common, ...operation });
    if (byteLength(body) > DB_LIMITS.maxRequestBytes) throw new TransferError("UNSUPPORTED_DATA");
    return driver.request(body, assertActive, operation);
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
      await writeJson(join(options.jobDirectory, "attempt.json"), { runId: job.runId, jobDigest: options.reviewedJobDigest, receiptPath: options.receiptPath, targetPath: driver.targetPath }, true);
      await driver.open(assertActive);
      assertActive();
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
    await driver.close();
  })();
  return {
    run() { return running ??= perform(); },
    async read(operation: FixedD1Read) {
      if (!isRecord(operation) || !["inventory", "validate", "page"].includes(operation.op) || !exactKeys(operation, operation.op === "page" ? ["op", "table", "cursor"] : ["op"]) ||
        (operation.op === "page" && (!job.tables.some((table) => table.name === operation.table) || !(operation.cursor === null || (typeof operation.cursor === "number" && Number.isSafeInteger(operation.cursor)))))) throw new TransferError("ARTIFACT_INVALID");
      const pending = request(operation);
      reads.add(pending);
      try { return await pending; } finally { reads.delete(pending); }
    },
    async cancel() { await close(); return cancellationAcknowledgement; },
    dispose: close,
  };
}
