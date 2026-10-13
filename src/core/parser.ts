import { validateCacheSubsets, type UsageCall } from "./types";

const object = (x: unknown): Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : {};
const number = (x: unknown): number | undefined => {
  if (typeof x !== "number" && typeof x !== "string") return;
  if (typeof x === "string" && !/^\d+(\.\d+)?$/.test(x)) return;
  const n = Number(x);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};
const label = (x: unknown, max = 160): string | undefined =>
  typeof x === "string" && x.length > 0
    ? x.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max)
    : undefined;

function millis(value: unknown): number | undefined {
  if (Array.isArray(value) && value.length === 2) {
    const seconds = number(value[0]);
    const nanos = number(value[1]);
    if (seconds !== undefined && nanos !== undefined && nanos < 1e9)
      return seconds * 1000 + nanos / 1e6;
  }
  // OTLP JSON encodes Unix nanoseconds as a string to avoid precision loss.
  if (typeof value === "string" && /^\d{16,20}$/.test(value)) {
    return Number(BigInt(value) / 1_000_000n);
  }
  return undefined;
}

function attributes(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return object(value);
  return Object.fromEntries(
    value.map((item) => {
      const entry = object(item);
      const val = object(entry.value);
      return [
        String(entry.key),
        val.stringValue ?? val.intValue ?? val.doubleValue ?? val.boolValue,
      ];
    }),
  );
}

/** Only terminal chat spans count. Agent totals, log events and cumulative metrics
 * repeat the same consumption and must never be added to these calls. */
export function parseSpan(
  value: unknown,
  projectId: string,
): UsageCall | undefined {
  const span = object(value);
  const attrs = attributes(span.attributes);
  if (attrs["gen_ai.operation.name"] !== "chat") return;
  const ctx = object(span.spanContext ?? span._spanContext);
  const traceId = label(span.traceId ?? ctx.traceId);
  const spanId = label(span.spanId ?? ctx.spanId);
  if (
    !traceId ||
    !spanId ||
    !/^[a-f0-9]{32}$/i.test(traceId) ||
    !/^[a-f0-9]{16}$/i.test(spanId)
  )
    return;
  const start = millis(span.startTime ?? span.startTimeUnixNano);
  const end = millis(span.endTime ?? span.endTimeUnixNano);
  if (
    start === undefined ||
    end === undefined ||
    end < start ||
    start < 0 ||
    end > Date.now() + 86_400_000
  )
    return;
  const session = label(
    attrs["gen_ai.conversation.id"] ??
      attrs["github.copilot.chat.session_id"] ??
      attrs["copilot_chat.chat_session_id"],
  );
  const call: UsageCall = {
    id: `${traceId.toLowerCase()}:${spanId.toLowerCase()}`,
    projectId,
    timestamp: Math.floor(start),
    model:
      label(attrs["gen_ai.response.model"] ?? attrs["gen_ai.request.model"]) ??
      "Unknown model",
    sessionId: session,
    input: number(attrs["gen_ai.usage.input_tokens"]),
    output: number(attrs["gen_ai.usage.output_tokens"]),
    cacheRead: number(attrs["gen_ai.usage.cache_read.input_tokens"]),
    cacheWrite: number(
      attrs["gen_ai.usage.cache_creation.input_tokens"] ??
        attrs["gen_ai.usage.cache_write.input_tokens"],
    ),
    nanoAiu: number(attrs["copilot_chat.copilot_usage_nano_aiu"]),
    durationMs: Math.round(end - start),
    failed:
      Boolean(attrs["error.type"]) ||
      object(span.status).code === 2 ||
      object(span.status).code === "STATUS_CODE_ERROR",
  };
  validateCacheSubsets(call);
  return call;
}

export function parseLine(line: string, projectId: string): UsageCall[] {
  const value: unknown = JSON.parse(line);
  const root = object(value);
  // Also accept an explicitly imported OTLP JSON trace envelope.
  if (Array.isArray(root.resourceSpans)) {
    return root.resourceSpans.flatMap((resource) => {
      const scopes = object(resource).scopeSpans;
      if (!Array.isArray(scopes)) return [];
      return scopes.flatMap((scope) => {
        const spans = object(scope).spans;
        if (!Array.isArray(spans)) return [];
        return spans
          .map((s) => parseSpan(s, projectId))
          .filter((s): s is UsageCall => Boolean(s));
      });
    });
  }
  const call = parseSpan(value, projectId);
  return call ? [call] : [];
}
