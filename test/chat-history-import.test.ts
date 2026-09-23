import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { folderPathHash } from "../src/core/cli";
import {
  mergeStoredHistory,
  NO_FOLDER_CHAT_PROJECT_ID,
  replayMutationLog,
  requestUsage,
  restoreHistory,
  scanChatHistory,
  withoutLiveOverlap,
} from "../src/core/chat-history-import";
import { totals } from "../src/core/analytics";
import { callCost } from "../src/core/pricing";

const idOf = (uri: string) =>
  createHash("sha256").update(uri).digest("hex").slice(0, 24);
const jsonl = (...ops: unknown[]) =>
  ops.map((op) => JSON.stringify(op)).join("\n") + "\n";

async function profile() {
  const root = await mkdtemp(join(tmpdir(), "hoosage-chat-history-"));
  const user = join(root, "User");
  const globalStorage = join(user, "globalStorage", "openhoo.hoosage");
  await mkdir(globalStorage, { recursive: true });
  const workspace = async (key: string, record: object) => {
    const dir = join(user, "workspaceStorage", key);
    await mkdir(join(dir, "chatSessions"), { recursive: true });
    await writeFile(join(dir, "workspace.json"), JSON.stringify(record));
    return join(dir, "chatSessions");
  };
  return { root, user, globalStorage, workspace };
}

test("replays VS Code mutation logs: set, push with truncate, delete", () => {
  const state = replayMutationLog(
    jsonl(
      { kind: 0, v: { requests: [] } },
      { kind: 2, k: ["requests"], v: [{ requestId: "a" }] },
      { kind: 2, k: ["requests"], v: [{ requestId: "b" }] },
      { kind: 1, k: ["requests", 1, "timestamp"], v: 5 },
      { kind: 2, k: ["requests", 1, "response"], v: [1, 2, 3] },
      { kind: 2, k: ["requests", 1, "response"], v: [9], i: 1 },
      { kind: 3, k: ["requests", 0, "requestId"] },
    ) + "not json\n",
  ) as { requests: Record<string, unknown>[] };
  assert.equal(state.requests.length, 2);
  assert.equal(state.requests[0]!.requestId, undefined);
  assert.equal(state.requests[1]!.timestamp, 5);
  assert.deepEqual(state.requests[1]!.response, [1, 9]);
});

test("rejects unsafe mutation paths and unbounded array operations", () => {
  const state = replayMutationLog(
    jsonl(
      { kind: 0, v: { requests: [] } },
      { kind: 1, k: ["__proto__", "hoosageProbe"], v: "modified" },
      { kind: 1, k: ["constructor", "prototype", "hoosageProbe"], v: "modified" },
      { kind: 2, k: ["requests"], i: 1_000_000_000, v: [{}] },
      { kind: 1, k: ["requests", "length"], v: 1_000_000_000 },
      { kind: 1, k: ["missing", "child"], v: "ignored" },
      { kind: 2, k: ["requests"], v: [{ requestId: "safe" }] },
    ),
  ) as { requests: { requestId: string }[] };
  assert.equal(({} as Record<string, unknown>).hoosageProbe, undefined);
  assert.deepEqual(state.requests, [{ requestId: "safe" }]);
});

test("ignores reported credit values that cannot be represented safely", () => {
  const call = requestUsage(
    { timestamp: 1000, copilotCredits: Number.MAX_SAFE_INTEGER, result: {} },
    "project",
    "session",
  );
  assert.equal(call?.nanoAiu, undefined);
});

