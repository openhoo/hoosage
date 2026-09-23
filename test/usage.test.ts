import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  appendFile,
  writeFile,
  rename,
  rm,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLine, parseSpan } from "../src/core/parser";
import { UsageTailer } from "../src/core/tailer";
import {
  totals,
  filterCalls,
  daily,
  exportCsv,
  groupSessions,
  startOfRange,
} from "../src/core/analytics";
import { startCollector, storedSpan } from "../src/core/collector";
import { costs } from "../src/core/pricing";
import {
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter as JsonExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { gzipSync } from "node:zlib";

function span(extra: Record<string, unknown> = {}) {
  const start = Date.now() - 5000;
  return {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    startTimeUnixNano: String(BigInt(start) * 1_000_000n),
    endTimeUnixNano: String(BigInt(start + 1000) * 1_000_000n),
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "test-model",
      "gen_ai.conversation.id": "test-session",
      "gen_ai.usage.input_tokens": 1200,
      "gen_ai.usage.output_tokens": 300,
      "gen_ai.usage.cache_read.input_tokens": 600,
    },
    ...extra,
  };
}

test("counts only chat spans; does not sum agent totals, logs or metrics", () => {
  assert.equal(parseSpan(span(), "a")?.input, 1200);
  assert.equal(
    parseSpan(
      span({
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.usage.input_tokens": 1200,
        },
      }),
      "a",
    ),
    undefined,
  );
  assert.deepEqual(
    parseLine(
      JSON.stringify({
        body: "gen_ai.client.inference.operation.details",
        attributes: span().attributes,
      }),
      "a",
    ),
    [],
  );
  assert.deepEqual(parseLine(JSON.stringify({ scopeMetrics: [] }), "a"), []);
});

test("missing and invalid token counts remain unknown; zero is a real measurement", () => {
  const s = span();
  const call = parseSpan(
    {
      ...s,
      attributes: {
        ...s.attributes,
        "gen_ai.usage.input_tokens": -1,
        "gen_ai.usage.output_tokens": 0,
      },
    },
    "a",
  )!;
  assert.equal(call.input, undefined);
  assert.equal(call.output, 0);
  assert.equal(totals([call]).missingUsage, 1);
  for (const invalid of [
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "NaN",
    "",
    null,
    true,
  ])
    assert.equal(
      parseSpan(
        {
          ...s,
          attributes: { ...s.attributes, "gen_ai.usage.input_tokens": invalid },
        },
        "a",
      )?.input,
      undefined,
    );
});

test("invalid or unfinished spans cannot pollute totals", () => {
  for (const extra of [
    { traceId: "fake" },
    { spanId: "" },
    { endTimeUnixNano: undefined },
    { endTimeUnixNano: "0" },
  ])
    assert.equal(parseSpan(span(extra), "a"), undefined);
});

test("normalizes SDK time tuples, OTLP attributes, and error codes", () => {
  const now = Math.floor(Date.now() / 1000) - 30;
  const s = span({
    traceId: undefined,
    spanId: undefined,
    _spanContext: { traceId: "a".repeat(32), spanId: "b".repeat(16) },
    startTime: [now, 250_000_000],
    endTime: [now + 1, 500_000_000],
    attributes: [
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: "123" } },
    ],
    status: { code: "STATUS_CODE_ERROR" },
  });
  const call = parseSpan(s, "a")!;
  assert.equal(call.input, 123);
  assert.equal(call.durationMs, 1250);
  assert.equal(call.failed, true);
});

test("privacy allowlist discards prompts, file paths, resource metadata, and code", () => {
  const s = span();
  const secret = "NEVER_PERSIST_THIS";
  const parsed = parseSpan(
    {
      ...s,
      attributes: {
        ...s.attributes,
        "gen_ai.input.messages": secret,
        "gen_ai.output.messages": secret,
        "github.copilot.git.repository": secret,
      },
      resource: { private: secret },
    },
    "project-a",
  )!;
  assert.ok(!JSON.stringify(storedSpan(parsed)).includes(secret));
  assert.deepEqual(
    Object.keys(parsed).sort(),
    [
      "id",
      "projectId",
      "timestamp",
      "model",
      "sessionId",
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "nanoAiu",
      "durationMs",
      "failed",
    ].sort(),
  );
});

