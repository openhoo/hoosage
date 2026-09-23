import type { UsageCall } from "./types";

export const PRICING_DATE = "2026-09-22";
export const PRICING_SOURCE =
  "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing";

// USD per million tokens, from GitHub's Copilot table (not provider API prices).
// Historical calls without reported cost use this dated snapshot, not historical
// billing rates. Unknown model variants deliberately have no fallback rate.
interface Rate {
  input: number;
  cached: number;
  write?: number;
  output: number;
  threshold?: number;
  long?: Rate;
  validThrough?: number;
}
const rate = (
  input: number,
  cached: number,
  output: number,
  write?: number,
): Rate => ({ input, cached, output, write });
const tier = (base: Rate, threshold: number, long: Rate): Rate => ({
  ...base,
  threshold,
  long,
});
const promotionalFlash = {
  ...rate(0.75, 0.075, 3.75),
  validThrough: Date.UTC(2027, 0, 1) - 1,
};
const rates: Record<string, Rate> = {
  "gpt-5-mini": rate(0.25, 0.025, 2),
  "gpt-5.3-codex": rate(1.75, 0.175, 14),
  "gpt-5.4": tier(rate(2.5, 0.25, 15), 272_000, rate(5, 0.5, 22.5)),
  "gpt-5.4-mini": rate(0.75, 0.075, 4.5),
  "gpt-5.4-nano": rate(0.2, 0.02, 1.25),
  "gpt-5.5": tier(rate(5, 0.5, 30), 272_000, rate(10, 1, 45)),
  "gpt-5.6-luna": tier(
    rate(0.2, 0.02, 1.2, 0.25),
    200_000,
    rate(0.4, 0.04, 1.8, 0.5),
  ),
  "gpt-5.6-sol": tier(rate(4, 0.4, 20, 5), 272_000, rate(8, 0.8, 30, 10)),
  "gpt-5.6-terra": tier(rate(2, 0.2, 12, 2.5), 272_000, rate(4, 0.4, 18, 5)),
  "gpt-6-astra": tier(rate(10, 1, 50, 12.5), 272_000, rate(20, 2, 75, 25)),
  "claude-haiku-4.5": rate(1, 0.1, 5, 1.25),
  "claude-sonnet-4": rate(3, 0.3, 15, 3.75),
  "claude-sonnet-4.6": rate(3, 0.3, 15, 3.75),
  "claude-opus-4.7": rate(5, 0.5, 25, 6.25),
  "claude-opus-4.8": rate(5, 0.5, 25, 6.25),
  "claude-opus-5": rate(5, 0.5, 25, 6.25),
  "claude-sonnet-5": rate(2, 0.2, 10, 2.5),
  "claude-opus-4.8-fast": rate(10, 1, 50, 12.5),
  "claude-fable-5": rate(10, 1, 50, 12.5),
  "claude-fable-5.1": rate(10, 0.25, 50, 12.5),
  "gemini-3.5-flash": rate(1.5, 0.15, 9),
  "gemini-3.6-flash": promotionalFlash,
  "gemini-3.7-flash": promotionalFlash,
  "gemini-3.8-flash": promotionalFlash,
  "mai-code-1.1-flash": rate(0.2, 0.02, 1.2),
  "grok-4.5": tier(rate(2, 0.5, 6), 200_000, rate(4, 1, 12)),
  "grok-4.6": tier(rate(2, 0.5, 6), 200_000, rate(4, 1, 12)),
  "grok-4.7": tier(rate(2, 0.5, 6), 200_000, rate(4, 1, 12)),
  "kimi-k2.7-code": rate(0.95, 0.19, 4),
  "kimi-k3": rate(3, 0.3, 15),
};

function modelKey(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-(?:20\d{6}|20\d{2}-\d{2}-\d{2})$/, "")
    .replace(/-\(fast-mode\)(?:-\(preview\))?$/, "-fast")
    .replace(
      /^claude-(\d+(?:[.-]\d+)?)-(sonnet|opus|haiku|fable)$/,
      "claude-$2-$1",
    )
    .replace(/^(claude-(?:sonnet|opus|haiku|fable)-\d+)-(\d+)(?=-|$)/, "$1.$2")
    .replace(/-1m(-internal)?$/, "");
}

