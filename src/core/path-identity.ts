import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** Local-only attribution hash preserving POSIX path case and backslashes.
 * Keep the legacy folded path hash separately for Windows and migration. */
export function exactFolderPathHash(fsPath: string): string {
  let normalized = resolve(fsPath);
  if (process.platform === "win32") normalized = normalized.replace(/\\/g, "/");
  while (normalized.length > 1 && normalized.endsWith("/"))
    normalized = normalized.slice(0, -1);
  return createHash("sha256").update(normalized).digest("hex");
}