test("incremental reader tolerates partial lines, malformed lines, retries and rotation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-"));
  const path = join(dir, "usage.jsonl");
  try {
    const reader = new UsageTailer(path, "a");
    await reader.poll();
    const row = JSON.stringify(span());
    await writeFile(path, row.slice(0, 70));
    await reader.poll();
    assert.equal(reader.calls.size, 0);
    await appendFile(path, row.slice(70) + "\n" + row + "\n{broken\n");
    await reader.poll();
    assert.equal(reader.calls.size, 1);
    assert.equal(reader.skippedLines, 1);
    await rename(path, path + ".old");
    await writeFile(
      path,
      row + "\n" + JSON.stringify(span({ spanId: "c".repeat(16) })) + "\n",
    );
    await reader.poll();
    assert.equal(reader.calls.size, 2);
    await writeFile(
      path,
      JSON.stringify(span({ spanId: "d".repeat(16) })) + "\n",
    );
    await reader.poll();
    assert.equal(reader.calls.size, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("history diagnostics distinguish unread bytes, non-Chat lines and invalid lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-"));
  const path = join(dir, "usage.jsonl");
  try {
    const pending = JSON.stringify(span()).slice(0, 40);
    const content =
      JSON.stringify(span()) +
      "\n" +
      JSON.stringify({ scopeMetrics: [] }) +
      "\n{broken\n" +
      pending;
    await writeFile(path, content);
    const reader = new UsageTailer(path, "a");
    await reader.poll();
    assert.equal(reader.calls.size, 1);
    assert.equal(reader.readBytes, Buffer.byteLength(content));
    assert.equal(reader.processedLines, 3);
    assert.equal(reader.ignoredLines, 1);
    assert.equal(reader.skippedLines, 1);
    assert.equal(reader.bufferedBytes, Buffer.byteLength(pending));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("oversized lines are skipped without losing the next valid record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-"));
  const path = join(dir, "usage.jsonl");
  try {
    const reader = new UsageTailer(path, "a");
    await writeFile(
      path,
      "x".repeat(5 * 1024 * 1024) + "\n" + JSON.stringify(span()) + "\n",
    );
    await reader.poll();
    await reader.poll();
    assert.equal(reader.calls.size, 1);
    assert.equal(reader.skippedLines, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project filtering, local calendar boundaries and cache accounting are consistent", () => {
  const a = parseSpan(span(), "a")!;
  const b = { ...a, projectId: "b" };
  const now = Date.now();
  assert.equal(totals([a, b]).tokens, 3000);
  assert.equal(totals([a, b]).cacheRead, 1200);
  assert.equal(totals([a, b]).sessions, 2);
  assert.equal(filterCalls([a, b], "a", 7, now).length, 1);
  const midnight = startOfRange(7, now);
  assert.equal(
    filterCalls(
      [
        { ...a, timestamp: midnight - 1 },
        { ...a, timestamp: midnight },
      ],
      "a",
      7,
      now,
    ).length,
    1,
  );
  assert.equal(
    daily([a, b], 7, now).reduce((n, d) => n + d.tokens, 0),
    3000,
  );
});

test("unlinked calls remain separate and session IDs cannot cross projects or sources", () => {
  const base = parseSpan(span(), "a")!;
  const calls = [
    { ...base, id: "shared", sessionId: undefined },
    { ...base, id: "two", sessionId: undefined },
    { ...base, id: "three", sessionId: "shared" },
    { ...base, id: "four", sessionId: "shared" },
    { ...base, id: "five", projectId: "b", sessionId: "shared" },
    { ...base, id: "six", source: "cli" as const, sessionId: "shared" },
  ];
  const groups = groupSessions(calls);
  assert.deepEqual(
    groups.map(([, entries]) => entries.map((entry) => entry.id)).sort(),
    [["shared"], ["two"], ["three", "four"], ["five"], ["six"]].sort(),
  );
});

test("CSV keeps unknown values empty and neutralizes spreadsheet formulas", () => {
  const c = {
    ...parseSpan(span(), "a")!,
    model: '=HYPERLINK("bad")',
    input: undefined,
  };
  const csv = exportCsv([c]);
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes(',"","300",'));
});

