import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  CliUsageScanner,
  CLI_PROJECT_ID,
  JETBRAINS_PROJECT_ID,
  folderPathHash,
} from "../src/core/cli";
import { exportCsv, totals } from "../src/core/analytics";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function sessionDir(root: string, sessionId: string) {
  const dir = join(root, sessionId);
  await mkdir(dir, { recursive: true });
  return join(dir, "events.jsonl");
}

const start = (cwd: string) =>
  JSON.stringify({
    type: "session.start",
    id: "start-1",
    timestamp: "2026-09-22T10:00:00.000Z",
    data: { context: { cwd } },
  });

const shutdown = (
  id: string,
  timestamp: string,
  modelMetrics: Record<string, unknown>,
) =>
  JSON.stringify({
    type: "session.shutdown",
    id,
    timestamp,
    data: { modelMetrics },
  });

const metrics = (
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  count: number,
) => ({
  usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
  requests: { count, cost: 42 },
});

test("folderPathHash normalizes case and trailing slashes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const lower = join(dir, "My Project");
    const upper = join(dir, "MY PROJECT");
    assert.equal(folderPathHash(lower), folderPathHash(upper));
    assert.equal(folderPathHash(lower + "///"), folderPathHash(lower));
    assert.equal(
      folderPathHash(lower),
      sha256(join(dir, "my project").toLowerCase()),
    );
    assert.equal(folderPathHash("/"), sha256("/"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown emits delta entries attributed via the resolver", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-1");
    const cwd = join(dir, "Some Project");
    await writeFile(
      file,
      start(cwd) +
        "\n" +
        shutdown("e1", "2026-09-22T10:05:00.000Z", {
          "gpt-5": metrics(1000, 200, 300, 100, 4),
        }) +
        "\n",
    );
    const scanner = new CliUsageScanner(dir);
    const seen: string[] = [];
    await scanner.poll((c) => {
      seen.push(c);
      return c === cwd ? "proj-a" : undefined;
    });
    assert.equal(scanner.detected, true);
    assert.equal(scanner.caughtUp, true);
    assert.equal(scanner.calls.size, 1);
    const call = scanner.calls.get("cli:sess-1:e1:gpt-5")!;
    assert.equal(call.projectId, "proj-a");
    assert.equal(call.timestamp, Date.parse("2026-09-22T10:05:00.000Z"));
    assert.equal(call.model, "gpt-5");
    assert.equal(call.sessionId, "sess-1");
    assert.equal(call.source, "cli");
    assert.equal(call.input, 1000);
    assert.equal(call.output, 200);
    assert.equal(call.cacheRead, 300);
    assert.equal(call.cacheWrite, 100);
    assert.equal(call.requests, 4);
    assert.equal(call.failed, false);
    assert.equal("durationMs" in call, false);
    // Resolver ran once, lazily, with the raw session cwd.
    assert.deepEqual(seen, [cwd]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cumulative shutdown metrics emit only the increment on resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-2");
    const scanner = new CliUsageScanner(dir);
    const resolve = () => "proj-b";
    await writeFile(
      file,
      shutdown("e1", "2026-09-22T10:05:00.000Z", {
        "gpt-5": metrics(1000, 200, 300, 100, 4),
      }) + "\n",
    );
    await scanner.poll(resolve);
    await appendFile(
      file,
      shutdown("e2", "2026-09-22T10:06:00.000Z", {
        "gpt-5": metrics(1500, 260, 300, 140, 6),
      }) + "\n",
    );
    await scanner.poll(resolve);
    assert.equal(scanner.calls.size, 2);
    const inc = scanner.calls.get("cli:sess-2:e2:gpt-5")!;
    assert.equal(inc.input, 500);
    assert.equal(inc.output, 60);
    assert.equal(inc.cacheRead, 0);
    assert.equal(inc.cacheWrite, 40);
    assert.equal(inc.requests, 2);
    // First entry is untouched by the later cumulative snapshot.
    assert.equal(scanner.calls.get("cli:sess-2:e1:gpt-5")!.input, 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing CLI counters stay unknown across cumulative snapshots and CSV export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-partial");
    await writeFile(
      file,
      [
        shutdown("e1", "2026-09-22T10:05:00.000Z", {
          "gpt-5.4": {
            usage: { inputTokens: 100, outputTokens: 10 },
            requests: { count: 1 },
          },
        }),
        shutdown("e2", "2026-09-22T10:06:00.000Z", {
          "gpt-5.4": {
            usage: { inputTokens: 150, outputTokens: 20, cacheReadTokens: 5 },
          },
        }),
        shutdown("e3", "2026-09-22T10:07:00.000Z", {
          "gpt-5.4": {
            usage: { outputTokens: 25, cacheReadTokens: 7 },
            requests: { count: 3 },
          },
        }),
      ].join("\n") + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "project");
    const first = scanner.calls.get("cli:sess-partial:e1:gpt-5.4")!;
    const second = scanner.calls.get("cli:sess-partial:e2:gpt-5.4")!;
    const third = scanner.calls.get("cli:sess-partial:e3:gpt-5.4")!;
    assert.equal(first.cacheRead, undefined);
    assert.equal(first.cacheWrite, undefined);
    assert.equal(second.input, 50);
    assert.equal(second.requests, undefined);
    assert.equal(third.input, undefined);
    assert.equal(third.output, 5);
    assert.equal(third.cacheRead, 2);
    assert.equal(third.requests, 2);
    assert.equal(totals([...scanner.calls.values()]).calls, 3);
    assert.equal(totals([...scanner.calls.values()]).missingRequests, 1);
    assert.equal(totals([...scanner.calls.values()]).missingUsage, 1);
    const csv = exportCsv([second]);
    assert.ok(csv.includes('"cli",""\r\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cwd attribution falls back to CLI_PROJECT_ID for unknown or absent cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const known = join(dir, "known");
    const a = await sessionDir(dir, "sess-a");
    const b = await sessionDir(dir, "sess-b");
    const c = await sessionDir(dir, "sess-c");
    const body = (id: string) =>
      shutdown(id, "2026-09-22T10:05:00.000Z", {
        "gpt-5": metrics(10, 5, 0, 0, 1),
      }) + "\n";
    await writeFile(a, start(known) + "\n" + body("ea"));
    await writeFile(b, start(join(dir, "stray")) + "\n" + body("eb"));
    await writeFile(c, body("ec"));
    const scanner = new CliUsageScanner(dir);
    await scanner.poll((cwd) => (cwd === known ? "proj-known" : undefined));
    assert.equal(
      scanner.calls.get("cli:sess-a:ea:gpt-5")!.projectId,
      "proj-known",
    );
    assert.equal(
      scanner.calls.get("cli:sess-b:eb:gpt-5")!.projectId,
      CLI_PROJECT_ID,
    );
    assert.equal(
      scanner.calls.get("cli:sess-c:ec:gpt-5")!.projectId,
      CLI_PROJECT_ID,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inputTokens stays inclusive of cache tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-3");
    await writeFile(
      file,
      shutdown("e1", "2026-09-22T10:05:00.000Z", {
        "gpt-5": metrics(1000, 200, 300, 100, 1),
      }) + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "p");
    const call = scanner.calls.get("cli:sess-3:e1:gpt-5")!;
    assert.equal(call.input, 1000);
    assert.equal(call.cacheRead, 300);
    assert.equal(call.cacheWrite, 100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed lines are skipped while valid events still parse", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-4");
    await writeFile(
      file,
      "{broken\n" +
        "not json at all\n" +
        shutdown("e1", "2026-09-22T10:05:00.000Z", {
          "gpt-5": metrics(10, 5, 0, 0, 1),
        }) +
        "\n" +
        JSON.stringify({ type: "session.shutdown", id: "bad" }) +
        "\n" +
        shutdown("e2", "2026-09-22T10:06:00.000Z", {
          "gpt-5": metrics(20, 8, 0, 0, 2),
        }) +
        "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "p");
    assert.equal(scanner.calls.size, 2);
    // Two unparseable lines plus the shutdown without a timestamp.
    assert.equal(scanner.skippedLines, 3);
    assert.equal(scanner.calls.get("cli:sess-4:e2:gpt-5")!.input, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("truncation resets state, drops stale calls and reparses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-5");
    const cwd = join(dir, "proj");
    const scanner = new CliUsageScanner(dir);
    await writeFile(
      file,
      start(cwd) +
        "\n" +
        shutdown("e1", "2026-09-22T10:05:00.000Z", {
          "gpt-5": metrics(1000, 200, 0, 0, 4),
        }) +
        "\n",
    );
    await scanner.poll((c) => (c === cwd ? "proj-x" : undefined));
    assert.equal(scanner.calls.get("cli:sess-5:e1:gpt-5")!.projectId, "proj-x");
    // Rewrite shorter: same inode, smaller size → full reset.
    await writeFile(
      file,
      shutdown("e2", "2026-09-22T10:06:00.000Z", {
        "gpt-5": metrics(50, 10, 0, 0, 1),
      }) + "\n",
    );
    await scanner.poll(() => {
      throw new Error("resolver must not run: no session.start");
    });
    assert.equal(scanner.calls.size, 1);
    assert.equal(scanner.calls.has("cli:sess-5:e1:gpt-5"), false);
    const fresh = scanner.calls.get("cli:sess-5:e2:gpt-5")!;
    // Baseline was reset: the new snapshot counts in full, not as a delta.
    assert.equal(fresh.input, 50);
    // Session state was reset too: no cwd → CLI fallback.
    assert.equal(fresh.projectId, CLI_PROJECT_ID);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing session-state root means undetected, never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const scanner = new CliUsageScanner(join(dir, "session-state"));
    await scanner.poll(() => "p");
    assert.equal(scanner.detected, false);
    assert.equal(scanner.calls.size, 0);
    assert.equal(scanner.caughtUp, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("id-less shutdowns in the same millisecond do not overwrite each other", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-6");
    const ts = "2026-09-22T10:05:00.000Z";
    const noId = (modelMetrics: Record<string, unknown>) =>
      JSON.stringify({
        type: "session.shutdown",
        timestamp: ts,
        data: { modelMetrics },
      });
    await writeFile(
      file,
      noId({ "gpt-5": metrics(100, 10, 0, 0, 1) }) +
        "\n" +
        noId({ "gpt-5": metrics(250, 30, 0, 0, 3) }) +
        "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "p");
    assert.equal(scanner.calls.size, 2);
    const inputs = [...scanner.calls.values()].map((c) => c.input).sort();
    assert.deepEqual(inputs, [100, 150]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JetBrains sessions are tagged and bucketed via workspace.yaml", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-jb");
    await writeFile(
      join(dir, "sess-jb", "workspace.yaml"),
      "client_name: copilot-intellij\n",
    );
    await writeFile(
      file,
      shutdown("sh-jb", "2026-09-22T10:01:00.000Z", {
        "claude-sonnet-4.6": metrics(500, 60, 10, 5, 2),
      }) + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "p");
    const call = [...scanner.calls.values()][0]!;
    assert.equal(call.source, "jetbrains");
    assert.equal(call.projectId, JETBRAINS_PROJECT_ID);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JetBrains cwd attribution uses workspace.yaml when events lack context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-jb2");
    await writeFile(
      join(dir, "sess-jb2", "workspace.yaml"),
      'client_name: "copilot-intellij"\ncwd: /work/myproj\n',
    );
    await writeFile(
      file,
      shutdown("sh-jb2", "2026-09-22T10:02:00.000Z", {
        "gpt-5": metrics(200, 40, 0, 0, 1),
      }) + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll((cwd) =>
      cwd === "/work/myproj" ? "proj-jb" : undefined,
    );
    const call = [...scanner.calls.values()][0]!;
    assert.equal(call.source, "jetbrains");
    assert.equal(call.projectId, "proj-jb");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session.resume updates cwd attribution like session.start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-r");
    const resume = (cwd: string) =>
      JSON.stringify({
        type: "session.resume",
        id: "resume-1",
        timestamp: "2026-09-22T10:00:30.000Z",
        data: { context: { cwd } },
      });
    await writeFile(
      file,
      resume("/work/resumed") +
        "\n" +
        shutdown("sh-r", "2026-09-22T10:03:00.000Z", {
          "gpt-5": metrics(100, 20, 0, 0, 1),
        }) +
        "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll((cwd) =>
      cwd === "/work/resumed" ? "proj-r" : undefined,
    );
    assert.equal([...scanner.calls.values()][0]!.projectId, "proj-r");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace.yaml written after events re-tags emitted calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-late");
    await writeFile(
      file,
      shutdown("sh-late", "2026-09-22T10:04:00.000Z", {
        "gpt-5": metrics(100, 20, 0, 0, 1),
      }) + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "p");
    let call = [...scanner.calls.values()][0]!;
    assert.equal(call.source, "cli");
    assert.equal(call.projectId, CLI_PROJECT_ID);
    await writeFile(
      join(dir, "sess-late", "workspace.yaml"),
      "client_name: copilot-intellij\ncwd: /work/late\n",
    );
    await scanner.poll((cwd) =>
      cwd === "/work/late" ? "proj-late" : undefined,
    );
    call = [...scanner.calls.values()][0]!;
    assert.equal(call.source, "jetbrains");
    assert.equal(call.projectId, "proj-late");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