export interface CallCost {
  usd?: number;
  source: "reported" | "estimated" | "unavailable";
  assumedCache?: boolean;
  reason?: string;
}
const validCount = (n: number | undefined): n is number =>
  n !== undefined && Number.isSafeInteger(n) && n >= 0;

export function callCost(call: UsageCall): CallCost {
  // Copilot's own per-request cost always wins, including an explicit zero.
  // VS Code converts nano-AIU to AI credits by /1e9; 1 credit = USD 0.01.
  if (validCount(call.nanoAiu))
    return { usd: call.nanoAiu / 100_000_000_000, source: "reported" };
  const key = modelKey(call.model);
  const base = Object.hasOwn(rates, key) ? rates[key] : undefined;
  if (
    !base ||
    (base.validThrough !== undefined && call.timestamp > base.validThrough)
  )
    return { source: "unavailable", reason: "No verified model price" };
  if (!validCount(call.input) || !validCount(call.output))
    return { source: "unavailable", reason: "Incomplete token counts" };
  if (
    base.long &&
    call.source &&
    call.source !== "chat" &&
    call.requests !== 1 &&
    call.input > base.threshold!
  )
    return { source: "unavailable", reason: "Per-request context unknown" };
  const read = call.cacheRead ?? 0;
  const write = call.cacheWrite ?? 0;
  if (!validCount(read) || !validCount(write) || read + write > call.input)
    return { source: "unavailable", reason: "Inconsistent cache counts" };
  const selected = base.long && call.input > base.threshold! ? base.long : base;
  if (write > 0 && selected.write === undefined)
    return { source: "unavailable", reason: "No verified cache write price" };
  // OTel input includes cached reads and writes. Charge each token exactly once.
  const usd =
    ((call.input - read - write) * selected.input +
      read * selected.cached +
      write * (selected.write ?? 0) +
      call.output * selected.output) /
    1_000_000;
  return {
    usd,
    source: "estimated",
    assumedCache:
      call.cacheRead === undefined ||
      (selected.write !== undefined && call.cacheWrite === undefined),
  };
}

export interface CostSummary {
  usd?: number;
  reportedUsd: number;
  estimatedUsd: number;
  reportedCalls: number;
  estimatedCalls: number;
  unpricedCalls: number;
  assumedCacheCalls: number;
}

export function costs(calls: UsageCall[]): CostSummary {
  const result: CostSummary = {
    reportedUsd: 0,
    estimatedUsd: 0,
    reportedCalls: 0,
    estimatedCalls: 0,
    unpricedCalls: 0,
    assumedCacheCalls: 0,
  };
  for (const call of calls) {
    const cost = callCost(call);
    if (cost.usd === undefined) result.unpricedCalls++;
    else if (cost.source === "reported") {
      result.reportedUsd += cost.usd;
      result.reportedCalls++;
    } else {
      result.estimatedUsd += cost.usd;
      result.estimatedCalls++;
      if (cost.assumedCache) result.assumedCacheCalls++;
    }
  }
  if (result.reportedCalls + result.estimatedCalls > 0)
    result.usd = result.reportedUsd + result.estimatedUsd;
  return result;
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value > 0 && value < 0.0001) return "<$0.0001";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  }).format(value);
}

export function costLabel(cost: CostSummary): string {
  if (cost.usd === undefined) return "—";
  return `${cost.estimatedCalls ? "≈" : ""}${formatUsd(cost.usd)}${cost.unpricedCalls ? "+" : ""}`;
}

export function costDescription(cost: CostSummary): string {
  return (
    `Usage records: ${cost.reportedCalls} reported · ${cost.estimatedCalls} estimated · ${cost.unpricedCalls} unpriced` +
    (cost.assumedCacheCalls
      ? ` · Cache detail missing for ${cost.assumedCacheCalls} records`
      : "")
  );
}
