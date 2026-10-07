import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { folderPathHash } from "../src/core/cli";
import { exactFolderPathHash } from "../src/core/path-identity";
import {
  discoverKnownFolders,
  placeholderProject,
} from "../src/core/workspace-discovery";

const idOf = (uri: string) =>
  createHash("sha256").update(uri).digest("hex").slice(0, 24);

test("discovers previously opened local folders from workspaceStorage, skips remote/multi-root/deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-workspaces-"));
  try {
    const userDir = join(root, "User");
    const globalStorage = join(userDir, "globalStorage", "openhoo.hoosage");
    const workspaceStorage = join(userDir, "workspaceStorage");
    await mkdir(globalStorage, { recursive: true });

    const kept = join(root, "kept-project");
    await mkdir(kept, { recursive: true });
    const keptUri = pathToFileURL(kept).toString();
    await mkdir(join(workspaceStorage, "kept"), { recursive: true });
    await writeFile(
      join(workspaceStorage, "kept", "workspace.json"),
      JSON.stringify({ folder: keptUri }),
    );
    await mkdir(join(workspaceStorage, "duplicate"));
    await writeFile(
      join(workspaceStorage, "duplicate", "workspace.json"),
      JSON.stringify({ folder: keptUri }),
    );

    // Deleted folder: recorded in workspaceStorage but no longer on disk.
    const deletedUri = pathToFileURL(join(root, "gone")).toString();
    await mkdir(join(workspaceStorage, "deleted"), { recursive: true });
    await writeFile(
      join(workspaceStorage, "deleted", "workspace.json"),
      JSON.stringify({ folder: deletedUri }),
    );

    // Multi-root workspace file: not a single "folder" entry, must be skipped.
    await mkdir(join(workspaceStorage, "multiroot"), { recursive: true });
    await writeFile(
      join(workspaceStorage, "multiroot", "workspace.json"),
      JSON.stringify({
        workspace: pathToFileURL(join(root, "x.code-workspace")).toString(),
      }),
    );

    // Remote / dev container folder: must be skipped.
    await mkdir(join(workspaceStorage, "remote"), { recursive: true });
    await writeFile(
      join(workspaceStorage, "remote", "workspace.json"),
      JSON.stringify({
        folder: "vscode-remote://dev-container+abcd/workspaces/app",
      }),
    );
    await mkdir(join(workspaceStorage, "network"));
    await writeFile(
      join(workspaceStorage, "network", "workspace.json"),
      JSON.stringify({ folder: "file://server/share/project" }),
    );

    const found = await discoverKnownFolders(globalStorage);
    assert.deepEqual(
      found.map((f) => f.id),
      [idOf(keptUri)],
    );
    assert.equal(found[0]!.name, "kept-project");
    assert.equal(found[0]!.pathHash, folderPathHash(kept));
    assert.equal(found[0]!.exactPathHash, exactFolderPathHash(kept));

    const before = Date.now();
    const project = placeholderProject(found[0]!);
    const after = Date.now();
    assert.equal(project.id, idOf(keptUri));
    assert.equal(project.kind, "folder");
    assert.equal(project.folderCount, 1);
    assert.deepEqual(project.pathHashes, [folderPathHash(kept)]);
    assert.deepEqual(project.exactPathHashes, [exactFolderPathHash(kept)]);
    assert.ok(project.createdAt >= before && project.createdAt <= after);
    assert.ok(!JSON.stringify(project).includes(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns nothing when workspaceStorage is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-workspaces-"));
  try {
    const globalStorage = join(
      root,
      "User",
      "globalStorage",
      "openhoo.hoosage",
    );
    await mkdir(globalStorage, { recursive: true });
    assert.deepEqual(await discoverKnownFolders(globalStorage), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
