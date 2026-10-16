import { exactKeys, isRecord } from "./access";
import type { SnapshotRow, TypedValue } from "./transfer";

export function recordValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid actual fixed-job object response");
  return value;
}

export async function recordReply(response: Response) {
  return recordValue(await response.json());
}

function typedValue(value: unknown): value is TypedValue {
  if (!Array.isArray(value) || value.length !== 2) return false;
  return value[0] === "null" ? value[1] === null
    : value[0] === "text" ? typeof value[1] === "string"
    : value[0] === "integer" ? typeof value[1] === "number" && Number.isSafeInteger(value[1])
    : value[0] === "real" && typeof value[1] === "number" && Number.isFinite(value[1]);
}

function snapshotRow(value: unknown): value is SnapshotRow {
  return isRecord(value) && exactKeys(value, ["rowid", "values"]) && typeof value.rowid === "number" && Number.isSafeInteger(value.rowid) && Array.isArray(value.values) && value.values.every(typedValue);
}

export interface FixedD1TestPage {
  ok: true;
  columns: string[];
  rows: SnapshotRow[];
  cursor: number | null;
  complete: boolean;
}

export async function pageReply(response: Response): Promise<FixedD1TestPage> {
  const value = await recordReply(response);
  const { columns, rows, cursor, complete } = value;
  if (value.ok !== true || !Array.isArray(columns) || !columns.every((column): column is string => typeof column === "string") ||
    !Array.isArray(rows) || rows.length > 64 || !rows.every(snapshotRow) || rows.some((row) => row.values.length + 1 !== columns.length) ||
    !(cursor === null || (typeof cursor === "number" && Number.isSafeInteger(cursor))) || typeof complete !== "boolean") throw new Error("Invalid actual fixed-job page response");
  return { ...value, ok: true, columns, rows, cursor, complete };
}

export function headersRecord(headers: { forEach(callback: (value: string, key: string) => void): void }) {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => { result[key] = value; });
  return result;
}

export function ownedUid() {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Native ownership fixtures require a Unix UID");
  return uid;
}
