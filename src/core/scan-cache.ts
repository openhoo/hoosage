import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Where a reader keeps its local index cache, and the value (the extension
 * version) a stored cache must match to be reused. A cache only speeds up
 * start-up: the source files stay authoritative, and a missing, corrupt or
 * outdated cache just means reading them again. */
export interface ScanCache {
  directory: string;
  key: string;
}

/** One cache file per reader kind and source folder. */
export const cacheFile = (cache: ScanCache, kind: string, source: string) =>
  join(
    cache.directory,
    `${kind}-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.json`,
  );

/** The stored payload, or undefined when the cache is missing, unreadable or
 * was written for another format, extension version or source folder. */
export async function readCache(
  file: string,
  format: number,
  key: string,
  source: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data))
      return undefined;
    const stored = data as Record<string, unknown>;
    const payload = stored.payload;
    return stored.format === format &&
      stored.key === key &&
      stored.source === source &&
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort atomic replace, so windows sharing a cache never read a
 * partial file. Returns false when the cache could not be written. */
export async function writeCache(
  file: string,
  format: number,
  key: string,
  source: string,
  payload: unknown,
): Promise<boolean> {
  const content = JSON.stringify({ format, key, source, payload });
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, file);
    return true;
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    return false;
  }
}
