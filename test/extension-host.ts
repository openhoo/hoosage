import * as vscode from "vscode";
import assert from "node:assert/strict";
import type { Snapshot } from "../src/core/types";
import { costs } from "../src/core/pricing";
export async function run() {
  const extension = vscode.extensions.getExtension("openhoo.hoosage");
  assert.ok(extension, "Extension is installed in the development host");
  const api = (await extension.activate()) as {
    getSnapshot(): Promise<Snapshot>;
  };
  const initial = await api.getSnapshot();
  assert.equal(initial.currentProjectId, process.env.HOOSAGE_TEST_PROJECT_ID);
  assert.equal(initial.status, "off", initial.statusDetail);
  void vscode.commands.executeCommand("hoosage.enable");
  for (let i = 0; i < 100 && (await api.getSnapshot()).status !== "reload"; i++)
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    (await api.getSnapshot()).status,
    "reload",
    "Real enable command completes setup",
  );
  assert.equal((await api.getSnapshot()).canStopTracking, true);
  assert.equal(
    vscode.workspace
      .getConfiguration("github.copilot.chat.otel")
      .inspect("enabled")?.globalValue,
    true,
  );
  assert.equal(initial.calls.length, 0);
  const now = Date.now() - 5000;
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
                startTimeUnixNano: String(BigInt(now) * 1_000_000n),
                endTimeUnixNano: String(BigInt(now + 1000) * 1_000_000n),
                attributes: [
                  {
                    key: "gen_ai.operation.name",
                    value: { stringValue: "chat" },
                  },
                  {
                    key: "gen_ai.request.model",
                    value: { stringValue: "Integration model" },
                  },
                  {
                    key: "gen_ai.usage.input_tokens",
                    value: { intValue: "1350" },
                  },
                  {
                    key: "gen_ai.usage.output_tokens",
                    value: { intValue: "250" },
                  },
                  {
                    key: "copilot_chat.copilot_usage_nano_aiu",
                    value: { intValue: "123000000000" },
                  },
                  {
                    key: "gen_ai.input.messages",
                    value: { stringValue: "NEVER_STORE_THIS" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  for (let i = 0; i < 2; i++) {
    const response = await fetch(
      `${process.env.HOOSAGE_TEST_ENDPOINT}/v1/traces`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    assert.equal(response.status, 200);
  }
  const actual = await api.getSnapshot();
  assert.equal(actual.calls.length, 1, "Duplicate deliveries count once");
  assert.equal(actual.calls[0]?.input, 1350);
  assert.equal(actual.calls[0]?.output, 250);
  assert.equal(costs(actual.calls).usd, 1.23);
  assert.equal(costs(actual.calls).reportedCalls, 1);
  assert.equal(actual.status, "reload");
  assert.ok(!JSON.stringify(actual).includes("NEVER_STORE_THIS"));
  await vscode.commands.executeCommand("hoosage.open");
  for (
    let attempt = 0;
    attempt < 40 &&
    !vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .some((t) => t.label === "hoosage");
    attempt++
  )
    await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .some((t) => t.label === "hoosage"),
    "Dashboard opens in a real editor tab",
  );
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  void vscode.commands.executeCommand("hoosage.disable");
  for (
    let i = 0;
    i < 100 &&
    vscode.workspace
      .getConfiguration("github.copilot.chat.otel")
      .inspect("enabled")?.globalValue !== false;
    i++
  )
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    vscode.workspace
      .getConfiguration("github.copilot.chat.otel")
      .inspect("enabled")?.globalValue,
    false,
    "Stop tracking restores the previous user setting",
  );
  assert.equal((await api.getSnapshot()).canStopTracking, false);
  console.log(
    "HOOSAGE_EXTENSION_HOST_OK: activation, project identity, live HTTP ingestion, USD cost, deduplication, privacy, dashboard tab, settings restore",
  );
}
