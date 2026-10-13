import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callCost,
  costs,
  costLabel,
  costDescription,
  formatUsd,
  PRICING_DATE,
} from "../src/core/pricing";
import { exportCsv, filterCalls } from "../src/core/analytics";
import { parseSpan } from "../src/core/parser";
import { storedSpan } from "../src/core/collector";
import type { UsageCall } from "../src/core/types";

const call = (extra: Partial<UsageCall> = {}): UsageCall => ({
  id: `${"a".repeat(32)}:${"b".repeat(16)}`,
  projectId: "a",
  timestamp: Date.parse("2026-09-22T10:00:00Z"),
  model: "Claude Sonnet 4.6",
  input: 1_000_000,
  output: 100_000,
  cacheRead: 600_000,
  cacheWrite: 100_000,
  durationMs: 1_000,
  failed: false,
  ...extra,
});

test("Copilot-reported nano-AIU wins over estimates, including explicit zero and unknown models", () => {
  assert.deepEqual(callCost(call({ nanoAiu: 125_000_000_000 })), {
    source: "reported",
    usd: 1.25,
  });
  assert.deepEqual(
    callCost(call({ model: "unknown", input: undefined, nanoAiu: 0 })),
    { source: "reported", usd: 0 },
  );
  assert.equal(callCost(call({ nanoAiu: -1 })).source, "estimated");
  assert.equal(
    callCost(call({ nanoAiu: Number.MAX_SAFE_INTEGER + 1 })).source,
    "estimated",
  );
});

test("cache reads and writes are priced once as subsets of total input", () => {
  // 300K uncached @3 + 600K reads @.3 + 100K writes @3.75 + 100K output @15.
  assert.equal(callCost(call()).usd, 2.955);
  assert.equal(callCost(call()).assumedCache, false);
  assert.equal(callCost(call({ cacheWrite: undefined })).assumedCache, true);
  assert.equal(callCost(call({ cacheRead: 1_000_001 })).usd, undefined);
  assert.equal(callCost(call({ cacheRead: 900_001 })).usd, undefined);
});

test("long-context rates switch per request strictly above the model threshold", () => {
  const base = call({
    model: "GPT-5.4",
    input: 272_000,
    output: 10_000,
    cacheRead: 100_000,
    cacheWrite: 0,
  });
  assert.equal(callCost(base).usd, 0.605);
  assert.equal(callCost({ ...base, input: 272_001 }).usd, 1.135005);
  assert.equal(
    callCost(call({ model: "gpt-5.4", cacheWrite: 1 })).usd,
    undefined,
  );
});

test("aggregated CLI tokens cannot select a per-request long-context tier", () => {
  const aggregate = call({
    source: "cli",
    model: "GPT-5.4",
    input: 500_000,
    output: 10_000,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 2,
  });
  assert.deepEqual(callCost(aggregate), {
    source: "unavailable",
    reason: "Per-request context unknown",
  });
  assert.equal(callCost({ ...aggregate, input: 200_000 }).source, "estimated");
  assert.equal(callCost({ ...aggregate, requests: 1 }).source, "estimated");
  assert.equal(callCost({ ...aggregate, nanoAiu: 100_000_000_000 }).usd, 1);
});

test("exact documented aliases resolve without guessing unknown models or modes", () => {
  for (const model of [
    "Claude Sonnet 4.6",
    "claude-sonnet-4-6",
    "claude-4.6-sonnet",
    "claude-sonnet-4-6-20260217",
    "claude-sonnet-4-20250514",
  ])
    assert.equal(callCost(call({ model })).usd, 2.955);
  for (const model of [
    "gpt-5.4-turbo",
    "custom/claude-sonnet-4.6",
    "claude-opus-4.8-fast-new",
    "Unknown model",
    "__proto__",
    "constructor",
  ])
    assert.equal(callCost(call({ model })).usd, undefined);
  assert.equal(
    callCost(call({ model: "Claude Opus 4.8 (fast mode) (preview)" })).usd,
    9.85,
  );
});

test("new Copilot model rates match the September 23 pricing table", () => {
  assert.equal(callCost(call({ model: "GPT-6 Luna" })).usd, 0.172);
  assert.equal(callCost(call({ model: "GPT-6 Sol" })).usd, 3.44);
  assert.equal(callCost(call({ model: "Claude Opus 5.5" })).usd, 3.82);
});

test("unknown usage stays unavailable while known zero costs remain zero", () => {
  assert.equal(callCost(call({ input: undefined })).usd, undefined);
  assert.equal(callCost(call({ output: NaN })).usd, undefined);
  assert.equal(costs([]).usd, undefined);
  assert.equal(costs([call({ model: "unpriced" })]).usd, undefined);
  assert.equal(costLabel(costs([call({ nanoAiu: 0 })])), "$0.00");
  assert.equal(formatUsd(0.000001), "<$0.0001");
  assert.equal(formatUsd(0.00234), "$0.0023");
});

