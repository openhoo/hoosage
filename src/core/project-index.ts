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
import type { Project, UsageCall } from "./types";

/** Match known workspaces first, then discover projects from local session cwd. */
export class ProjectIndex {
  private readonly known = new Map<string, string | undefined>();
  private readonly discovered = new Map<string, Project>();
  private readonly resolved = new Map<string, string | undefined>();

  constructor(projects: Project[]) {
    for (const project of projects)
      for (const hash of project.pathHashes ?? []) {
        if (!this.known.has(hash)) this.known.set(hash, project.id);
        else if (this.known.get(hash) !== project.id)
          this.known.set(hash, undefined);
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
      });
    return id;
  }

  private registered(directory: string): { matched: boolean; id?: string } {
    for (let candidate = directory; ; candidate = dirname(candidate)) {
      const hash = folderPathHash(candidate);
      if (this.known.has(hash))
        return { matched: true, id: this.known.get(hash) };
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
