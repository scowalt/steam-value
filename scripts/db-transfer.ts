#!/usr/bin/env bun
import { resolve } from "node:path";
import {
  createD1TransferSource, createD1TransferTarget, exportSnapshot, importSnapshot, inventorySource,
  localBehaviorVerifier, openLocalTransferHandle, prepareRollback, readFreezeRecord, TransferError, validateSnapshot,
} from "../src/db/transfer";

const usage = `Usage: bun --no-env-file scripts/db-transfer.ts <operation> --local --persist-to <isolated-directory> --id <label> --freeze-record <private-file> <operation-options>
Operations:
  inventory --destination <new-private-directory>
  export --destination <new-private-directory>
  import --snapshot <private-directory> --intent empty|staging --receipt <new-private-file>
  validate --snapshot <private-directory> --receipt <private-file> [--verify-with <private-reviewed-module>]
  prepare-rollback --snapshot <baseline-private-directory> --destination <new-private-directory>
Local only. No bootstrap, reset, remote access, automatic fallback, credentials or rollback writes.
Validation requires full content/schema/sequence and reviewed representative viewer/job checks.
Live operator adapters are separate APIs and remain gated by #28 approval.`;

function parseArgs(args: string[]) {
  const operation = args[0];
  const operationOptions: Record<string, string[]> = {
    inventory: ["--destination"], export: ["--destination"],
    import: ["--snapshot", "--intent", "--receipt"], validate: ["--snapshot", "--receipt", "--verify-with"],
    "prepare-rollback": ["--snapshot", "--destination"],
  };
  if (!operation || !Object.hasOwn(operationOptions, operation)) throw new Error(usage);
  const allowed = ["--local", "--persist-to", "--id", "--freeze-record", ...operationOptions[operation]!];
  const values: Record<string, string> = {};
  for (let index = 1; index < args.length; index++) {
    const key = args[index]!;
    if (!allowed.includes(key) || Object.hasOwn(values, key)) throw new Error(usage);
    if (key === "--local") { values[key] = "true"; continue; }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(usage);
    values[key] = value;
  }
  for (const key of allowed.filter((key) => key !== "--verify-with")) if (!values[key]) throw new Error(usage);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(values["--id"]!) || (operation === "import" && !["empty", "staging"].includes(values["--intent"]!))) throw new Error(usage);
  return { operation, values };
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const { operation, values } = parseArgs(args);
  const freezeRecord = await readFreezeRecord(resolve(values["--freeze-record"]!));
  if (freezeRecord.sourceId !== values["--id"]) throw new TransferError("FREEZE_REQUIRED");
  const local = await openLocalTransferHandle(resolve(values["--persist-to"]!));
  try {
    const source = createD1TransferSource(local.binding, { id: values["--id"]!, freezeRecord });
    const destination = values["--destination"] ? resolve(values["--destination"]!) : undefined;
    let status: string;
    let artifact: string;
    if (operation === "inventory") {
      await inventorySource(source, destination!);
      status = "complete"; artifact = destination!;
    } else if (operation === "export") {
      await exportSnapshot(source, destination!, freezeRecord);
      status = "complete"; artifact = destination!;
    } else if (operation === "prepare-rollback") {
      const receipt = await prepareRollback(source, resolve(values["--snapshot"]!), destination!);
      status = receipt.status; artifact = destination!;
    } else {
      const target = createD1TransferTarget(local.binding, {
        id: source.id, freezeRecord, intent: values["--intent"] === "empty" ? "empty" : "staging", receiptPath: resolve(values["--receipt"]!),
        verifyBehavior: values["--verify-with"] ? await localBehaviorVerifier(local.binding, values["--verify-with"]!) : undefined,
      });
      const snapshot = resolve(values["--snapshot"]!);
      const receipt = operation === "import" ? await importSnapshot(target, snapshot) : await validateSnapshot(target, snapshot);
      status = receipt.status; artifact = target.receiptPath;
    }
    console.log(JSON.stringify({ scope: "isolated-local", operation, status, artifact }));
  } finally { await local.dispose(); }
}

if (import.meta.main) {
  try { await main(Bun.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof TransferError ? `${error.code}: ${error.message}` : error instanceof Error && error.message === usage ? usage : "TRANSFER_FAILED: Local operation failed; inspect protected incomplete receipts");
    process.exitCode = 1;
  }
}