test("expired promotional prices are not silently reused", () => {
  const flash = call({ model: "Gemini 3.8 Flash", cacheWrite: 0 });
  assert.equal(callCost(flash).source, "estimated");
  assert.equal(
    callCost({ ...flash, timestamp: Date.UTC(2027, 0, 1) }).usd,
    undefined,
  );
  assert.equal(
    callCost({ ...flash, timestamp: Date.UTC(2027, 0, 1), nanoAiu: 1e11 }).usd,
    1,
  );
});

test("cost summaries expose mixed sources, partial coverage, and project/date filtering", () => {
  const now = Date.parse("2026-09-22T12:00:00Z");
  const calls = [
    call({ nanoAiu: 1e11 }),
    call(),
    call({ model: "unpriced" }),
    call({ projectId: "b", nanoAiu: 9e11 }),
    call({ timestamp: now - 40 * 864e5, nanoAiu: 9e11 }),
  ];
  const summary = costs(filterCalls(calls, "a", 7, now));
  assert.equal(summary.usd, 3.955);
  assert.equal(summary.reportedCalls, 1);
  assert.equal(summary.estimatedCalls, 1);
  assert.equal(summary.unpricedCalls, 1);
  assert.equal(costLabel(summary), "≈$3.96+");
});

test("cost fields survive sanitization and invalid values or cumulative totals do not", () => {
  const parsed = parseSpan(storedSpan(call({ nanoAiu: 1e11 })), "a")!;
  assert.equal(parsed.cacheWrite, 100_000);
  assert.equal(parsed.nanoAiu, 1e11);
  assert.equal(callCost(parsed).usd, 1);
  const legacy = storedSpan(call());
  const newKey = {
    ...legacy,
    attributes: {
      ...legacy.attributes,
      "gen_ai.usage.cache_creation.input_tokens": undefined,
      "gen_ai.usage.cache_write.input_tokens": 123,
      "copilot_chat.copilot_usage_nano_aiu": "-1",
      "copilot_chat.total_cost_usd": 900,
    },
  };
  const result = parseSpan(newKey, "a")!;
  assert.equal(result.cacheWrite, 123);
  assert.equal(result.nanoAiu, undefined);
  assert.ok(!JSON.stringify(storedSpan(result)).includes("total_cost_usd"));
  assert.equal(
    parseSpan(
      {
        ...newKey,
        attributes: {
          ...newKey.attributes,
          "gen_ai.operation.name": "invoke_agent",
        },
      },
      "a",
    ),
    undefined,
  );
});

test("CSV exports cost provenance and leaves unavailable amounts empty", () => {
  const csv = exportCsv([
    call({ nanoAiu: 1e11 }),
    call(),
    call({ model: "unpriced" }),
  ]);
  assert.ok(
    csv.includes('"cost_usd","cost_source","cost_note","price_table_date"'),
  );
  assert.ok(csv.includes('"1","reported"'));
  assert.ok(csv.includes(`"2.955","estimated","","${PRICING_DATE}"`));
  assert.ok(csv.includes('"","unavailable","No verified model price"'));
});

test("session-covered unknown costs stay unmeasured and are excluded from summed prices", () => {
  const covered = {
    ...call({ source: "cli", requests: 2 }),
    costIncludedInSessionTotal: true as const,
  };
  assert.equal(covered.nanoAiu, undefined);
  assert.deepEqual(callCost(covered), {
    source: "included",
    reason: "Included in reported session total",
  });
  const onlyCovered = costs([covered]);
  assert.equal(onlyCovered.usd, undefined);
  assert.equal(onlyCovered.includedCalls, 1);
  assert.equal(onlyCovered.unpricedCalls, 0);
  assert.equal(onlyCovered.estimatedCalls, 0);
  assert.equal(costLabel(onlyCovered), "Included");
  assert.ok(
    costDescription(onlyCovered).includes(
      "1 included in reported session totals",
    ),
  );
  const total = call({
    source: "cli",
    nanoAiu: 150_000_000_000,
    requests: 0,
    input: 0,
    output: 0,
  });
  const mixed = costs([covered, total]);
  assert.equal(mixed.usd, 1.5);
  assert.equal(mixed.includedCalls, 1);
  assert.equal(mixed.reportedCalls, 1);
  assert.equal(costLabel(mixed), "$1.50");
  assert.equal(costLabel(costs([covered, call({ model: "unknown" })])), "—");
  assert.equal(
    callCost({ ...covered, source: "chat-history" }).source,
    "estimated",
    "only CLI session costs use the marker",
  );
  assert.equal(
    callCost({ ...covered, nanoAiu: 0 }).source,
    "reported",
    "an explicit measured cost still wins",
  );
});
