import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";

/** Common CLI-home identity for native WSL and the Windows UNC reader.
 * Only this hash leaves the scanner; Linux home paths remain local. */
export function wslSessionSourceId(
  distro: string,
  linuxRoot: string,
): string | undefined {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(distro) ||
    !posix.isAbsolute(linuxRoot) ||
    linuxRoot.includes("\0")
  )
    return undefined;
  return createHash("sha256")
    .update(JSON.stringify(["wsl-cli", distro, posix.normalize(linuxRoot)]))
    .digest("hex")
    .slice(0, 24);
}

/** Local-only attribution hash preserving POSIX path case and backslashes.
 * Keep the legacy folded path hash separately for Windows and migration. */
export function exactFolderPathHash(fsPath: string): string {
  let normalized = resolve(fsPath);
  if (process.platform === "win32") normalized = normalized.replace(/\\/g, "/");
  while (normalized.length > 1 && normalized.endsWith("/"))
    normalized = normalized.slice(0, -1);
  return createHash("sha256").update(normalized).digest("hex");
}
