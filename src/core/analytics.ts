import type { UsageCall, Totals } from "./types";
import { callCost, PRICING_DATE } from "./pricing";

/** Entries that summarize several model requests instead of one span. */
export const isAggregated = (c: UsageCall) =>
  c.source === "cli" || c.source === "jetbrains" || c.source === "chat-history";

export function totals(calls: UsageCall[]): Totals {
  const input = calls.reduce((n, c) => n + (c.input ?? 0), 0);
  const output = calls.reduce((n, c) => n + (c.output ?? 0), 0);
  const durations = calls
    .map((c) => c.durationMs)
    .filter((d): d is number => d !== undefined);
  return {
    calls: calls.reduce(
      (n, c) => n + (isAggregated(c) ? (c.requests ?? 0) : 1),
      0,
    ),
    missingRequests: calls.filter(
      (c) => isAggregated(c) && c.requests === undefined,
    ).length,
    input,
    output,
    tokens: input + output,
    cacheRead: calls.reduce((n, c) => n + (c.cacheRead ?? 0), 0),
    sessions: new Set(
      calls
        .filter((c) => c.sessionId)
        .map((c) => `${c.projectId}:${c.sessionId}`),
    ).size,
    missingUsage: calls.filter(
      (c) => c.input === undefined || c.output === undefined,
    ).length,
    failed: calls.filter((c) => c.failed).length,
    avgDurationMs: durations.length
      ? durations.reduce((n, d) => n + d, 0) / durations.length
      : 0,
  };
}

export function startOfRange(days: number, now = Date.now()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days + 1);
  return start.getTime();
}

/** Date input values are local calendar days, not UTC dates. */
export function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function periodEnd(now: number, endDate?: string): number | undefined {
  if (endDate === undefined) return now;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDate);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 100 || month < 1 || month > 12 || day < 1 || day > 31)
    return undefined;
  const date = new Date(year, month - 1, day);
  if (localDateKey(date.getTime()) !== endDate) return undefined;
  if (endDate > localDateKey(now)) return undefined;
  date.setDate(date.getDate() + 1);
  return Math.min(now, date.getTime() - 1);
}

export function shiftLocalDate(dateKey: string, days: number): string | undefined {
  if (periodEnd(Date.now(), dateKey) === undefined) return undefined;
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year!, month! - 1, day!);
  date.setDate(date.getDate() + days);
  return localDateKey(date.getTime());
}

export interface DateBounds {
  start: number;
  end: number;
  days: number;
}

/** Inclusive local calendar dates. UTC date arithmetic avoids DST changing
 * the number of selected days. */
export function customDateBounds(
  now: number,
  startDate: string,
  endDate: string,
): DateBounds | undefined {
  const startEnd = periodEnd(now, startDate);
  const end = periodEnd(now, endDate);
  if (startEnd === undefined || end === undefined || startDate > endDate)
    return undefined;
  const start = startOfRange(1, startEnd);
  const [startYear, startMonth, startDay] = startDate.split("-").map(Number);
  const [endYear, endMonth, endDay] = endDate.split("-").map(Number);
  const days =
    (Date.UTC(endYear!, endMonth! - 1, endDay!) -
      Date.UTC(startYear!, startMonth! - 1, startDay!)) /
      86_400_000 +
    1;
  return { start, end, days };
}

export function filterCallsBetween(
  calls: UsageCall[],
  projectId: string,
  bounds: DateBounds,
): UsageCall[] {
  return calls.filter(
    (call) =>
      (projectId === "all" || call.projectId === projectId) &&
      call.timestamp >= bounds.start &&
      call.timestamp <= bounds.end,
  );
}

/** At most 30 calendar buckets, so multi-year ranges stay legible. */
export function usageBuckets(calls: UsageCall[], bounds: DateBounds) {
  const interval =
    [1, 7, 14, 30, 90, 365].find((size) => Math.ceil(bounds.days / size) <= 30) ??
    Math.ceil(bounds.days / 30 / 365) * 365;
  const buckets: Array<Totals & { start: number; end: number }> = [];
  let cursor = new Date(bounds.start);
  while (cursor.getTime() <= bounds.end) {
    const start = cursor.getTime();
    cursor = new Date(cursor);
    cursor.setDate(cursor.getDate() + interval);
    const end = Math.min(cursor.getTime() - 1, bounds.end);
    const usage = totals(
      calls.filter((call) => call.timestamp >= start && call.timestamp <= end),
    );
    buckets.push({ start, end, ...usage });
  }
  return { interval, buckets };
}

export function filterCalls(
  calls: UsageCall[],
  projectId: string,
  days: number,
  now = Date.now(),
): UsageCall[] {
  return calls.filter(
    (c) =>
      (projectId === "all" || c.projectId === projectId) &&
      c.timestamp >= startOfRange(days, now) &&
      c.timestamp <= now,
  );
}

export function daily(calls: UsageCall[], days: number, now = Date.now()) {
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(startOfRange(days, now));
    date.setDate(date.getDate() + i);
    const end = new Date(date);
    end.setDate(end.getDate() + 1);
    return {
      date: date.getTime(),
      ...totals(
        calls.filter(
          (c) => c.timestamp >= date.getTime() && c.timestamp < end.getTime(),
        ),
      ),
    };
  });
}

export function byModel(calls: UsageCall[]) {
  return [...new Set(calls.map((c) => c.model))]
    .map((model) => ({
      model,
      ...totals(calls.filter((c) => c.model === model)),
    }))
    .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);
}

/** An unlinked span is a single call, not a project-wide session. */
export function groupSessions(calls: UsageCall[]) {
  const groups = new Map<string, UsageCall[]>();
  for (const call of calls) {
    const key = JSON.stringify([
      call.projectId,
      call.source ?? "chat",
      call.sessionId === undefined ? "call" : "session",
      call.sessionId ?? call.id,
    ]);
    const group = groups.get(key);
    if (group) group.push(call);
    else groups.set(key, [call]);
  }
  return [...groups]
    .map(([key, group]) => ({
      key,
      group,
      latest: group.reduce((time, call) => Math.max(time, call.timestamp), 0),
    }))
    .sort((a, b) => b.latest - a.latest)
    .map(({ key, group }): [string, UsageCall[]] => [key, group]);
}

const csvCell = (value: unknown): string => {
  let text = value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

export function exportCsv(calls: UsageCall[]): string {
  const header = [
    "project_id",
    "timestamp_utc",
    "model",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "duration_ms",
    "failed",
    "cache_write_tokens",
    "reported_nano_aiu",
    "cost_usd",
    "cost_source",
    "cost_note",
    "price_table_date",
    "source",
    "requests",
  ];
  return (
    [
      header,
      ...calls.map((c) => {
        const cost = callCost(c);
        return [
          c.projectId,
          new Date(c.timestamp).toISOString(),
          c.model,
          c.input,
          c.output,
          c.cacheRead,
          c.durationMs,
          c.failed,
          c.cacheWrite,
          c.nanoAiu,
          cost.usd,
          cost.source,
          cost.reason ??
            (cost.assumedCache ? "Missing cache detail assumed zero" : ""),
          cost.source === "estimated" ? PRICING_DATE : undefined,
          c.source ?? "chat",
          isAggregated(c) ? c.requests : 1,
        ];
      }),
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n") + "\r\n"
  );
}
