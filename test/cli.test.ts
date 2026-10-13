import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import { createHash } from "node:crypto";
import {
  CliUsageScanner,
  CLI_PROJECT_ID,
  JETBRAINS_PROJECT_ID,
  folderPathHash,
} from "../src/core/cli";
import { exportCsv, totals } from "../src/core/analytics";
import { callCost } from "../src/core/pricing";

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
      sha256(join(dir, "my project").split(sep).join("/").toLowerCase()),
    );
    const root = parse(dir).root;
    assert.equal(folderPathHash(root + "///"), folderPathHash(root));
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
    assert.ok(seen.length >= 1 && seen.every((value) => value === cwd));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stored CLI intervals move into newly registered projects without new events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-move");
    const first = join(dir, "first");
    const second = join(dir, "second");
    await writeFile(
      file,
      [
        start(first),
        shutdown("e1", "2026-09-22T10:05:00Z", {
          "gpt-5": metrics(10, 2, 0, 0, 1),
        }),
        JSON.stringify({
          type: "session.resume",
          data: { context: { cwd: second } },
        }),
        shutdown("e2", "2026-09-22T10:06:00Z", {
          "gpt-5": metrics(20, 4, 0, 0, 2),
        }),
      ].join("\n") + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => undefined);
    assert.deepEqual(
      [...scanner.calls.values()].map((call) => call.projectId),
      [CLI_PROJECT_ID, CLI_PROJECT_ID],
    );
    await scanner.poll((cwd) =>
      cwd === first
        ? "project-first"
        : cwd === second
          ? "project-second"
          : undefined,
    );
    assert.equal(
      scanner.calls.get("cli:sess-move:e1:gpt-5")?.projectId,
      "project-first",
    );
    assert.equal(
      scanner.calls.get("cli:sess-move:e2:gpt-5")?.projectId,
      "project-second",
    );
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

