import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { folderPathHash } from "../src/core/cli";
import { exactFolderPathHash } from "../src/core/path-identity";
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
    assert.equal(index.resolve(nested), projectId(await realpath(one)));
    assert.equal(index.resolve(two), projectId(await realpath(two)));
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
      exactPathHashes: [exactFolderPathHash(dir)],
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

const syntheticProject = (
  path: string,
  overrides: Partial<Project> = {},
): Project => ({
  id: projectId(path),
  name: "Synthetic",
  kind: "folder",
  folderCount: 1,
  createdAt: 0,
  pathHashes: [folderPathHash(path)],
  exactPathHashes: [exactFolderPathHash(path)],
  ...overrides,
});

test("case-distinct registered paths resolve separately without filesystem probes", () => {
  const upper = join(tmpdir(), "hoosage-synthetic", "Project");
  const lower = join(tmpdir(), "hoosage-synthetic", "project");
  assert.equal(folderPathHash(upper), folderPathHash(lower));
  assert.notEqual(exactFolderPathHash(upper), exactFolderPathHash(lower));
  const index = new ProjectIndex(
    [syntheticProject(upper), syntheticProject(lower)],
    true,
  );
  assert.equal(index.resolve(join(upper, "deleted-child")), projectId(upper));
  assert.equal(index.resolve(join(lower, "deleted-child")), projectId(lower));
  assert.deepEqual(index.projects([]), []);
});

test("legacy folder records validate the unchanged URI identity before attribution", () => {
  const upper = join(tmpdir(), "hoosage-legacy", "Project");
  const lower = join(tmpdir(), "hoosage-legacy", "project");
  const upperLegacy = syntheticProject(upper, { exactPathHashes: undefined });
  const lowerLegacy = syntheticProject(lower, { exactPathHashes: undefined });
  const index = new ProjectIndex([upperLegacy, lowerLegacy], true);
  assert.equal(index.resolve(join(upper, "deleted-child")), upperLegacy.id);
  assert.equal(index.resolve(join(lower, "deleted-child")), lowerLegacy.id);
  assert.equal(
    new ProjectIndex([upperLegacy], true).resolve(join(lower, "deleted-child")),
    undefined,
  );
});

test("legacy groups fail closed on case-sensitive hosts until exact hashes upgrade", () => {
  const path = join(tmpdir(), "hoosage-legacy-group", "Project");
  const legacy = syntheticProject(path, {
    id: "workspace-group",
    kind: "workspace",
    exactPathHashes: undefined,
  });
  assert.equal(
    new ProjectIndex([legacy], true).resolve(join(path, "deleted-child")),
    undefined,
  );
  const upgraded = { ...legacy, exactPathHashes: [exactFolderPathHash(path)] };
  assert.equal(
    new ProjectIndex([upgraded], true).resolve(join(path, "deleted-child")),
    legacy.id,
  );
  assert.equal(
    new ProjectIndex([upgraded], true).resolve(
      join(path.toLowerCase(), "deleted-child"),
    ),
    undefined,
  );
});

test("case-insensitive attribution keeps legacy hashes and rejects folded ambiguity", () => {
  const upper = join(tmpdir(), "hoosage-windows-model", "Project");
  const lower = join(tmpdir(), "hoosage-windows-model", "project");
  const legacy = syntheticProject(upper, {
    id: "workspace-group",
    kind: "workspace",
    exactPathHashes: undefined,
  });
  assert.equal(
    new ProjectIndex([legacy], false).resolve(join(lower, "deleted-child")),
    legacy.id,
  );
  assert.equal(
    new ProjectIndex([legacy, syntheticProject(lower)], false).resolve(
      join(upper, "deleted-child"),
    ),
    undefined,
  );
});

test("exact POSIX hashes preserve literal backslashes and normalize only trailing slash", () => {
  if (process.platform === "win32") return;
  const path = join(tmpdir(), "hoosage-backslash", "literal\\path");
  assert.notEqual(
    exactFolderPathHash(path),
    exactFolderPathHash(path.replace(/\\/g, "/")),
  );
  assert.equal(exactFolderPathHash(path), exactFolderPathHash(`${path}/`));
});

test("legacy reserved-character paths accept VS Code and Node URI identities without merging ambiguous records", () => {
  const path = join(tmpdir(), "hoosage-legacy", "Mixed Project(!'*)#%:é");
  const vscodeUri = `file://${path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/")}`;
  const vscodeId = createHash("sha256")
    .update(vscodeUri)
    .digest("hex")
    .slice(0, 24);
  const nodeLegacy = syntheticProject(path, { exactPathHashes: undefined });
  const vscodeLegacy = { ...nodeLegacy, id: vscodeId };
  assert.notEqual(nodeLegacy.id, vscodeLegacy.id);
  assert.equal(
    new ProjectIndex([nodeLegacy], true).resolve(join(path, "deleted-child")),
    nodeLegacy.id,
  );
  assert.equal(
    new ProjectIndex([vscodeLegacy], true).resolve(join(path, "deleted-child")),
    vscodeLegacy.id,
  );
  assert.equal(
    new ProjectIndex([vscodeLegacy], true).resolve(
      join(path.toLowerCase(), "deleted-child"),
    ),
    undefined,
  );
  assert.equal(
    new ProjectIndex([nodeLegacy, vscodeLegacy], true).resolve(
      join(path, "deleted-child"),
    ),
    undefined,
  );
});
