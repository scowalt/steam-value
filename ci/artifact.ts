import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkedProductionIdentity, validateIdentity, type Identity } from "./context";

export type { Identity } from "./context";
interface Entry { path: string; content: string; sha256: string }
interface Artifact { version: number; identity: Identity; created: number; expires: number; files: Entry[] }
export interface ArtifactStore { put(key: string, text: string): Promise<void>; get(key: string): Promise<string> }
const lifetime = 7 * 24 * 60 * 60;
const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export function artifactKey(identity: Identity) {
  validateIdentity(identity);
  return `steam-value/github-actions/${identity.run}/${identity.attempt}/${identity.commit}.json`;
}

export async function transferArtifact(action: "upload" | "download", store: ArtifactStore, directory: string, identity: Identity, now: number) {
  const key = artifactKey(identity);
  if (action === "upload") {
    const text = await createArtifact(directory, identity, now);
    await store.put(key, text);
    await store.put(`${key}.sha256`, digest(Buffer.from(text)));
  } else {
    const text = await store.get(key);
    if (digest(Buffer.from(text)) !== await store.get(`${key}.sha256`)) throw new Error("Artifact envelope integrity mismatch");
    await restoreArtifact(text, directory, identity, now);
  }
}

export async function createArtifact(directory: string, identity: Identity, now: number): Promise<string> {
  validateIdentity(identity);
  const files: Entry[] = [];
  async function visit(prefix: string) {
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path);
      else {
        if (!entry.isFile()) throw new Error("Artifact output must contain only regular files");
        const bytes = new Uint8Array(await Bun.file(join(directory, path)).arrayBuffer());
        files.push({ path, content: Buffer.from(bytes).toString("base64"), sha256: digest(bytes) });
      }
    }
  }
  await visit("");
  if (!files.length) throw new Error("Empty artifact output");
  return JSON.stringify({ version: 2, identity, created: now, expires: now + lifetime, files } satisfies Artifact);
}

export async function restoreArtifact(text: string, directory: string, identity: Identity, now: number) {
  const artifact: Artifact = JSON.parse(text);
  if (artifact.version !== 2 || artifactKey(artifact.identity) !== artifactKey(identity) ||
      !Number.isSafeInteger(artifact.created) || artifact.expires !== artifact.created + lifetime ||
      now < artifact.created || now >= artifact.expires) throw new Error("Artifact identity or lifetime mismatch");
  if (!Array.isArray(artifact.files) || !artifact.files.length) throw new Error("Empty artifact");
  const paths = new Set<string>();
  const decoded = artifact.files.map((file) => {
    if (typeof file.path !== "string" || file.path.includes("\\") || file.path.includes("\u0000") ||
        file.path.split("/").some((part) => !part || part === "." || part === "..") || paths.has(file.path)) {
      throw new Error("Unsafe artifact path");
    }
    paths.add(file.path);
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.toString("base64") !== file.content || digest(bytes) !== file.sha256) throw new Error("Artifact integrity mismatch");
    return { file, bytes };
  });
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (paths.has(parts.slice(0, i).join("/"))) throw new Error("Conflicting artifact paths");
    }
  }
  await mkdir(directory);
  for (const { file, bytes } of decoded) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
}

if (import.meta.main) {
  const action = process.argv[2];
  if (action !== "upload" && action !== "download") throw new Error("Expected upload or download");
  const identity = checkedProductionIdentity();
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name} binding`);
    return value;
  };
  const endpoint = required("STEAM_VALUE_ARTIFACT_ENDPOINT");
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Expected private HTTPS S3 endpoint");
  const s3 = new Bun.S3Client({
    endpoint, bucket: required("STEAM_VALUE_ARTIFACT_BUCKET"), region: required("STEAM_VALUE_ARTIFACT_REGION"),
    accessKeyId: required("STEAM_VALUE_ARTIFACT_ACCESS_KEY"), secretAccessKey: required("STEAM_VALUE_ARTIFACT_SECRET_KEY"),
  });
  const store: ArtifactStore = {
    put: async (key, text) => { await s3.file(key).write(text, { type: "application/octet-stream" }); },
    get: async (key) => s3.file(key).text(),
  };
  await transferArtifact(action, store, "dist", identity, Math.floor(Date.now() / 1000));
}
