import { createServer, type Server } from "node:http";
import { appendFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { parse } from "protobufjs";
import { parseSpan } from "./parser";
import type { UsageCall } from "./types";

// Wire-compatible subset of opentelemetry-proto (Apache-2.0). Unknown fields are
// skipped. Prompts, events, resource attributes and tool arguments are discarded.
const schema = parse(`syntax = "proto3";
message AnyValue { oneof value { string string_value=1; bool bool_value=2; int64 int_value=3; double double_value=4; } }
message KeyValue { string key=1; AnyValue value=2; }
message Status { string message=2; int32 code=3; }
message Span { bytes trace_id=1; bytes span_id=2; string name=5; int32 kind=6; fixed64 start_time_unix_nano=7; fixed64 end_time_unix_nano=8; repeated KeyValue attributes=9; Status status=15; }
message ScopeSpans { repeated Span spans=2; }
message Resource { repeated KeyValue attributes=1; }
message ResourceSpans { Resource resource=1; repeated ScopeSpans scope_spans=2; }
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans=1; }
`).root.lookupType("ExportTraceServiceRequest");

const LIMIT = 8 * 1024 * 1024;

export function decodeTraces(body: Buffer, contentType: string): unknown[] {
  if (body.length > LIMIT) throw new Error("Payload too large");
  let envelope: {
    resourceSpans?: {
      resource?: {
        attributes?: { key: string; value?: { stringValue?: string } }[];
      };
      scopeSpans?: { spans?: Record<string, unknown>[] }[];
    }[];
  };
  if (contentType.includes("application/json"))
    envelope = JSON.parse(body.toString("utf8"));
  else if (contentType.includes("application/x-protobuf"))
    envelope = schema.toObject(schema.decode(body), {
      longs: String,
      bytes: Array,
    }) as typeof envelope;
  else throw new Error("Unsupported content type");
  if (!Array.isArray(envelope?.resourceSpans)) return [];
  return envelope.resourceSpans.flatMap((resource) =>
    (Array.isArray(resource?.scopeSpans) ? resource.scopeSpans : []).flatMap(
      (scope) =>
        (Array.isArray(scope?.spans) ? scope.spans : []).map((span) => ({
          ...span,
          windowSessionId: resource.resource?.attributes?.find(
            (a) => a.key === "session.id",
          )?.value?.stringValue,
          traceId: Array.isArray(span.traceId)
            ? Buffer.from(span.traceId).toString("hex")
            : span.traceId,
          spanId: Array.isArray(span.spanId)
            ? Buffer.from(span.spanId).toString("hex")
            : span.spanId,
        })),
    ),
  );
}

/** Write a minimal standard span, so file readers use the same validation as
 * network ingestion. Never serialize the original incoming object. */
export function storedSpan(call: UsageCall) {
  const [traceId, spanId] = call.id.split(":");
  return {
    traceId,
    spanId,
    startTimeUnixNano: String(BigInt(call.timestamp) * 1_000_000n),
    endTimeUnixNano: String(
      BigInt(call.timestamp + (call.durationMs ?? 0)) * 1_000_000n,
    ),
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": call.model,
      "gen_ai.conversation.id": call.sessionId,
      "gen_ai.usage.input_tokens": call.input,
      "gen_ai.usage.output_tokens": call.output,
      "gen_ai.usage.cache_read.input_tokens": call.cacheRead,
      "gen_ai.usage.cache_creation.input_tokens": call.cacheWrite,
      "copilot_chat.copilot_usage_nano_aiu": call.nanoAiu,
    },
    status: { code: call.failed ? 2 : 1 },
  };
}

export interface CollectorConfig {
  port: number;
  token: string;
  projectId: string;
  file: string;
  route?: (
    sessionId: string,
  ) => Promise<{ projectId: string; file: string } | undefined>;
}
export interface Collector {
  close(): Promise<void>;
  port: number;
}

/** An authenticated loopback OTLP/HTTP endpoint with optional window routing. Browser-origin
 * requests and preflights are rejected; it is never exposed on the LAN. */
export async function startCollector(
  config: CollectorConfig,
): Promise<Collector> {
  let writing = Promise.resolve();
  const prefix = `/${config.token}`;
  const server: Server = createServer(async (req, res) => {
    if (req.headers.origin || req.headers["sec-fetch-site"]) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "GET" && req.url === `${prefix}/health`) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          projectId: config.projectId,
          protocol: config.route ? 2 : 1,
        }),
      );
      return;
    }
    const validPath = [
      `${prefix}/v1/traces`,
      `${prefix}/v1/metrics`,
      `${prefix}/v1/logs`,
    ].includes(req.url ?? "");
    if (req.method !== "POST" || !validPath) {
      res.writeHead(404).end();
      return;
    }
    const contentType = String(req.headers["content-type"] ?? "");
    if (
      !contentType.includes("application/json") &&
      !contentType.includes("application/x-protobuf")
    ) {
      res.writeHead(415).end();
      return;
    }
    const encoding = req.headers["content-encoding"];
    if (encoding && encoding !== "gzip" && encoding !== "identity") {
      res.writeHead(415).end();
      return;
    }
    if (Number(req.headers["content-length"]) > LIMIT) {
      res.writeHead(413, { connection: "close" }).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const part of req) {
        length += part.length;
        if (length > LIMIT) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(part);
      }
      let body = Buffer.concat(chunks);
      if (encoding === "gzip")
        body = gunzipSync(body, { maxOutputLength: LIMIT });
      if (req.url === `${prefix}/v1/traces`) {
        const grouped = new Map<string, UsageCall[]>();
        const routed = new Map<
          string,
          { projectId: string; file: string } | undefined
        >();
        for (const span of decodeTraces(body, contentType)) {
          const sessionId = (span as { windowSessionId?: unknown })
            .windowSessionId;
          let target: { projectId: string; file: string } | undefined = config;
          if (config.route) {
            if (typeof sessionId !== "string") continue;
            if (!routed.has(sessionId))
              routed.set(sessionId, await config.route(sessionId));
            target = routed.get(sessionId);
          }
          if (!target) continue;
          const call = parseSpan(span, target.projectId);
          if (call) {
            const calls = grouped.get(target.file);
            if (calls) calls.push(call);
            else grouped.set(target.file, [call]);
          }
        }
        for (const [file, calls] of grouped) {
          const lines = calls
            .map((call) => JSON.stringify(storedSpan(call)) + "\n")
            .join("");
          const write = writing.then(() =>
            appendFile(file, lines, { mode: 0o600 }),
          );
          writing = write.catch(() => {});
          try {
            await write;
          } catch {
            res.writeHead(503).end();
            return;
          }
        }
      }
      // Empty protobuf Export*ServiceResponse is valid; JSON response is {}.
      res
        .writeHead(200, {
          "content-type": contentType.includes("json")
            ? "application/json"
            : "application/x-protobuf",
        })
        .end(contentType.includes("json") ? "{}" : Buffer.alloc(0));
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.timeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Invalid listener address");
  return {
    port: address.port,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await writing;
    },
  };
}
