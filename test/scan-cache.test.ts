import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CliUsageScanner } from "../src/core/cli";
import { scanChatHistory } from "../src/core/chat-history-import";
import type { ScanCache } from "../src/core/scan-cache";
import type { UsageCall } from "../src/core/types";

const line = (value: Record<string, unknown>) => JSON.stringify(value) + "\n";
const start = (cwd: string) =>
  line({
    type: "session.start",
    id: "start",
    timestamp: "2026-09-22T10:00:00.000Z",
    data: { context: { cwd } },
  });
const shutdown = (id: string, minute: number, input: number, total: number) =>
  line({
    type: "session.shutdown",
    id,
    timestamp: `2026-09-22T10:${String(minute).padStart(2, "0")}:00.000Z`,
    data: {
      currentModel: "gpt-5.5",
      totalNanoAiu: total,
      modelMetrics: {
        "gpt-5.5": {
          usage: { inputTokens: input, outputTokens: input / 10 },
          requests: { count: input / 100 },
          totalNanoAiu: total,
        },
      },
    },
  });

// Stable comparison independent of key order and undefined fields.
const view = (calls: Iterable<UsageCall>) =>
  [...calls]
    .map((call) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(call)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
    )
    .sort();

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cache-"));
  const root = join(dir, "session-state");
  const cache: ScanCache = { directory: join(dir, "cache"), key: "1.0.0" };
  const project = join(dir, "repo");
  const resolve = (cwd: string) => (cwd === project ? "proj" : undefined);
  const session = async (id: string, content: string) => {
    await mkdir(join(root, id), { recursive: true });
    const file = join(root, id, "events.jsonl");
    await writeFile(file, content);
    return file;
  };
  return { dir, root, cache, project, resolve, session };
}

/** Overwrites bytes in place: same file, same size, so only a reader that
 * resumes from its saved position keeps the original entries. */
async function scramble(file: string, length: number) {
  const handle = await open(file, "r+");
  try {
    await handle.write(Buffer.alloc(length, 0x78), 0, length, 0);
  } finally {
    await handle.close();
  }
}

