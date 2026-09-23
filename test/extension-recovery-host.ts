import * as vscode from "vscode";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Snapshot } from "../src/core/types";

export async function run() {
  const extension = vscode.extensions.getExtension("openhoo.hoosage");
  assert.ok(extension);
  const api = (await extension.activate()) as {
    getSnapshot(): Promise<Snapshot>;
  };
  const snapshot = await api.getSnapshot();
  assert.equal(snapshot.currentProjectId, process.env.HOOSAGE_TEST_PROJECT_ID);
  if (process.env.HOOSAGE_TEST_MISSING_HISTORY === "true") {
    assert.equal(snapshot.status, "waiting", snapshot.statusDetail);
    assert.ok(
      snapshot.errors.some((error) =>
        error.includes("Saved Chat history is missing"),
      ),
      "Missing history is reported instead of silently creating an empty file",
    );
  } else {
    assert.equal(snapshot.status, "active", snapshot.statusDetail);
    assert.equal(
      snapshot.calls.find((call) => call.model === "Existing model")?.input,
      11,
    );
  }
  assert.equal(snapshot.canStopTracking, true);
  const connection = JSON.parse(
    await readFile(
      join(process.env.HOOSAGE_TEST_STORAGE!, "collector.json"),
      "utf8",
    ),
  );
  assert.equal(
    `http://127.0.0.1:${connection.port}/${connection.token}`,
    process.env.HOOSAGE_TEST_ENDPOINT,
  );
  const health = await fetch(`${process.env.HOOSAGE_TEST_ENDPOINT}/health`);
  assert.equal(health.status, 200);
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "session.id", value: { stringValue: vscode.env.sessionId } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: "a".repeat(32),
                spanId: "b".repeat(16),
                startTimeUnixNano: String(
                  BigInt(Date.now() - 1000) * 1_000_000n,
                ),
                endTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
                attributes: [
                  {
                    key: "gen_ai.operation.name",
                    value: { stringValue: "chat" },
                  },
                  {
                    key: "gen_ai.request.model",
                    value: { stringValue: "Recovery model" },
                  },
                  {
                    key: "gen_ai.usage.input_tokens",
                    value: { intValue: "42" },
                  },
                  {
                    key: "gen_ai.usage.output_tokens",
                    value: { intValue: "7" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const response = await fetch(
    `${process.env.HOOSAGE_TEST_ENDPOINT}/v1/traces`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  assert.equal(response.status, 200);
  const updated = await api.getSnapshot();
  assert.equal(updated.status, "active");
  assert.equal(
    updated.calls.find((call) => call.model === "Recovery model")?.input,
    42,
  );
  void vscode.commands.executeCommand("hoosage.disable");
  for (
    let i = 0;
    i < 100 &&
    vscode.workspace
      .getConfiguration("github.copilot.chat.otel")
      .inspect("enabled")?.globalValue !== undefined;
    i++
  )
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    vscode.workspace
      .getConfiguration("github.copilot.chat.otel")
      .inspect("enabled")?.globalValue,
    undefined,
    "Recovered tracking can still be stopped",
  );
  console.log("HOOSAGE_COLLECTOR_RECOVERY_OK");
}
