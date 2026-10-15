import { constants } from "node:fs";
import { lstat, mkdir, open, rename, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { TransferError } from "./transfer-error";
import { TRANSFER_LIMITS } from "./transfer-native";
import type { ImportReceipt, ImportReceiptPublisher } from "./transfer";

async function outsideGit(path: string) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (info?.isSymbolicLink()) throw new TransferError("ARTIFACT_UNSAFE");
    if (await lstat(join(current, ".git")).catch(() => undefined)) throw new TransferError("ARTIFACT_UNSAFE");
  }
  return absolute;
}

function owned(info: { mode: number; uid: number }, mode: number) {
  return (info.mode & 0o777) === mode && (process.getuid === undefined || info.uid === process.getuid());
}

async function privateDirectory(path: string, create = false) {
  try {
    const absolute = await outsideGit(path);
    if (create) await mkdir(absolute, { mode: 0o700 });
    const info = await lstat(absolute);
    if (!info.isDirectory() || !owned(info, 0o700) || await realpath(absolute) !== absolute) throw new TransferError("ARTIFACT_UNSAFE");
    return absolute;
  } catch { throw new TransferError("ARTIFACT_UNSAFE"); }
}

async function privateFile(path: string, create = false): Promise<FileHandle> {
  const absolute = await outsideGit(path);
  await privateDirectory(dirname(absolute));
  const handle = await open(absolute, create ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW : constants.O_RDONLY | constants.O_NOFOLLOW, 0o600).catch(() => { throw new TransferError("ARTIFACT_UNSAFE"); });
  const info = await handle.stat();
  if (!info.isFile() || !owned(info, 0o600) || info.nlink !== 1) {
    await handle.close();
    throw new TransferError("ARTIFACT_UNSAFE");
  }
  return handle;
}

async function writeJson(path: string, value: unknown, create = false) {
  if (!create) {
    const existing = await privateFile(path);
    await existing.close();
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const file = await privateFile(temporary, true);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); }
  finally { await file.close(); }
  if (create) {
    const destination = await privateFile(path, true);
    await destination.close();
  }
  await rename(temporary, path).catch(() => { throw new TransferError("ARTIFACT_UNSAFE"); });
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readJson(path: string): Promise<unknown> {
  const file = await privateFile(path);
  try {
    if ((await file.stat()).size > TRANSFER_LIMITS.maxManifestBytes) throw new TransferError("ARTIFACT_INVALID");
    return JSON.parse(await file.readFile("utf8"));
  } catch (error) { throw error instanceof TransferError ? error : new TransferError("ARTIFACT_INVALID"); }
  finally { await file.close(); }
}

export function createGuardedImportReceiptPublication(receiptPath: string, publisher: ImportReceiptPublisher) {
  return async (value: ImportReceipt, create = false) => {
    const expected = JSON.stringify(value);
    if (create && await lstat(receiptPath).catch(() => undefined)) throw new TransferError("ARTIFACT_UNSAFE");
    await publisher.publish(value, create);
    if (JSON.stringify(await readJson(receiptPath)) !== expected) throw new TransferError("ARTIFACT_INVALID");
  };
}

export { privateDirectory, privateFile, readJson, writeJson };
