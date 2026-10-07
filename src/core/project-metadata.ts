import type { Project } from "./types";

const kinds = new Set(["folder", "workspace", "cli", "jetbrains", "chat"]);

/** Restore only project metadata we own. Storage may contain legacy fields;
 * none of them should reach the dashboard, upgrades, or JSON exports. */
export function restoreProject(value: unknown): Project | undefined {
  if (typeof value !== "object" || value === null) return;
  const project = value as Record<string, unknown>;
  if (
    typeof project.id !== "string" ||
    !/^[a-f0-9]{24}$/.test(project.id) ||
    typeof project.name !== "string" ||
    typeof project.kind !== "string" ||
    !kinds.has(project.kind) ||
    !Number.isSafeInteger(project.folderCount) ||
    (project.folderCount as number) < 0 ||
    typeof project.createdAt !== "number" ||
    !Number.isFinite(project.createdAt) ||
    project.createdAt < 0
  )
    return;
  const restored: Project = {
    id: project.id,
    name: project.name,
    kind: project.kind as Project["kind"],
    folderCount: project.folderCount as number,
    createdAt: project.createdAt,
  };
  if (Array.isArray(project.pathHashes))
    restored.pathHashes = project.pathHashes.filter(
      (hash): hash is string =>
        typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
    );
  if (Array.isArray(project.exactPathHashes))
    restored.exactPathHashes = project.exactPathHashes.filter(
      (hash): hash is string =>
        typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
    );
  return restored;
}
