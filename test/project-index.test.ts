import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { folderPathHash } from "../src/core/cli";
import { ProjectIndex } from "../src/core/project-index";
import type { Project } from "../src/core/types";

const projectId = (path: string) =>
  createHash("sha256")
    .update(pathToFileURL(path).toString())
    .digest("hex")
    .slice(0, 24);

test("local sessions discover separate Git projects without prior enable clicks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-projects-"));
  try {
    const one = join(dir, "one");
    const two = join(dir, "two");
    const nested = join(one, "src");
    await mkdir(nested, { recursive: true });
    await mkdir(two);
    await writeFile(join(one, ".git"), "gitdir: elsewhere");
    await mkdir(join(two, ".git"));
    const index = new ProjectIndex([]);
    assert.equal(index.resolve(nested), projectId(one));
    assert.equal(index.resolve(two), projectId(two));
    assert.equal(index.resolve("relative/path"), undefined);
    assert.equal(index.resolve(join(dir, "missing")), undefined);
    const projects = index.projects([]);
    assert.deepEqual(
      projects.map((project) => project.name),
      ["one", "two"],
    );
    assert.ok(
      projects.every((project) => !JSON.stringify(project).includes(dir)),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registered workspace groups win and ambiguous mappings stay unassigned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-projects-"));
  try {
    const nested = join(dir, "src");
    await mkdir(nested);
    const registered: Project = {
      id: "workspace-a",
      name: "Workspace",
      kind: "workspace",
      folderCount: 1,
      createdAt: 0,
      pathHashes: [folderPathHash(dir)],
    };
    const index = new ProjectIndex([registered]);
    assert.equal(index.resolve(nested), "workspace-a");
    assert.equal(index.resolve(join(dir, "previously-deleted")), "workspace-a");
    assert.deepEqual(index.projects([]), []);
    const ambiguous = new ProjectIndex([
      registered,
      { ...registered, id: "workspace-b" },
    ]);
    assert.equal(ambiguous.resolve(nested), undefined);
    assert.deepEqual(ambiguous.projects([]), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
