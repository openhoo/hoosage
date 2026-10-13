import { test } from "node:test";
import assert from "node:assert/strict";
import { startCollector } from "../src/core/collector";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("collector closure is shared by stop-tracking and host disposal", async () => {
  const collector = await startCollector({
    port: 0,
    token: "synthetic-test",
    projectId: "host",
    file: "",
  });
  const first = collector.close();
  const second = collector.close();
  assert.equal(first, second);
  await Promise.all([first, second]);
  await collector.close();
  await assert.rejects(
    fetch(`http://127.0.0.1:${collector.port}/synthetic-test/health`),
  );
});

test("collector shutdown drains a request already waiting for workspace routing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hoosage-collector-drain-"));
  const file = join(directory, "usage.jsonl");
  let routeEntered!: () => void;
  let releaseRoute!: () => void;
  const entered = new Promise<void>((resolve) => {
    routeEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseRoute = resolve;
  });
  const collector = await startCollector({
    port: 0,
    token: "synthetic-drain",
    projectId: "host",
    file: "",
    route: async () => {
      routeEntered();
      await released;
      return { projectId: "a".repeat(24), file };
    },
  });
  try {
    const response = fetch(
      `http://127.0.0.1:${collector.port}/synthetic-drain/v1/traces`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: [
                  { key: "session.id", value: { stringValue: "window" } },
                ],
              },
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId: "a".repeat(32),
                      spanId: "b".repeat(16),
                      startTimeUnixNano: "1750000000000000000",
                      endTimeUnixNano: "1750000000100000000",
                      attributes: {
                        "gen_ai.operation.name": "chat",
                        "gen_ai.usage.input_tokens": 12,
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      },
    );
    await entered;
    let closed = false;
    const closing = collector.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    releaseRoute();
    assert.equal((await response).status, 200);
    await closing;
    assert.equal(
      JSON.parse((await readFile(file, "utf8")).trim()).attributes[
        "gen_ai.usage.input_tokens"
      ],
      12,
    );
  } finally {
    releaseRoute();
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});