for (const [name, Exporter] of [
  ["JSON", JsonExporter],
  ["protobuf", ProtoExporter],
] as const) {
  test(`real OpenTelemetry ${name} exporter reaches the loopback collector and persists accurate usage`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoosage-"));
    const file = join(dir, "usage.jsonl");
    const collector = await startCollector({
      port: 0,
      token: "test-secret",
      projectId: "a",
      file,
    });
    const exporter = new Exporter({
      url: `http://127.0.0.1:${collector.port}/test-secret/v1/traces`,
    });
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    try {
      const request = provider
        .getTracer("copilot-chat")
        .startSpan("chat test", {
          attributes: {
            ...span().attributes,
            "gen_ai.usage.cache_creation.input_tokens": 200,
            "copilot_chat.copilot_usage_nano_aiu": 123_000_000_000,
            "gen_ai.input.messages": "SECRET_PROMPT",
            "github.copilot.git.repository": "PRIVATE_REPO",
          },
        });
      request.end();
      await provider.forceFlush();
      const tailer = new UsageTailer(file, "a");
      await tailer.poll();
      assert.equal(tailer.calls.size, 1);
      assert.equal(totals([...tailer.calls.values()]).tokens, 1500);
      assert.equal(costs([...tailer.calls.values()]).usd, 1.23);
      assert.equal([...tailer.calls.values()][0]?.cacheWrite, 200);
      const persisted = await readFile(file, "utf8");
      assert.ok(!persisted.includes("SECRET_PROMPT"));
      assert.ok(!persisted.includes("PRIVATE_REPO"));
    } finally {
      await provider.shutdown();
      await collector.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("collector rejects browser traffic and wrong project routes; accepts gzip and fails closed on malformed input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-"));
  const file = join(dir, "usage.jsonl");
  const collector = await startCollector({
    port: 0,
    token: "project-token",
    projectId: "a",
    file,
  });
  const url = `http://127.0.0.1:${collector.port}`;
  try {
    assert.equal(
      (await fetch(url + "/wrong/v1/traces", { method: "POST" })).status,
      404,
    );
    assert.equal(
      (
        await fetch(url + "/project-token/v1/traces", {
          method: "POST",
          headers: { origin: "https://example.com" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + "/project-token/v1/traces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{broken",
        })
      ).status,
      400,
    );
    const body = gzipSync(
      JSON.stringify({
        resourceSpans: [{ scopeSpans: [{ spans: [span()] }] }],
      }),
    );
    const response = await fetch(url + "/project-token/v1/traces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 1);
  } finally {
    await collector.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("collector routes a multi-span batch once per window and keeps every call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoosage-"));
  const file = join(dir, "usage.jsonl");
  let routes = 0;
  const collector = await startCollector({
    port: 0,
    token: "batch-token",
    projectId: "host",
    file: "",
    route: async (sessionId) => {
      routes++;
      return sessionId === "window-a" ? { projectId: "a", file } : undefined;
    },
  });
  try {
    const spans = Array.from({ length: 120 }, (_, index) => ({
      ...span(),
      spanId: index.toString(16).padStart(16, "0"),
    }));
    const response = await fetch(
      `http://127.0.0.1:${collector.port}/batch-token/v1/traces`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: [
                  { key: "session.id", value: { stringValue: "window-a" } },
                ],
              },
              scopeSpans: [{ spans }],
            },
          ],
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(routes, 1);
    assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 120);
  } finally {
    await collector.close();
    await rm(dir, { recursive: true, force: true });
  }
});
