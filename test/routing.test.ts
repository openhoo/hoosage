import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter as JsonExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { registerWindow, routeWindow } from "../src/core/routing";
import { isOwnCollectorHealth, startCollector } from "../src/core/collector";

test("collector health rejects another profile even with the same endpoint token", async () => {
  const collector = await startCollector({
    port: 0,
    token: "test-secret",
    projectId: "host",
    file: "",
    storeId: "profile-a",
    route: async () => undefined,
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${collector.port}/test-secret/health`,
    );
    const health = await response.json();
    assert.equal(isOwnCollectorHealth(health, "profile-a"), true);
    assert.equal(isOwnCollectorHealth(health, "profile-b"), false);
    assert.equal(
      isOwnCollectorHealth({ projectId: "host", protocol: 2 }, "profile-a"),
      false,
    );
  } finally {
    await collector.close();
  }
});

for (const [name, Exporter] of [
  ["JSON", JsonExporter],
  ["protobuf", ProtoExporter],
] as const) {
  test(`${name}: two windows stay isolated, unknown windows are discarded, mappings cannot change`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hoosage-routing-"));
    const a = "a".repeat(24),
      b = "b".repeat(24);
    for (const id of [a, b])
      await mkdir(join(root, "projects", id), { recursive: true });
    await registerWindow(root, "window-a", a);
    await registerWindow(root, "window-b", b);
    await registerWindow(root, "window-a", a);
    const collector = await startCollector({
      port: 0,
      token: "test-secret",
      projectId: "host",
      file: "",
      route: (session) => routeWindow(root, session),
    });
    try {
      for (const [session, tokens] of [
        ["window-b", 200],
        ["unknown", 999],
        ["window-a", 100],
      ] as const) {
        const provider = new NodeTracerProvider({
          resource: resourceFromAttributes({
            "session.id": session,
            "private.repository": "NEVER_PERSIST",
          }),
          spanProcessors: [
            new SimpleSpanProcessor(
              new Exporter({
                url: `http://127.0.0.1:${collector.port}/test-secret/v1/traces`,
              }),
            ),
          ],
        });
        provider
          .getTracer("copilot-chat")
          .startSpan("chat", {
            attributes: {
              "gen_ai.operation.name": "chat",
              "gen_ai.usage.input_tokens": tokens,
              "gen_ai.usage.output_tokens": 10,
            },
          })
          .end();
        await provider.shutdown();
      }
      for (const [id, tokens] of [
        [a, 100],
        [b, 200],
      ] as const) {
        const data = await readFile(
          join(root, "projects", id, "copilot.jsonl"),
          "utf8",
        );
        assert.equal(data.trim().split("\n").length, 1);
        assert.equal(
          JSON.parse(data).attributes["gen_ai.usage.input_tokens"],
          tokens,
        );
        assert.ok(!data.includes("NEVER_PERSIST") && !data.includes("window-"));
      }
      await assert.rejects(registerWindow(root, "window-a", b));
      assert.equal(await routeWindow(root, "window-a"), undefined);
    } finally {
      await collector.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
