import { migrationChecksum } from "./migrations";

export const OBSERVED_LEGACY_OBJECTS_FINGERPRINT = "14cb9d6452f08b8f2b173b989d82b5b82e9e4351769d4f19d88c95a068af1ca1";
const legacyDdlChecksum = "82672af610969b8701cdbb9a50f818eaa73d68e5737b03a009699cef55fdc486";

export async function legacySchemaStatements(): Promise<string[]> {
  const ddl = await Bun.file(new URL("../../schemas/legacy-source-v1.sql", import.meta.url)).text();
  if (await migrationChecksum(ddl) !== legacyDdlChecksum) throw new Error("Reviewed legacy schema definition changed");
  return ddl.split(";").map((statement) => statement.trim()).filter(Boolean);
}
