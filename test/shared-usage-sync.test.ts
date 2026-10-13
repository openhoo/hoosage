import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedUsageSync } from "../src/core/shared-usage-sync";
import type { UsageCall } from "../src/core/types";

const projectA = "a".repeat(24);
const projectB = "b".repeat(24);
const call = (id: string, projectId: string): UsageCall => ({
  id,
  projectId,
  timestamp: 1_750_000_000_000,
  model: "test-model",
  input: 12,
  output: 8,
  failed: false,
});

test("exchanges sanitized usage between hosts without duplicate imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-usage-"));
  try {
    const hostA = new SharedUsageSync(
      root,
      "same checkout",
      "a".repeat(24),
      "window-a",
    );
    const hostB = new SharedUsageSync(
      root,
      "same checkout",
      "b".repeat(24),
      "window-b",
    );
    const a = call("span-a", projectA);
    const b = call("span-b", projectB);

    assert.deepEqual(await hostA.poll([a], projectA), []);
    assert.deepEqual(await hostB.poll([b], projectB), [
      { ...a, projectId: projectB },
    ]);
    assert.deepEqual(await hostA.poll([a], projectA), [
      { ...b, projectId: projectA },
    ]);
    assert.deepEqual(await hostB.poll([b], projectB), [
      { ...a, projectId: projectB },
    ]);

    const groupDirs = await readdir(root);
    const files = await readdir(join(root, groupDirs[0]!));
    assert.equal(files.length, 2);
    const payload = await readFile(
      join(root, groupDirs[0]!, files[0]!),
      "utf8",
    );
    assert.ok(!payload.includes("same checkout"));
    assert.ok(!payload.includes("repo"));
    assert.equal(payload.trim().split("\n").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps different user-selected groups isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-groups-"));
  try {
    const writer = new SharedUsageSync(root, "first", "a".repeat(24), "one");
    const reader = new SharedUsageSync(root, "second", "b".repeat(24), "two");
    await writer.poll([call("span", projectA)], projectA);
    assert.deepEqual(await reader.poll([], projectB), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects tampered shared usage entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-invalid-"));
  try {
    const writer = new SharedUsageSync(root, "shared", "a".repeat(24), "one");
    const reader = new SharedUsageSync(root, "shared", "b".repeat(24), "two");
    await writer.poll([call("span", projectA)], projectA);
    const group = (await readdir(root))[0]!;
    const file = (await readdir(join(root, group)))[0]!;
    const path = join(root, group, file);
    const content = await readFile(path, "utf8");
    await writeFile(
      path,
      content.replace('"id":"span"', '"id":"span","prompt":"must not sync"'),
    );
    await assert.rejects(reader.poll([], projectB), /invalid entry/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("counts a session read and shared by two peer hosts once", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-peers-"));
  try {
    const first = new SharedUsageSync(root, "shared", "a".repeat(24), "one");
    const second = new SharedUsageSync(root, "shared", "b".repeat(24), "two");
    const reader = new SharedUsageSync(root, "shared", "c".repeat(24), "three");
    const usage = {
      ...call("same-cli-shutdown", projectA),
      source: "cli" as const,
    };
    await first.poll([usage], projectA);
    await second.poll([{ ...usage, projectId: projectB }], projectB);
    assert.deepEqual(await reader.poll([], projectA), [usage]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replacing a peer file with a larger file removes its old records", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-replacement-"));
  try {
    const hostId = "a".repeat(24);
    const writer = new SharedUsageSync(root, "shared", hostId, "one");
    const reader = new SharedUsageSync(root, "shared", "b".repeat(24), "two");
    await writer.poll([call("old", projectA)], projectA);
    assert.equal((await reader.poll([], projectB))[0]!.id, "old");
    const group = join(root, (await readdir(root))[0]!);
    const path = join(group, (await readdir(group))[0]!);
    const replacement = call("new-with-longer-id", projectA);
    await writeFile(
      `${path}.tmp`,
      JSON.stringify({ version: 1, hostId, call: replacement }) + "\n",
    );
    await rename(`${path}.tmp`, path);
    assert.deepEqual(await reader.poll([], projectB), [
      { ...replacement, projectId: projectB },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed peer validation does not retain partially parsed records", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-recovery-"));
  try {
    const hostId = "a".repeat(24);
    const writer = new SharedUsageSync(root, "shared", hostId, "one");
    const reader = new SharedUsageSync(root, "shared", "b".repeat(24), "two");
    await writer.poll([call("old", projectA)], projectA);
    await reader.poll([], projectB);
    const group = join(root, (await readdir(root))[0]!);
    const path = join(group, (await readdir(group))[0]!);
    const old = await readFile(path, "utf8");
    const entry = (id: string) =>
      JSON.stringify({ version: 1, hostId, call: call(id, projectA) }) + "\n";
    await writeFile(path, old + entry("must-not-survive") + "malformed\n");
    await assert.rejects(reader.poll([], projectB), /malformed/);
    await writeFile(path, old + entry("corrected-longer-entry-id"));
    assert.deepEqual(
      (await reader.poll([], projectB)).map((usage) => usage.id),
      ["old", "corrected-longer-entry-id"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects a larger peer file rewritten in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-rewrite-"));
  try {
    const hostId = "a".repeat(24);
    const writer = new SharedUsageSync(root, "shared", hostId, "one");
    const reader = new SharedUsageSync(root, "shared", "b".repeat(24), "two");
    await writer.poll([call("old", projectA)], projectA);
    await reader.poll([], projectB);
    const group = join(root, (await readdir(root))[0]!);
    const path = join(group, (await readdir(group))[0]!);
    const replacement = call("larger-in-place-replacement", projectA);
    await writeFile(
      path,
      JSON.stringify({ version: 1, hostId, call: replacement }) + "\n",
    );
    assert.deepEqual(await reader.poll([], projectB), [
      { ...replacement, projectId: projectB },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not share calls from a different workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-isolation-"));
  try {
    const writer = new SharedUsageSync(root, "shared", "a".repeat(24), "one");
    await assert.rejects(
      writer.poll([call("foreign", projectB)], projectA),
      /Invalid usage entry/,
    );
    const group = join(root, (await readdir(root))[0]!);
    assert.deepEqual(await readdir(group), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shares late usage metadata and remembers updates across restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-updates-"));
  try {
    const writer = () =>
      new SharedUsageSync(root, "shared", "a".repeat(24), "one");
    const reader = new SharedUsageSync(root, "shared", "b".repeat(24), "two");
    const first = writer();
    const original = call("usage", projectA);
    await first.poll([original], projectA);
    await reader.poll([], projectB);
    const updated = { ...original, nanoAiu: 123, output: 15 };
    await first.poll([updated], projectA);
    assert.deepEqual(await reader.poll([], projectB), [
      { ...updated, projectId: projectB },
    ]);
    await writer().poll([updated], projectA);
    const group = join(root, (await readdir(root))[0]!);
    const files = (await readdir(group)).filter((file) =>
      file.startsWith("a".repeat(24)),
    );
    assert.equal(
      (await readFile(join(group, files[0]!), "utf8")).trim().split("\n")
        .length,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid calendar timestamps and unsafe or fractional counters", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-numbers-"));
  try {
    const writer = new SharedUsageSync(root, "shared", "a".repeat(24), "one");
    for (const fields of [
      { timestamp: 1e100 },
      { input: 0.5 },
      { nanoAiu: Number.MAX_SAFE_INTEGER + 1 },
    ])
      await assert.rejects(
        writer.poll([{ ...call("usage", projectA), ...fields }], projectA),
        /Invalid usage entry/,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new window's refreshed metadata supersedes an older peer file", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-new-window-"));
  try {
    const hostId = "a".repeat(24);
    const first = new SharedUsageSync(root, "shared", hostId, "old-window");
    const reader = new SharedUsageSync(
      root,
      "shared",
      "b".repeat(24),
      "reader",
    );
    const original = call("same-request", projectA);
    await first.poll([original], projectA);
    await reader.poll([], projectB);
    const group = join(root, (await readdir(root))[0]!);
    const path = join(group, (await readdir(group))[0]!);
    await utimes(path, new Date(1000), new Date(1000));
    const second = new SharedUsageSync(root, "shared", hostId, "new-window");
    const updated = { ...original, nanoAiu: 123, output: 15 };
    await second.poll([updated], projectA);
    assert.deepEqual(await reader.poll([], projectB), [
      { ...updated, projectId: projectB },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid own-file recovery cannot mark unwritten calls as shared", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-own-recovery-"));
  try {
    const hostId = "a".repeat(24);
    const writer = () =>
      new SharedUsageSync(root, "shared", hostId, "same-window");
    const original = call("original", projectA);
    const next = call("next", projectA);
    await writer().poll([original], projectA);
    const group = join(root, (await readdir(root))[0]!);
    const path = join(group, (await readdir(group))[0]!);
    const contents = await readFile(path, "utf8");
    await writeFile(
      path,
      contents +
        JSON.stringify({ version: 1, hostId, call: next }) +
        "\nmalformed\n",
    );
    const restarted = writer();
    await assert.rejects(
      restarted.poll([original, next], projectA),
      /malformed/,
    );
    await writeFile(path, contents);
    await restarted.poll([original, next], projectA);
    assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("republishes current usage when a running writer's own file is deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-own-deletion-"));
  try {
    const writer = new SharedUsageSync(root, "shared", "a".repeat(24), "one");
    const reader = new SharedUsageSync(root, "shared", "b".repeat(24), "two");
    const usage = call("retained-locally", projectA);
    await writer.poll([usage], projectA);
    assert.equal((await reader.poll([], projectB)).length, 1);
    const group = join(root, (await readdir(root))[0]!);
    const path = join(group, (await readdir(group))[0]!);
    await rm(path);
    assert.deepEqual(await reader.poll([], projectB), []);
    await writer.poll([usage], projectA);
    assert.deepEqual(await reader.poll([], projectB), [
      { ...usage, projectId: projectB },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("republishes missing records after its own shared file is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-own-replacement-"));
  try {
    const hostId = "a".repeat(24);
    const writer = new SharedUsageSync(root, "shared", hostId, "one");
    const reader = new SharedUsageSync(root, "shared", "b".repeat(24), "two");
    const retained = call("retained", projectA);
    const missing = call("missing", projectA);
    await writer.poll([retained, missing], projectA);
    await reader.poll([], projectB);
    const group = join(root, (await readdir(root))[0]!);
    const path = join(group, (await readdir(group))[0]!);
    await writeFile(
      `${path}.tmp`,
      JSON.stringify({ version: 1, hostId, call: retained }) + "\n",
    );
    await rename(`${path}.tmp`, path);
    await writer.poll([retained, missing], projectA);
    assert.deepEqual(
      (await reader.poll([], projectB)).map((entry) => entry.id).sort(),
      ["missing", "retained"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("separates a recovered complete record without a final newline from the next append", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-own-newline-"));
  try {
    const writer = () =>
      new SharedUsageSync(root, "shared", "a".repeat(24), "one");
    const reader = new SharedUsageSync(root, "shared", "b".repeat(24), "two");
    const original = call("original", projectA);
    const next = call("next", projectA);
    await writer().poll([original], projectA);
    const group = join(root, (await readdir(root))[0]!);
    const path = join(group, (await readdir(group))[0]!);
    await writeFile(path, (await readFile(path, "utf8")).trimEnd());
    await writer().poll([original, next], projectA);
    assert.deepEqual(
      (await reader.poll([], projectB)).map((entry) => entry.id).sort(),
      ["next", "original"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shares explicit session-cost coverage without inventing a measured zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-cost-coverage-"));
  try {
    const writer = new SharedUsageSync(root, "shared", "a".repeat(24), "one");
    const reader = new SharedUsageSync(root, "shared", "b".repeat(24), "two");
    const usage: UsageCall = {
      ...call("covered", projectA),
      source: "cli",
      costIncludedInSessionTotal: true,
    };
    await writer.poll([usage], projectA);
    const imported = await reader.poll([], projectB);
    assert.deepEqual(imported, [{ ...usage, projectId: projectB }]);
    assert.equal(imported[0]!.nanoAiu, undefined);
    await assert.rejects(
      writer.poll([{ ...usage, source: "chat" }], projectA),
      /Invalid usage entry/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers an interrupted final append without deleting complete records", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoosage-shared-partial-write-"));
  try {
    const writer = () =>
      new SharedUsageSync(root, "shared", "a".repeat(24), "one");
    const reader = new SharedUsageSync(root, "shared", "b".repeat(24), "two");
    const original = call("original", projectA);
    const next = call("next", projectA);
    const running = writer();
    await running.poll([original], projectA);
    const group = join(root, (await readdir(root))[0]!);
    const path = join(group, (await readdir(group))[0]!);
    const contents = await readFile(path, "utf8");
    await writeFile(path, contents + '{"version":1,"call":');
    await running.poll([original, next], projectA);
    assert.deepEqual(
      (await reader.poll([], projectB)).map((entry) => entry.id).sort(),
      ["next", "original"],
    );
    await writeFile(path, (await readFile(path, "utf8")) + '{"version":');
    await writer().poll([original, next], projectA);
    assert.deepEqual(
      (await reader.poll([], projectB)).map((entry) => entry.id).sort(),
      ["next", "original"],
    );
    assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
