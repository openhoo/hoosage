import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve as resolvePath,
} from "node:path";
import { pathToFileURL } from "node:url";
import { folderPathHash } from "./cli";
import { exactFolderPathHash } from "./path-identity";
import type { Project, UsageCall } from "./types";

/** Match known workspaces first, then discover projects from local session cwd. */
export class ProjectIndex {
  private readonly known = new Map<string, string | undefined>();
  private readonly exact = new Map<string, string | undefined>();
  private readonly legacy = new Map<string, Project[]>();
  private readonly discovered = new Map<string, Project>();
  private readonly resolved = new Map<string, string | undefined>();

  constructor(
    projects: Project[],
    private readonly caseSensitive = process.platform !== "win32",
  ) {
    const register = (
      map: Map<string, string | undefined>,
      hash: string,
      id: string,
    ) => {
      if (!map.has(hash)) map.set(hash, id);
      else if (map.get(hash) !== id) map.set(hash, undefined);
    };
    for (const project of projects) {
      for (const hash of project.exactPathHashes ?? [])
        register(this.exact, hash, project.id);
      for (const hash of project.pathHashes ?? []) {
        register(this.known, hash, project.id);
        if (!project.exactPathHashes?.length) {
          const candidates = this.legacy.get(hash) ?? [];
          candidates.push(project);
          this.legacy.set(hash, candidates);
        }
      }
    }
  }

  resolve(cwd: string): string | undefined {
    if (this.resolved.has(cwd)) return this.resolved.get(cwd);
    const id = this.resolveUncached(cwd);
    this.resolved.set(cwd, id);
    return id;
  }

  private resolveUncached(cwd: string): string | undefined {
    if (!isAbsolute(cwd)) return undefined;
    const recorded = this.registered(resolvePath(cwd));
    if (recorded.matched) return recorded.id;
    let directory: string;
    try {
      directory = realpathSync(cwd);
      if (!statSync(directory).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    const canonical = this.registered(directory);
    if (canonical.matched) return canonical.id;
    // A session launched in a subdirectory belongs to its nearest Git root.
    // No repository contents or remote URL are read.
    let projectPath = directory;
    for (let candidate = directory; ; candidate = dirname(candidate)) {
      if (existsSync(join(candidate, ".git"))) {
        projectPath = candidate;
        break;
      }
      if (dirname(candidate) === candidate) break;
    }
    if (dirname(projectPath) === projectPath) return undefined;
    const id = createHash("sha256")
      .update(pathToFileURL(projectPath).toString())
      .digest("hex")
      .slice(0, 24);
    if (!this.discovered.has(id))
      this.discovered.set(id, {
        id,
        name: basename(projectPath),
        kind: "folder",
        folderCount: 1,
        createdAt: Date.now(),
        pathHashes: [folderPathHash(projectPath)],
        exactPathHashes: [exactFolderPathHash(projectPath)],
      });
    return id;
  }

  private registered(directory: string): { matched: boolean; id?: string } {
    for (let candidate = directory; ; candidate = dirname(candidate)) {
      if (!this.caseSensitive) {
        const hash = folderPathHash(candidate);
        if (this.known.has(hash))
          return { matched: true, id: this.known.get(hash) };
      } else {
        const exactHash = exactFolderPathHash(candidate);
        if (this.exact.has(exactHash))
          return { matched: true, id: this.exact.get(exactHash) };
        const legacy = this.legacy.get(folderPathHash(candidate));
        if (legacy?.length) {
          // Closed single-folder records can prove their case-sensitive path
          // through their unchanged folder URI identity. Workspace groups do
          // not retain a folder URI, so fail closed until their hashes upgrade.
          if (legacy.some((project) => project.kind !== "folder"))
            return { matched: true };
          // VS Code's URI serialization percent-encodes reserved characters
          // that Node's file URL leaves literal (including parentheses).
          // Accept either historical identity, without changing stored IDs.
          const vscodeUri = `file://${candidate
            .split("/")
            .map((segment) =>
              encodeURIComponent(segment).replace(
                /[!'()*]/g,
                (character) =>
                  `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
              ),
            )
            .join("/")}`;
          const identities = new Set(
            [pathToFileURL(candidate).toString(), vscodeUri].map((uri) =>
              createHash("sha256").update(uri).digest("hex").slice(0, 24),
            ),
          );
          const matching = new Set(
            legacy
              .filter((project) => identities.has(project.id))
              .map((project) => project.id),
          );
          if (matching.size)
            return {
              matched: true,
              id: matching.size === 1 ? [...matching][0] : undefined,
            };
        }
      }
      if (dirname(candidate) === candidate) return { matched: false };
    }
  }

  projects(calls: UsageCall[]): Project[] {
    for (const call of calls) {
      const project = this.discovered.get(call.projectId);
      if (project)
        project.createdAt = Math.min(project.createdAt, call.timestamp);
    }
    return [...this.discovered.values()];
  }
}