test("skips oversized transcript files without reading them", async () => {
  const p = await profile();
  try {
    const folder = join(p.root, "repo");
    const sessions = await p.workspace("one", { folder: pathToFileURL(folder).toString() });
    const handle = await open(join(sessions, "oversized.jsonl"), "w");
    try {
      await handle.truncate(64 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    assert.deepEqual((await scanChatHistory(p.globalStorage)).calls, []);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("recovers requests from jsonl and legacy json transcripts with reported cost", async () => {
  const p = await profile();
  try {
    const folder = join(p.root, "repo");
    await mkdir(folder);
    const uri = pathToFileURL(folder).toString();
    const sessions = await p.workspace("one", { folder: uri });
    await writeFile(
      join(sessions, "a.jsonl"),
      jsonl(
        { kind: 0, v: { sessionId: "s1", requests: [] } },
        {
          kind: 2,
          k: ["requests"],
          v: [{ requestId: "r1", timestamp: 1000, modelId: "copilot/gpt-5.5" }],
        },
        { kind: 1, k: ["requests", 0, "completionTokens"], v: 700 },
        { kind: 1, k: ["requests", 0, "copilotCredits"], v: 12.5 },
        { kind: 1, k: ["requests", 0, "elapsedMs"], v: 900 },
        {
          kind: 1,
          k: ["requests", 0, "result"],
          v: {
            metadata: {
              promptTokens: 40000,
              outputTokens: 100,
              modelMessageId: "m1",
              toolCallRounds: [{}, {}, {}],
            },
          },
        },
        {
          kind: 2,
          k: ["requests"],
          v: [{ requestId: "r2", timestamp: 2000, modelId: "copilot/auto" }],
        },
        {
          kind: 1,
          k: ["requests", 1, "result"],
          v: {
            metadata: {
              promptTokens: 300,
              outputTokens: 20,
              resolvedModel: "claude-sonnet-5",
              toolCallRounds: [{}],
            },
          },
        },
        // Pending request without a result: not a measurement.
        { kind: 2, k: ["requests"], v: [{ requestId: "r3", timestamp: 3000 }] },
      ),
    );
    await writeFile(
      join(sessions, "legacy.json"),
      JSON.stringify({
        sessionId: "s2",
        requests: [
          { requestId: "r4", timestamp: 500, modelId: "copilot/gpt-4.1", result: {} },
          {
            requestId: "r5",
            timestamp: 600,
            modelId: "copilot/gpt-4.1",
            result: { errorDetails: { code: "canceled" } },
          },
          {
            requestId: "r6",
            timestamp: 700,
            modelId: "copilot/gpt-4.1",
            result: { errorDetails: { code: "failed" } },
          },
        ],
      }),
    );
    await writeFile(join(sessions, "broken.jsonl"), "{nope");

    const history = await scanChatHistory(p.globalStorage);
    assert.equal(history.projects.length, 1);
    const [project] = history.projects;
    assert.equal(project!.id, idOf(uri));
    assert.equal(project!.name, "repo");
    assert.equal(project!.createdAt, 500);
    assert.deepEqual(project!.pathHashes, [folderPathHash(folder)]);

    const byTime = new Map(history.calls.map((c) => [c.timestamp, c]));
    assert.deepEqual(
      [...byTime.keys()].sort((a, b) => a - b),
      [500, 600, 700, 1000, 2000],
    );
    const agent = byTime.get(1000)!;
    assert.equal(agent.source, "chat-history");
    assert.equal(agent.model, "gpt-5.5");
    assert.equal(agent.sessionId, "s1");
    assert.equal(agent.requests, 3);
    assert.equal(agent.input, undefined, "prompt of the last round only");
    assert.equal(agent.output, 700);
    assert.equal(agent.nanoAiu, 12_500_000_000);
    assert.equal(agent.durationMs, 900);
    assert.equal(callCost(agent).source, "reported");
    assert.equal(callCost(agent).usd, 0.125);

    const single = byTime.get(2000)!;
    assert.equal(single.model, "claude-sonnet-5");
    assert.equal(single.input, 300);
    assert.equal(single.output, 20);
    assert.equal(single.requests, 1);

    assert.equal(byTime.get(500)!.requests, undefined);
    assert.equal(byTime.get(600)!.failed, false);
    assert.equal(byTime.get(700)!.failed, true);

    const t = totals(history.calls);
    assert.equal(t.calls, 4);
    assert.equal(t.missingRequests, 3);
    assert.ok(!JSON.stringify(history).includes(p.root));
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("registers deleted, remote and multi-root workspaces with history, and dedupes copied sessions", async () => {
  const p = await profile();
  try {
    const request = (id: string, timestamp: number, message = id) => ({
      requestId: id,
      timestamp,
      modelId: "copilot/gpt-5.5",
      copilotCredits: 1,
      result: { metadata: { modelMessageId: message } },
    });
    const deletedUri = pathToFileURL(join(p.root, "gone")).toString();
    await writeFile(
      join(await p.workspace("deleted", { folder: deletedUri }), "a.json"),
      JSON.stringify({ requests: [request("a", 10)] }),
    );
    const remoteUri = "vscode-remote://dev-container%2Babc/workspaces/app";
    const remote = await p.workspace("remote", { folder: remoteUri });
    await writeFile(
      join(remote, "a.json"),
      JSON.stringify({ requests: [request("b", 20, "copied")] }),
    );
    // Same model message copied into a later session counts once.
    await writeFile(
      join(remote, "b.json"),
      JSON.stringify({ requests: [request("c", 30, "copied")] }),
    );
    const workspaceUri = pathToFileURL(join(p.root, "team.code-workspace")).toString();
    await writeFile(
      join(await p.workspace("multi", { workspace: workspaceUri }), "a.json"),
      JSON.stringify({ requests: [request("d", 40)] }),
    );
    // A saved window without history does not create a project here.
    await p.workspace("empty", { folder: pathToFileURL(p.root).toString() });
    const empty = join(p.user, "globalStorage", "emptyWindowChatSessions");
    await mkdir(empty, { recursive: true });
    await writeFile(
      join(empty, "x.json"),
      JSON.stringify({ requests: [request("e", 50)] }),
    );

    const history = await scanChatHistory(p.globalStorage);
    const projects = new Map(history.projects.map((x) => [x.id, x]));
    assert.equal(projects.size, 3);
    assert.equal(projects.get(idOf(deletedUri))!.name, "gone");
    assert.equal(projects.get(idOf(remoteUri))!.name, "app");
    assert.equal(projects.get(idOf(remoteUri))!.pathHashes, undefined);
    assert.equal(projects.get(idOf(workspaceUri))!.name, "team");
    assert.equal(projects.get(idOf(workspaceUri))!.kind, "workspace");
    const remoteCalls = history.calls.filter((c) => c.projectId === idOf(remoteUri));
    assert.deepEqual(remoteCalls.map((c) => c.timestamp), [20]);
    assert.deepEqual(
      history.calls
        .filter((c) => c.projectId === NO_FOLDER_CHAT_PROJECT_ID)
        .map((c) => c.timestamp),
      [50],
    );
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("stored history merges by id and restores only the usage allowlist", () => {
  const call = {
    id: "a".repeat(24),
    projectId: "p",
    timestamp: 5,
    model: "gpt-5.5",
    source: "chat-history" as const,
    output: 3,
    requests: 2,
    failed: false,
  };
  const first = mergeStoredHistory([], [call]);
  assert.equal(first.changed, true);
  assert.equal(mergeStoredHistory(first.calls, [call]).changed, false);
  const restored = restoreHistory(
    { calls: [{ ...call, prompt: "secret", path: "C:/x" }, { id: "bad" }] },
    "p",
  );
  assert.equal(restored.length, 1);
  assert.ok(!JSON.stringify(restored).includes("secret"));
  assert.ok(!JSON.stringify(restored).includes("C:/x"));
  assert.deepEqual(restoreHistory(undefined, "p"), []);
});

test("counts all earlier imported requests, then uses a live-day coverage boundary", () => {
  const before = new Date(2025, 0, 1, 12).getTime();
  const liveDay = new Date(2025, 0, 2, 12).getTime();
  const imported = [
    { id: "1", projectId: "p", timestamp: before, durationMs: 60_000, model: "m", failed: false },
    { id: "2", projectId: "p", timestamp: before + 1_000, durationMs: 60_000, model: "m", failed: false },
    { id: "3", projectId: "p", timestamp: liveDay - 60_000, durationMs: 60_000, model: "m", failed: false },
    { id: "4", projectId: "p", timestamp: liveDay, durationMs: 60_000, model: "m", failed: false },
  ];
  assert.deepEqual(
    withoutLiveOverlap(imported, [liveDay]).map((c) => c.id),
    ["1", "2"],
  );
  assert.deepEqual(withoutLiveOverlap(imported, []).map((c) => c.id), ["1", "2", "3", "4"]);
});
