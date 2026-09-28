import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
