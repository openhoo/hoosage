import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { folderPathHash } from "./cli";
import { exactFolderPathHash } from "./path-identity";
import type { Project } from "./types";

/** One VS Code folder window this profile has previously opened, recovered
 * from this profile's own `workspaceStorage` records (not a live VS Code
 * API: there is no public API listing folders that are not currently open). */
export interface KnownFolder {
  id: string;
  name: string;
  pathHash: string;
  exactPathHash: string;
}

/** Reads every `workspaceStorage/<hash>/workspace.json` next to this
 * extension's own `globalStorage` directory and returns the local, single
 * folder ("file://") workspaces recorded there. Multi-root workspace files
 * and remote ("vscode-remote://", "wsl+", etc.) folders are skipped: their
 * project identity depends on data (workspace-file contents, remote-host
 * routing) this best-effort, read-only scan does not have. Never touches
 * usage content; only VS Code's recorded folder URI. */
export async function discoverKnownFolders(
  globalStorageFsPath: string,
): Promise<KnownFolder[]> {
  // globalStorageFsPath is ".../User/globalStorage/openhoo.hoosage"; its
  // sibling "workspaceStorage" holds one directory per known window.
  const userDir = dirname(dirname(globalStorageFsPath));
  const storageDir = join(userDir, "workspaceStorage");
  let entries: Dirent[];
  try {
    entries = await readdir(storageDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = new Map<string, KnownFolder>();
  // A profile can have thousands of saved windows. Bound filesystem work so
  // discovery does not compete heavily with the usage scan during startup.
  for (let start = 0; start < entries.length; start += 8)
    await Promise.all(
      entries.slice(start, start + 8).map(async (entry) => {
        if (!entry.isDirectory()) return;
        try {
          const raw = JSON.parse(
            await readFile(
              join(storageDir, entry.name, "workspace.json"),
              "utf8",
            ),
          );
          const folderUri: unknown = raw?.folder;
          if (typeof folderUri !== "string") return;
          const url = new URL(folderUri);
          // A file URL with a host may be a network share on Windows. It is
          // outside this local-folder scan and may block on network I/O.
          if (url.protocol !== "file:" || url.host) return;
          const fsPath = fileURLToPath(url);
          if (!(await stat(fsPath)).isDirectory()) return;
          const id = createHash("sha256")
            .update(folderUri)
            .digest("hex")
            .slice(0, 24);
          results.set(id, {
            id,
            name: basename(fsPath),
            pathHash: folderPathHash(fsPath),
            exactPathHash: exactFolderPathHash(fsPath),
          });
        } catch {
          /* One unreadable, missing or malformed entry cannot block others. */
        }
      }),
    );
  return [...results.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Builds a placeholder project record for a folder that was previously
 * opened but has no history yet. This registration cannot imply past usage. */
export function placeholderProject(folder: KnownFolder): Project {
  return {
    id: folder.id,
    name: folder.name,
    kind: "folder",
    folderCount: 1,
    createdAt: Date.now(),
    pathHashes: [folder.pathHash],
    exactPathHashes: [folder.exactPathHash],
  };
}