test("a new CLI reader resumes from the cache instead of re-reading", async () => {
  const f = await fixture();
  try {
    const file = await f.session(
      "s1",
      start(f.project) + shutdown("e1", 5, 1000, 300_000_000),
    );
    const first = new CliUsageScanner(f.root, f.cache);
    await first.poll(f.resolve);
    assert.equal(first.calls.size, 1);
    assert.equal((await readdir(f.cache.directory)).length, 1);

    const size = (await stat(file)).size;
    await scramble(file, size - 1);
    await appendFile(file, shutdown("e2", 9, 3000, 700_000_000));

    const second = new CliUsageScanner(f.root, f.cache);
    await second.poll(f.resolve);
    assert.equal(second.caughtUp, true);
    assert.equal(second.skippedLines, 0);
    const calls = [...second.calls.values()];
    assert.deepEqual(
      calls.map((c) => [c.id, c.projectId, c.input, c.nanoAiu]),
      [
        ["cli:s1:e1:gpt-5.5", "proj", 1000, 300_000_000],
        ["cli:s1:e2:gpt-5.5", "proj", 2000, 400_000_000],
      ],
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("cached CLI results match a full read, including split UTF-8 lines", async () => {
  const f = await fixture();
  try {
    const renamed = line({
      type: "session.model_change",
      id: "m1",
      timestamp: "2026-09-22T10:01:00.000Z",
      data: { newModel: "gpt-5.5 “größer”" },
    });
    const bytes = Buffer.from(renamed);
    // Cut inside a multi-byte character of an unfinished line.
    const cut = bytes.indexOf(Buffer.from("“")) + 1;
    const file = await f.session(
      "s1",
      start(f.project) + shutdown("e1", 5, 1000, 300_000_000),
    );
    await appendFile(file, bytes.subarray(0, cut));
    const first = new CliUsageScanner(f.root, f.cache);
    await first.poll(f.resolve);

    await appendFile(file, bytes.subarray(cut));
    await appendFile(
      file,
      line({
        type: "session.usage_checkpoint",
        id: "c1",
        timestamp: "2026-09-22T10:06:00.000Z",
        data: { totalNanoAiu: 500_000_000 },
      }),
    );
    const resumed = new CliUsageScanner(f.root, f.cache);
    await resumed.poll(f.resolve);
    const full = new CliUsageScanner(f.root);
    await full.poll(f.resolve);
    assert.deepEqual(view(resumed.calls.values()), view(full.calls.values()));
    assert.equal(
      resumed.calls.get("cli:s1:c1:gpt-5.5 “größer”")?.nanoAiu,
      200_000_000,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("the CLI cache is ignored for another version and after truncation", async () => {
  const f = await fixture();
  try {
    const file = await f.session(
      "s1",
      start(f.project) + shutdown("e1", 5, 1000, 300_000_000),
    );
    const first = new CliUsageScanner(f.root, f.cache);
    await first.poll(f.resolve);

    await scramble(file, 20);
    const updated = new CliUsageScanner(f.root, { ...f.cache, key: "1.0.1" });
    await updated.poll(f.resolve);
    assert.equal(updated.skippedLines, 1, "re-read the scrambled file");

    await truncate(file, 0);
    await appendFile(file, start(f.project) + shutdown("e9", 7, 500, 1));
    const truncated = new CliUsageScanner(f.root, {
      ...f.cache,
      key: "1.0.1",
    });
    await truncated.poll(f.resolve);
    assert.deepEqual([...truncated.calls.keys()], ["cli:s1:e9:gpt-5.5"]);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("removed sessions and corrupt caches do not leave stale usage", async () => {
  const f = await fixture();
  try {
    await f.session("s1", start(f.project) + shutdown("e1", 5, 1000, 1));
    await f.session("s2", start(f.project) + shutdown("e2", 6, 1000, 1));
    const scanner = new CliUsageScanner(f.root, f.cache);
    await scanner.poll(f.resolve);
    assert.equal(scanner.calls.size, 2);

    await rm(join(f.root, "s2"), { recursive: true });
    const restored = new CliUsageScanner(f.root, f.cache);
    await restored.poll(f.resolve);
    assert.deepEqual([...restored.calls.keys()], ["cli:s1:e1:gpt-5.5"]);
    await scanner.poll(f.resolve);
    assert.deepEqual([...scanner.calls.keys()], ["cli:s1:e1:gpt-5.5"]);

    const [name] = await readdir(f.cache.directory);
    await writeFile(join(f.cache.directory, name!), "{not json");
    const fresh = new CliUsageScanner(f.root, f.cache);
    await fresh.poll(f.resolve);
    assert.deepEqual([...fresh.calls.keys()], ["cli:s1:e1:gpt-5.5"]);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("unchanged Chat transcripts are served from the cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-cache-chat-"));
  try {
    const user = join(dir, "User");
    const globalStorage = join(user, "globalStorage", "openhoo.hoosage");
    const sessions = join(user, "workspaceStorage", "w1", "chatSessions");
    await mkdir(sessions, { recursive: true });
    await mkdir(globalStorage, { recursive: true });
    await writeFile(
      join(user, "workspaceStorage", "w1", "workspace.json"),
      JSON.stringify({ folder: pathToFileURL(join(dir, "repo")).toString() }),
    );
    const transcript = (output: number) =>
      JSON.stringify({
        sessionId: "s1",
        requests: [
          {
            requestId: "r1",
            timestamp: 1000,
            modelId: "copilot/gpt-5.5",
            completionTokens: output,
            result: { metadata: { toolCallRounds: [{}] } },
          },
        ],
      });
    const file = join(sessions, "s1.json");
    await writeFile(file, transcript(100));
    await utimes(file, 1_700_000_000, 1_700_000_000);
    const cache: ScanCache = {
      directory: join(dir, "cache"),
      key: "1.0.0",
    };
    const first = await scanChatHistory(globalStorage, cache);
    assert.equal(first.calls[0]!.output, 100);

    // Same size and modification time: the cached result is used.
    await writeFile(file, transcript(200));
    await utimes(file, 1_700_000_000, 1_700_000_000);
    const cached = await scanChatHistory(globalStorage, cache);
    assert.deepEqual(cached, first);

    await writeFile(file, transcript(3000));
    const changed = await scanChatHistory(globalStorage, cache);
    assert.equal(changed.calls[0]!.output, 3000);
    assert.equal((await scanChatHistory(globalStorage)).calls[0]!.output, 3000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