test("CLI model cost uses reported cumulative nano-AIU only for reliable intervals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-cost");
    const metric = (input: number, nanoAiu?: number) => ({
      ...metrics(input, 100, 0, 0, input / 100),
      ...(nanoAiu === undefined ? {} : { totalNanoAiu: nanoAiu }),
    });
    await writeFile(
      file,
      [
        shutdown("e1", "2026-09-22T10:01:00Z", {
          "gpt-5.4": metric(100, 100_000_000_000),
        }),
        shutdown("e2", "2026-09-22T10:02:00Z", {
          "gpt-5.4": metric(200, 150_000_000_000),
        }),
        shutdown("e3", "2026-09-22T10:03:00Z", {
          "gpt-5.4": metric(300),
        }),
        shutdown("e4", "2026-09-22T10:04:00Z", {
          "gpt-5.4": metric(400, 200_000_000_000),
        }),
        shutdown("e5", "2026-09-22T10:05:00Z", {
          "gpt-5.4": metric(500, 210_000_000_000),
        }),
      ].join("\n") + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "p");
    const entries = ["e1", "e2", "e3", "e4", "e5"].map((id) =>
      scanner.calls.get(`cli:sess-cost:${id}:gpt-5.4`)!,
    );
    assert.deepEqual(
      entries.map((entry) => entry.nanoAiu),
      [100_000_000_000, 50_000_000_000, undefined, undefined, 10_000_000_000],
    );
    assert.deepEqual(
      entries.map((entry) => callCost(entry).source),
      ["reported", "reported", "estimated", "estimated", "reported"],
    );
    assert.equal(callCost(entries[1]!).usd, 0.5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI retains reported AI credit cost when token counts are unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-credits-only");
    await writeFile(
      file,
      shutdown("e1", "2026-09-22T10:01:00Z", {
        "unknown-model": { totalNanoAiu: 50_000_000_000 },
      }) + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "p");
    const entry = scanner.calls.get("cli:sess-credits-only:e1:unknown-model")!;
    assert.equal(entry.input, undefined);
    assert.equal(entry.output, undefined);
    assert.deepEqual(callCost(entry), { source: "reported", usd: 0.5 });
    assert.equal(totals([entry]).missingUsage, 1);
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

const checkpoint = (
  id: string,
  timestamp: string,
  totalNanoAiu: number,
  modelId?: string,
) =>
  JSON.stringify({
    type: "session.usage_checkpoint",
    id,
    timestamp,
    data: {
      totalNanoAiu,
      totalPremiumRequests: 0,
      modelCacheState: modelId ? [{ modelId, cacheTtlSeconds: 300 }] : [],
    },
  });

const totalShutdown = (
  id: string,
  timestamp: string,
  totalNanoAiu: number,
  currentModel: string,
  modelMetrics: Record<string, unknown>,
) =>
  JSON.stringify({
    type: "session.shutdown",
    id,
    timestamp,
    data: { totalNanoAiu, currentModel, modelMetrics },
  });

const priced = (
  inputTokens: number,
  outputTokens: number,
  count: number,
  totalNanoAiu: number | undefined,
) => ({ ...metrics(inputTokens, outputTokens, 0, 0, count), totalNanoAiu });

const sessionUsd = (scanner: CliUsageScanner) =>
  [...scanner.calls.values()].reduce((n, c) => n + (callCost(c).usd ?? 0), 0);

test("session totalNanoAiu covers usage lost to compaction via checkpoints", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-compact");
    // modelMetrics restart after compaction; only the session total keeps
    // everything (observed: $13.83 total vs $6.23 in modelMetrics).
    await writeFile(
      file,
      [
        checkpoint(
          "c1",
          "2026-08-17T10:35:00Z",
          491_000_000_000,
          "claude-opus-4.8",
        ),
        checkpoint(
          "c2",
          "2026-08-17T10:56:00Z",
          760_000_000_000,
          "claude-opus-4.8",
        ),
        checkpoint(
          "c3",
          "2026-08-17T12:16:00Z",
          1_383_000_000_000,
          "claude-opus-4.8",
        ),
        totalShutdown(
          "s1",
          "2026-08-17T12:20:00Z",
          1_383_000_000_000,
          "claude-opus-4.8",
          {
            "claude-opus-4.8": priced(900_000, 9_000, 45, 623_000_000_000),
          },
        ),
      ].join("\n") + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "p");
    assert.equal(sessionUsd(scanner).toFixed(2), "13.83");
    const first = scanner.calls.get("cli:sess-compact:c1:claude-opus-4.8")!;
    assert.equal(first.timestamp, Date.parse("2026-08-17T10:35:00Z"));
    assert.equal(first.nanoAiu, 491_000_000_000);
    assert.equal(first.requests, 0);
    assert.equal(first.input, 0);
    const final = scanner.calls.get("cli:sess-compact:s1:claude-opus-4.8")!;
    assert.equal(final.input, 900_000);
    assert.equal(final.requests, 45);
    assert.equal(final.nanoAiu, 0);
    const t = totals([...scanner.calls.values()]);
    assert.equal(t.calls, 45);
    assert.equal(t.missingRequests, 0);
    assert.equal(t.missingUsage, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown assigns cost missing from modelMetrics to the current model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-sub");
    await writeFile(
      file,
      totalShutdown(
        "s1",
        "2026-08-16T17:46:00Z",
        300_000_000_000,
        "gpt-5.6-sol",
        {
          "gpt-5.5": priced(1_000, 10, 1, 50_000_000_000),
          "gpt-5.6-sol": priced(20_000, 200, 10, 150_000_000_000),
        },
      ) + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "p");
    assert.equal(scanner.calls.size, 2);
    assert.equal(
      scanner.calls.get("cli:sess-sub:s1:gpt-5.5")!.nanoAiu,
      50_000_000_000,
    );
    assert.equal(
      scanner.calls.get("cli:sess-sub:s1:gpt-5.6-sol")!.nanoAiu,
      250_000_000_000,
    );
    assert.equal(sessionUsd(scanner).toFixed(2), "3.00");

    const other = await sessionDir(dir, "sess-other");
    await writeFile(
      other,
      totalShutdown(
        "s1",
        "2026-08-16T18:00:00Z",
        80_000_000_000,
        "claude-opus-4.8",
        {
          "gpt-5.5": priced(1_000, 10, 1, 30_000_000_000),
        },
      ) + "\n",
    );
    await scanner.poll(() => "p");
    const rest = scanner.calls.get("cli:sess-other:s1:claude-opus-4.8")!;
    assert.equal(rest.nanoAiu, 50_000_000_000);
    assert.equal(rest.requests, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("running sessions report checkpoint cost before shutdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-live");
    await writeFile(
      file,
      JSON.stringify({
        type: "session.model_change",
        timestamp: "2026-08-20T09:00:00Z",
        data: { newModel: "gpt-5.6-sol" },
      }) +
        "\n" +
        checkpoint("c1", "2026-08-20T09:10:00Z", 120_000_000_000) +
        "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "p");
    assert.equal(sessionUsd(scanner).toFixed(2), "1.20");
    assert.equal(
      scanner.calls.get("cli:sess-live:c1:gpt-5.6-sol")!.model,
      "gpt-5.6-sol",
    );
    await appendFile(
      file,
      checkpoint("c2", "2026-08-20T09:20:00Z", 200_000_000_000, "gpt-5.6-sol") +
        "\n" +
        totalShutdown(
          "s1",
          "2026-08-20T09:30:00Z",
          260_000_000_000,
          "gpt-5.6-sol",
          {
            "gpt-5.6-sol": priced(50_000, 500, 12, 260_000_000_000),
          },
        ) +
        "\n",
    );
    await scanner.poll(() => "p");
    assert.equal(sessionUsd(scanner).toFixed(2), "2.60");
    const final = scanner.calls.get("cli:sess-live:s1:gpt-5.6-sol")!;
    assert.equal(final.nanoAiu, 60_000_000_000);
    assert.equal(final.requests, 12);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cumulative session totals continue across resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-resume");
    await writeFile(
      file,
      [
        totalShutdown(
          "s1",
          "2026-08-16T16:55:00Z",
          216_000_000_000,
          "gpt-5.6-sol",
          {
            "gpt-5.6-sol": priced(2_000, 20, 44, 216_000_000_000),
          },
        ),
        JSON.stringify({ type: "session.resume", data: {} }),
        checkpoint(
          "c1",
          "2026-08-16T17:40:00Z",
          273_000_000_000,
          "gpt-5.6-sol",
        ),
        totalShutdown(
          "s2",
          "2026-08-16T17:46:00Z",
          273_000_000_000,
          "gpt-5.6-sol",
          {
            "gpt-5.6-sol": priced(2_500, 25, 48, 273_000_000_000),
          },
        ),
      ].join("\n") + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "p");
    assert.equal(sessionUsd(scanner).toFixed(2), "2.73");
    assert.equal(totals([...scanner.calls.values()]).calls, 48);
    assert.equal(
      scanner.calls.get("cli:sess-resume:s2:gpt-5.6-sol")!.input,
      500,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("per-run session counters from older CLIs are summed across resumes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "sess-runs");
    await writeFile(
      file,
      [
        totalShutdown("s1", "2026-07-03T08:27:00Z", 75_000_000_000, "gpt-5.5", {
          "gpt-5.5": priced(10_000, 100, 18, 75_000_000_000),
        }),
        totalShutdown("s2", "2026-07-03T08:28:54Z", 26_000_000_000, "gpt-5.5", {
          "gpt-5.5": priced(3_000, 30, 3, 26_000_000_000),
        }),
      ].join("\n") + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "p");
    assert.equal(sessionUsd(scanner).toFixed(2), "1.01");
    const second = scanner.calls.get("cli:sess-runs:s2:gpt-5.5")!;
    assert.equal(second.input, 3_000);
    assert.equal(second.requests, 3);
    assert.equal(second.nanoAiu, 26_000_000_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("replayed shutdown and checkpoint IDs do not reset cumulative counters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "replay");
    const first = totalShutdown(
      "s1",
      "2026-09-22T10:01:00Z",
      100_000_000_000,
      "gpt-5.4",
      {
        "gpt-5.4": priced(1000, 100, 4, 100_000_000_000),
      },
    );
    await writeFile(
      file,
      [
        first,
        checkpoint("c1", "2026-09-22T10:02:00Z", 150_000_000_000),
        first,
        totalShutdown(
          "s2",
          "2026-09-22T10:03:00Z",
          200_000_000_000,
          "gpt-5.4",
          {
            "gpt-5.4": priced(2000, 200, 8, 200_000_000_000),
          },
        ),
        checkpoint("c1", "2026-09-22T10:02:00Z", 150_000_000_000),
      ].join("\n") + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "p");
    assert.equal(totals([...scanner.calls.values()]).input, 2000);
    assert.equal(totals([...scanner.calls.values()]).calls, 8);
    assert.equal(sessionUsd(scanner), 2);
    assert.equal(scanner.calls.get("cli:replay:s1:gpt-5.4")!.input, 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("model counters restarting without session cost count the first new run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "model-reset");
    await writeFile(
      file,
      [
        shutdown("s1", "2026-09-22T10:01:00Z", {
          "gpt-5.4": priced(1000, 100, 4, 100_000_000_000),
        }),
        shutdown("s2", "2026-09-22T10:02:00Z", {
          "gpt-5.4": priced(200, 20, 1, 20_000_000_000),
        }),
        shutdown("s3", "2026-09-22T10:03:00Z", {
          "gpt-5.4": priced(500, 50, 3, 50_000_000_000),
        }),
      ].join("\n") + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "p");
    assert.equal(totals([...scanner.calls.values()]).input, 1500);
    assert.equal(totals([...scanner.calls.values()]).output, 150);
    assert.equal(totals([...scanner.calls.values()]).calls, 7);
    assert.equal(sessionUsd(scanner), 1.5);
    assert.equal(scanner.calls.get("cli:model-reset:s2:gpt-5.4")!.input, 200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit zero model snapshots establish a reset baseline without emitting fake usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-"));
  try {
    const file = await sessionDir(dir, "zero-reset");
    await writeFile(
      file,
      [
        shutdown("s1", "2026-09-22T10:01:00Z", {
          "gpt-5.4": metrics(1000, 100, 0, 0, 4),
        }),
        shutdown("s2", "2026-09-22T10:02:00Z", {
          "gpt-5.4": metrics(0, 0, 0, 0, 0),
        }),
        shutdown("s3", "2026-09-22T10:03:00Z", {
          "gpt-5.4": metrics(2000, 200, 0, 0, 8),
        }),
      ].join("\n") + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "p");
    assert.equal(scanner.calls.size, 2);
    assert.equal(totals([...scanner.calls.values()]).input, 3000);
    assert.equal(totals([...scanner.calls.values()]).calls, 12);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("newly appearing session totals include earlier reported model costs once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-late-total-"));
  try {
    const file = await sessionDir(dir, "late-total");
    await writeFile(
      file,
      [
        shutdown("model-only", "2026-09-22T10:01:00Z", {
          "gpt-5.4": priced(1000, 100, 4, 100_000_000_000),
        }),
        checkpoint(
          "first-total",
          "2026-09-22T10:02:00Z",
          150_000_000_000,
          "gpt-5.4",
        ),
        totalShutdown(
          "with-total",
          "2026-09-22T10:03:00Z",
          200_000_000_000,
          "gpt-5.4",
          { "gpt-5.4": priced(2000, 200, 8, 200_000_000_000) },
        ),
        shutdown("total-missing-again", "2026-09-22T10:04:00Z", {
          "gpt-5.4": priced(3000, 300, 12, 300_000_000_000),
        }),
        checkpoint(
          "total-back",
          "2026-09-22T10:05:00Z",
          350_000_000_000,
          "gpt-5.4",
        ),
      ].join("\n") + "\n",
    );
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "project");
    assert.equal(sessionUsd(scanner), 3.5);
    assert.equal(
      scanner.calls.get("cli:late-total:first-total:gpt-5.4")!.nanoAiu,
      50_000_000_000,
    );
    assert.equal(
      scanner.calls.get("cli:late-total:total-back:gpt-5.4")!.nanoAiu,
      50_000_000_000,
    );
    assert.equal(totals([...scanner.calls.values()]).calls, 12);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("authoritative session totals replace earlier fallback estimates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-late-total-"));
  try {
    const file = await sessionDir(dir, "estimate-covered");
    await writeFile(
      file,
      shutdown("estimate", "2026-09-22T10:01:00Z", {
        "gpt-5.4": metrics(1000, 100, 0, 0, 4),
      }) + "\n",
    );
    const cache = { directory: join(dir, "cache"), key: "test" };
    const before = new CliUsageScanner(dir, cache);
    await before.poll(() => "project");
    assert.equal(callCost([...before.calls.values()][0]!).source, "estimated");
    await appendFile(
      file,
      checkpoint(
        "first-total",
        "2026-09-22T10:02:00Z",
        150_000_000_000,
        "gpt-5.4",
      ) + "\n",
    );
    const restarted = new CliUsageScanner(dir, cache);
    await restarted.poll(() => "project");
    assert.equal(sessionUsd(restarted), 1.5);
    assert.equal(totals([...restarted.calls.values()]).calls, 4);
    assert.equal(totals([...restarted.calls.values()]).input, 1000);
    const earlier = restarted.calls.get(
      "cli:estimate-covered:estimate:gpt-5.4",
    )!;
    assert.equal(
      earlier.nanoAiu,
      undefined,
      "the individual interval cost was not measured",
    );
    assert.deepEqual(callCost(earlier), {
      source: "included",
      reason: "Included in reported session total",
    });
    assert.equal(earlier.costIncludedInSessionTotal, true);
    const fresh = new CliUsageScanner(dir);
    await fresh.poll(() => "project");
    assert.deepEqual([...fresh.calls.values()], [...restarted.calls.values()]);
    const csv = exportCsv([...restarted.calls.values()]);
    assert.ok(csv.includes('"included","Included in reported session total"'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("model shutdowns without session totals cannot repeat cost already covered by checkpoints", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-checkpoint-overlap-"));
  try {
    const file = await sessionDir(dir, "overlap");
    const cache = { directory: join(dir, "cache"), key: "test" };
    await writeFile(
      file,
      [
        shutdown("model-only", "2026-09-22T10:01:00Z", {
          "gpt-5.4": priced(1000, 100, 1, 100_000_000_000),
        }),
        checkpoint(
          "checkpoint",
          "2026-09-22T10:02:00Z",
          150_000_000_000,
          "gpt-5.4",
        ),
      ].join("\n") + "\n",
    );
    const initial = new CliUsageScanner(dir, cache);
    await initial.poll(() => "project");
    assert.equal(sessionUsd(initial), 1.5);
    await appendFile(
      file,
      [
        shutdown("model-total", "2026-09-22T10:03:00Z", {
          "gpt-5.4": priced(2000, 200, 2, 200_000_000_000),
        }),
        checkpoint(
          "final-checkpoint",
          "2026-09-22T10:04:00Z",
          200_000_000_000,
          "gpt-5.4",
        ),
      ].join("\n") + "\n",
    );
    const restarted = new CliUsageScanner(dir, cache);
    await restarted.poll(() => "project");
    assert.equal(sessionUsd(restarted), 2);
    assert.equal(
      restarted.calls.get("cli:overlap:model-total:gpt-5.4")!.nanoAiu,
      50_000_000_000,
    );
    const fresh = new CliUsageScanner(dir);
    await fresh.poll(() => "project");
    assert.deepEqual(
      JSON.parse(JSON.stringify([...restarted.calls.values()])),
      JSON.parse(JSON.stringify([...fresh.calls.values()])),
    );
    assert.equal(totals([...restarted.calls.values()]).calls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a decreasing model cost cannot lower the reliable baseline across cached restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-cost-drop-"));
  try {
    const file = await sessionDir(dir, "cost-drop");
    const cache = { directory: join(dir, "cache"), key: "test" };
    await writeFile(
      file,
      [
        shutdown("first", "2026-09-22T10:01:00Z", {
          "gpt-5.4": priced(100, 10, 1, 500),
        }),
        shutdown("decreased", "2026-09-22T10:02:00Z", {
          "gpt-5.4": priced(200, 20, 2, 100),
        }),
      ].join("\n") + "\n",
    );
    const first = new CliUsageScanner(dir, cache);
    await first.poll(() => "project");
    assert.equal(
      first.calls.get("cli:cost-drop:decreased:gpt-5.4")!.nanoAiu,
      undefined,
    );
    await appendFile(
      file,
      shutdown("recovered", "2026-09-22T10:03:00Z", {
        "gpt-5.4": priced(300, 30, 3, 600),
      }) + "\n",
    );
    const restarted = new CliUsageScanner(dir, cache);
    await restarted.poll(() => "project");
    assert.equal(
      restarted.calls.get("cli:cost-drop:recovered:gpt-5.4")!.nanoAiu,
      100,
    );
    assert.equal(
      [...restarted.calls.values()].reduce(
        (sum, call) => sum + (call.nanoAiu ?? 0),
        0,
      ),
      600,
    );
    const fresh = new CliUsageScanner(dir);
    await fresh.poll(() => "project");
    assert.deepEqual([...restarted.calls.values()], [...fresh.calls.values()]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a synchronized shutdown residual cannot suppress later model cost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-cost-residual-"));
  try {
    const file = await sessionDir(dir, "residual");
    const cache = { directory: join(dir, "cache"), key: "test" };
    await writeFile(
      file,
      totalShutdown(
        "covered",
        "2026-09-22T10:01:00Z",
        200_000_000_000,
        "gpt-5.4",
        {
          "gpt-5.4": priced(1000, 100, 1, 100_000_000_000),
        },
      ) + "\n",
    );
    const first = new CliUsageScanner(dir, cache);
    await first.poll(() => "project");
    assert.equal(sessionUsd(first), 2);
    await appendFile(
      file,
      [
        shutdown("new-model-only", "2026-09-22T10:02:00Z", {
          "gpt-5.4": priced(1500, 150, 2, 150_000_000_000),
        }),
        checkpoint("final", "2026-09-22T10:03:00Z", 250_000_000_000, "gpt-5.4"),
      ].join("\n") + "\n",
    );
    const restarted = new CliUsageScanner(dir, cache);
    await restarted.poll(() => "project");
    assert.equal(
      restarted.calls.get("cli:residual:new-model-only:gpt-5.4")!.nanoAiu,
      50_000_000_000,
    );
    assert.equal(sessionUsd(restarted), 2.5);
    const fresh = new CliUsageScanner(dir);
    await fresh.poll(() => "project");
    assert.deepEqual([...restarted.calls.values()], [...fresh.calls.values()]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impossible CLI cache subsets remain unknown in snapshots and emitted deltas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-cache-subsets-"));
  try {
    const cache = { directory: join(dir, "cache"), key: "test" };
    const impossible = await sessionDir(dir, "impossible");
    const delayed = await sessionDir(dir, "delayed");
    await writeFile(
      impossible,
      shutdown("first", "2026-09-22T10:01:00Z", {
        "gpt-5.4": metrics(100, 10, 150, 20, 1),
        "gpt-5.6": metrics(100, 10, 80, 30, 1),
      }) + "\n",
    );
    await writeFile(
      delayed,
      shutdown("first", "2026-09-22T10:01:00Z", {
        "gpt-5.4": metrics(100, 10, 50, 0, 1),
      }) + "\n",
    );
    const scanner = new CliUsageScanner(dir, cache);
    await scanner.poll(() => "project");
    const individual = scanner.calls.get("cli:impossible:first:gpt-5.4")!;
    assert.equal(individual.input, 100);
    assert.equal(individual.cacheRead, undefined);
    assert.equal(individual.cacheWrite, 20);
    const combined = scanner.calls.get("cli:impossible:first:gpt-5.6")!;
    assert.equal(combined.cacheRead, undefined);
    assert.equal(combined.cacheWrite, undefined);
    await appendFile(
      delayed,
      shutdown("second", "2026-09-22T10:02:00Z", {
        "gpt-5.4": metrics(150, 15, 140, 0, 2),
      }) + "\n",
    );
    const restarted = new CliUsageScanner(dir, cache);
    await restarted.poll(() => "project");
    const delta = restarted.calls.get("cli:delayed:second:gpt-5.4")!;
    assert.equal(delta.input, 50);
    assert.equal(delta.cacheRead, undefined);
    assert.equal(totals([...restarted.calls.values()]).cacheRead, 50);
    const fresh = new CliUsageScanner(dir);
    await fresh.poll(() => "project");
    const byId = (a: { id: string }, b: { id: string }) =>
      a.id.localeCompare(b.id);
    assert.deepEqual(
      [...restarted.calls.values()].sort(byId),
      [...fresh.calls.values()].sort(byId),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("late YAML cannot backfill explicitly cleared intervals from a later resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-cleared-interval-"));
  try {
    const file = await sessionDir(dir, "resumed");
    const cache = { directory: join(dir, "cache"), key: "test" };
    const resolver = (cwd: string) =>
      cwd === "/work/A"
        ? "project-a"
        : cwd === "/work/B"
          ? "project-b"
          : undefined;
    await writeFile(
      file,
      [
        start("/work/A"),
        shutdown("first", "2026-09-22T10:01:00Z", {
          "gpt-5.4": metrics(100, 10, 0, 0, 1),
        }),
        JSON.stringify({
          type: "session.resume",
          data: { context: { cwd: null } },
        }),
        shutdown("cleared", "2026-09-22T10:02:00Z", {
          "gpt-5.4": metrics(200, 20, 0, 0, 2),
        }),
      ].join("\n") + "\n",
    );
    const scanner = new CliUsageScanner(dir, cache);
    await scanner.poll(resolver);
    assert.equal(
      scanner.calls.get("cli:resumed:cleared:gpt-5.4")!.projectId,
      CLI_PROJECT_ID,
    );
    await appendFile(
      file,
      [
        JSON.stringify({
          type: "session.resume",
          data: { context: { cwd: "/work/B" } },
        }),
        shutdown("recovered", "2026-09-22T10:03:00Z", {
          "gpt-5.4": metrics(300, 30, 0, 0, 3),
        }),
      ].join("\n") + "\n",
    );
    await scanner.poll(resolver);
    await writeFile(
      join(dir, "resumed", "workspace.yaml"),
      "client_name: copilot-intellij\ncwd: /work/A\n",
    );
    await scanner.poll(resolver);
    assert.equal(
      scanner.calls.get("cli:resumed:first:gpt-5.4")!.projectId,
      "project-a",
    );
    assert.equal(
      scanner.calls.get("cli:resumed:cleared:gpt-5.4")!.projectId,
      JETBRAINS_PROJECT_ID,
    );
    assert.equal(
      scanner.calls.get("cli:resumed:recovered:gpt-5.4")!.projectId,
      "project-b",
    );
    const restarted = new CliUsageScanner(dir, cache);
    await restarted.poll(resolver);
    assert.deepEqual(
      [...restarted.calls.values()],
      [...scanner.calls.values()],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a model reset before the session-total reset is not counted twice across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-reset-order-"));
  try {
    const file = await sessionDir(dir, "reset-order");
    const cache = { directory: join(dir, "cache"), key: "test" };
    await writeFile(
      file,
      [
        totalShutdown(
          "old-run",
          "2026-09-22T10:01:00Z",
          200_000_000_000,
          "gpt-5.4",
          {
            "gpt-5.4": priced(1000, 100, 10, 100_000_000_000),
          },
        ),
        shutdown("model-reset", "2026-09-22T10:02:00Z", {
          "gpt-5.4": priced(500, 50, 5, 50_000_000_000),
        }),
      ].join("\n") + "\n",
    );
    const initial = new CliUsageScanner(dir, cache);
    await initial.poll(() => "project");
    assert.equal(sessionUsd(initial), 2.5);
    await appendFile(
      file,
      [
        totalShutdown(
          "total-reset",
          "2026-09-22T10:03:00Z",
          50_000_000_000,
          "gpt-5.4",
          {
            "gpt-5.4": priced(500, 50, 5, 50_000_000_000),
          },
        ),
        checkpoint(
          "checkpoint",
          "2026-09-22T10:04:00Z",
          80_000_000_000,
          "gpt-5.4",
        ),
        shutdown("later-model", "2026-09-22T10:05:00Z", {
          "gpt-5.4": priced(800, 80, 8, 80_000_000_000),
        }),
      ].join("\n") + "\n",
    );
    const restarted = new CliUsageScanner(dir, cache);
    await restarted.poll(() => "project");
    assert.equal(sessionUsd(restarted), 2.8);
    assert.equal(totals([...restarted.calls.values()]).input, 1800);
    assert.equal(totals([...restarted.calls.values()]).calls, 18);
    const fresh = new CliUsageScanner(dir);
    await fresh.poll(() => "project");
    assert.deepEqual([...restarted.calls.values()], [...fresh.calls.values()]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("late YAML uses the original workspace cwd for intervals before a resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-original-workspace-"));
  try {
    const file = await sessionDir(dir, "original");
    const cache = { directory: join(dir, "cache"), key: "test" };
    const resolver = (cwd: string) =>
      cwd === "/work/A"
        ? "project-a"
        : cwd === "/work/B"
          ? "project-b"
          : undefined;
    await writeFile(
      file,
      shutdown("first", "2026-09-22T10:01:00Z", {
        "gpt-5.4": metrics(100, 10, 0, 0, 1),
      }) + "\n",
    );
    const scanner = new CliUsageScanner(dir, cache);
    await scanner.poll(resolver);
    await appendFile(
      file,
      [
        JSON.stringify({
          type: "session.resume",
          data: { context: { cwd: "/work/B" } },
        }),
        shutdown("later", "2026-09-22T10:02:00Z", {
          "gpt-5.4": metrics(200, 20, 0, 0, 2),
        }),
      ].join("\n") + "\n",
    );
    await scanner.poll(resolver);
    await writeFile(
      join(dir, "original", "workspace.yaml"),
      "client_name: copilot-intellij\ncwd: /work/A\n",
    );
    await scanner.poll(resolver);
    assert.equal(
      scanner.calls.get("cli:original:first:gpt-5.4")!.projectId,
      "project-a",
    );
    assert.equal(
      scanner.calls.get("cli:original:later:gpt-5.4")!.projectId,
      "project-b",
    );
    const restarted = new CliUsageScanner(dir, cache);
    await restarted.poll(resolver);
    assert.deepEqual(
      [...restarted.calls.values()],
      [...scanner.calls.values()],
    );
    const fresh = new CliUsageScanner(dir);
    await fresh.poll(resolver);
    assert.deepEqual([...fresh.calls.values()], [...scanner.calls.values()]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI timestamps reject pre-epoch and non-string dates while preserving epoch zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-epoch-"));
  try {
    const file = await sessionDir(dir, "epoch");
    const cache = { directory: join(dir, "cache"), key: "test" };
    const events = [
      "1969-12-31T23:59:59Z",
      0,
      ["1970-01-01T00:00:00Z"],
      "1970-01-01T00:00:00Z",
    ].map((timestamp, index) =>
      JSON.stringify({
        type: "session.shutdown",
        id: `date-${index}`,
        timestamp,
        data: { modelMetrics: { "gpt-5.4": metrics(100, 10, 0, 0, 1) } },
      }),
    );
    await writeFile(file, events.join("\n") + "\n");
    const scanner = new CliUsageScanner(dir, cache);
    await scanner.poll(() => "project");
    assert.equal(scanner.skippedLines, 3);
    assert.equal(scanner.calls.size, 1);
    assert.equal(scanner.calls.get("cli:epoch:date-3:gpt-5.4")!.timestamp, 0);
    const restarted = new CliUsageScanner(dir, cache);
    await restarted.poll(() => "project");
    assert.deepEqual(
      [...restarted.calls.values()],
      [...scanner.calls.values()],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a newly known cumulative model cost establishes checkpoint coverage without pricing the unknown interval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-known-cost-coverage-"));
  try {
    const file = await sessionDir(dir, "known-coverage");
    const cache = { directory: join(dir, "cache"), key: "test" };
    await writeFile(
      file,
      [
        shutdown("unknown", "2026-09-22T10:01:00Z", {
          "gpt-5.4": priced(100, 10, 1, undefined),
        }),
        shutdown("newly-known", "2026-09-22T10:02:00Z", {
          "gpt-5.4": priced(200, 20, 2, 100_000_000_000),
        }),
        checkpoint(
          "covered",
          "2026-09-22T10:03:00Z",
          100_000_000_000,
          "gpt-5.4",
        ),
      ].join("\n") + "\n",
    );
    const initial = new CliUsageScanner(dir, cache);
    await initial.poll(() => "project");
    assert.equal(
      initial.calls.get("cli:known-coverage:newly-known:gpt-5.4")!.nanoAiu,
      undefined,
    );
    assert.equal(
      initial.calls.get("cli:known-coverage:newly-known:gpt-5.4")!
        .costIncludedInSessionTotal,
      true,
    );
    assert.equal(sessionUsd(initial), 1);
    await appendFile(
      file,
      shutdown("later", "2026-09-22T10:04:00Z", {
        "gpt-5.4": priced(300, 30, 3, 150_000_000_000),
      }) + "\n",
    );
    const restarted = new CliUsageScanner(dir, cache);
    await restarted.poll(() => "project");
    assert.equal(
      restarted.calls.get("cli:known-coverage:later:gpt-5.4")!.nanoAiu,
      50_000_000_000,
    );
    assert.equal(sessionUsd(restarted), 1.5);
    const fresh = new CliUsageScanner(dir);
    await fresh.poll(() => "project");
    assert.deepEqual(
      JSON.parse(JSON.stringify([...restarted.calls.values()])),
      JSON.parse(JSON.stringify([...fresh.calls.values()])),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ambiguous workspace metadata cannot select the first project's cwd or client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-workspace-ambiguity-"));
  try {
    const variants = [
      "cwd: /work/first\ncwd: /work/second\nclient_name: copilot-intellij\n",
      "cwd: /work/first\nmetadata:\n  'cwd': /work/second\nclient_name: copilot-intellij\n",
      "client_name: copilot-intellij\nclient_name: copilot-cli\ncwd: /work/first\n",
      'cwd: /work/first\n"c\\u0077d": /work/second\nclient_name: copilot-intellij\n',
    ];
    for (let i = 0; i < variants.length; i++) {
      const id = `ambiguous-${i}`;
      const file = await sessionDir(dir, id);
      await writeFile(
        file,
        shutdown("usage", "2026-09-22T10:01:00Z", {
          "gpt-5.4": metrics(100, 10, 0, 0, 1),
        }) + "\n",
      );
      await writeFile(join(dir, id, "workspace.yaml"), variants[i]!);
    }
    const scanner = new CliUsageScanner(dir);
    await scanner.poll(() => "first-project");
    assert.equal(scanner.calls.size, variants.length);
    assert.ok(
      [...scanner.calls.values()].every(
        (call) => call.projectId === CLI_PROJECT_ID && call.source === "cli",
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace metadata supports nested quoted keys, escaped strings and literal path quotes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-workspace-quotes-"));
  try {
    const variants: Array<[string, string]> = [
      [
        'metadata:\n  "client_name": "copilot-intellij"\n  "cwd": "C:\\\\work\\\\project" # comment\n',
        "C:\\work\\project",
      ],
      [
        "metadata:\n  client_name: 'copilot-intellij'\n  cwd: '/work/it''s # quoted' # comment\n",
        "/work/it's # quoted",
      ],
      [
        "client_name: copilot-intellij\ncwd: /work/it's#literal # comment\n",
        "/work/it's#literal",
      ],
      [
        "client_name: copilot-intellij\ncwd: /work/repeated\nmetadata:\n  cwd: /work/repeated\n",
        "/work/repeated",
      ],
    ];
    for (let i = 0; i < variants.length; i++) {
      const id = `quoted-${i}`;
      const file = await sessionDir(dir, id);
      await writeFile(
        file,
        shutdown("usage", "2026-09-22T10:01:00Z", {
          "gpt-5.4": metrics(100, 10, 0, 0, 1),
        }) + "\n",
      );
      await writeFile(join(dir, id, "workspace.yaml"), variants[i]![0]);
    }
    const scanner = new CliUsageScanner(dir);
    await scanner.poll((cwd) => variants.find(([, path]) => path === cwd)?.[1]);
    assert.deepEqual(
      [...scanner.calls.values()]
        .map((call) => [call.source, call.projectId])
        .sort(),
      variants.map(([, path]) => ["jetbrains", path]).sort(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit invalid resume cwd clears prior attribution through cached restart and late workspace metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cli-cleared-cwd-"));
  try {
    const cache = { directory: join(dir, "cache"), key: "test" };
    for (const [id, value] of [
      ["null", null],
      ["number", 42],
    ] as const) {
      const file = await sessionDir(dir, id);
      await writeFile(
        join(dir, id, "workspace.yaml"),
        "client_name: copilot-intellij\ncwd: /work/first\n",
      );
      await writeFile(
        file,
        [
          shutdown("first", "2026-09-22T10:01:00Z", {
            "gpt-5.4": metrics(100, 10, 0, 0, 1),
          }),
          JSON.stringify({
            type: "session.resume",
            data: { context: { cwd: value } },
          }),
          shutdown("cleared", "2026-09-22T10:02:00Z", {
            "gpt-5.4": metrics(200, 20, 0, 0, 2),
          }),
        ].join("\n") + "\n",
      );
    }
    const lateFile = await sessionDir(dir, "late");
    await writeFile(
      lateFile,
      [
        start("/work/first"),
        JSON.stringify({
          type: "session.resume",
          data: { context: { cwd: null } },
        }),
        shutdown("cleared", "2026-09-22T10:02:00Z", {
          "gpt-5.4": metrics(100, 10, 0, 0, 1),
        }),
      ].join("\n") + "\n",
    );
    const resolver = (cwd: string) =>
      cwd === "/work/first" ? "first-project" : undefined;
    const scanner = new CliUsageScanner(dir, cache);
    await scanner.poll(resolver);
    for (const id of ["null", "number"]) {
      assert.equal(
        scanner.calls.get(`cli:${id}:first:gpt-5.4`)!.projectId,
        "first-project",
      );
      assert.equal(
        scanner.calls.get(`cli:${id}:cleared:gpt-5.4`)!.projectId,
        JETBRAINS_PROJECT_ID,
      );
    }
    await writeFile(
      join(dir, "late", "workspace.yaml"),
      "client_name: copilot-intellij\ncwd: /work/first\n",
    );
    for (const id of ["null", "number", "late"])
      await appendFile(
        join(dir, id, "events.jsonl"),
        shutdown("after-restart", "2026-09-22T10:03:00Z", {
          "gpt-5.4": metrics(300, 30, 0, 0, 3),
        }) + "\n",
      );
    const restarted = new CliUsageScanner(dir, cache);
    await restarted.poll(resolver);
    for (const id of ["null", "number", "late"]) {
      assert.equal(
        restarted.calls.get(`cli:${id}:cleared:gpt-5.4`)!.projectId,
        JETBRAINS_PROJECT_ID,
      );
      assert.equal(
        restarted.calls.get(`cli:${id}:after-restart:gpt-5.4`)!.projectId,
        JETBRAINS_PROJECT_ID,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
