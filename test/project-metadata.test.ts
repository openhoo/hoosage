import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreProject } from "../src/core/project-metadata";

const project = {
  id: "a".repeat(24),
  name: "Sample",
  kind: "folder",
  folderCount: 1,
  createdAt: 1000,
};

test("restored project metadata drops extra fields and invalid attribution hashes", () => {
  const hash = "b".repeat(64);
  assert.deepEqual(
    restoreProject({
      ...project,
      pathHashes: [hash, "/private/path", 123],
      exactPathHashes: [hash, "/private/path", 123],
      repositoryUrl: "https://private.example/repo",
      prompt: "private content",
    }),
    { ...project, pathHashes: [hash], exactPathHashes: [hash] },
  );
  assert.deepEqual(restoreProject(project), project);
});

test("invalid project identity and measurements are rejected", () => {
  for (const invalid of [
    null,
    [],
    { ...project, id: "../escape" },
    { ...project, kind: "unknown" },
    { ...project, folderCount: -1 },
    { ...project, folderCount: 0.5 },
    { ...project, createdAt: Infinity },
    { ...project, name: 123 },
  ])
    assert.equal(restoreProject(invalid), undefined);
});
