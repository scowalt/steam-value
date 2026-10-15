export class TransferError extends Error {
  constructor(readonly code: "SCHEMA_DRIFT" | "UNSUPPORTED_DATA" | "FREEZE_REQUIRED" | "ARTIFACT_INVALID" | "ARTIFACT_UNSAFE" | "TARGET_NOT_EMPTY" | "INCOMPLETE_IMPORT" | "CONTENT_MISMATCH" | "BEHAVIOR_REQUIRED" | "TRANSFER_FAILED") {
    super({
      SCHEMA_DRIFT: "Unresolved schema or metadata drift; stop for reviewed inventory",
      UNSUPPORTED_DATA: "Source data exceeds supported types or bounds; preserve it and stop",
      FREEZE_REQUIRED: "Matching explicit writer freeze and drain evidence is required",
      ARTIFACT_INVALID: "Snapshot is incomplete, malformed or fails integrity checks",
      ARTIFACT_UNSAFE: "Artifacts must be private owned files outside Git without symlinks",
      TARGET_NOT_EMPTY: "Import requires a deliberately selected pristine empty or staging target",
      INCOMPLETE_IMPORT: "Import is incomplete or uncertain; inspect protected receipts and restart explicitly",
      CONTENT_MISMATCH: "Full schema, typed content or sequence validation failed",
      BEHAVIOR_REQUIRED: "Representative viewer and job verification is required before validation completes",
      TRANSFER_FAILED: "Transfer failed; inspect protected incomplete receipts without retrying writes",
    }[code]);
    this.name = "TransferError";
  }
}
