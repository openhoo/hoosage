import * as vscode from "vscode";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Snapshot } from "../src/core/types";
import { costs } from "../src/core/pricing";
export async function run() {
  const extension = vscode.extensions.getExtension("openhoo.hoosage");
  assert.ok(extension, "Extension is installed in the development host");
  const api = (await extension.activate()) as {
    getSnapshot(): Promise<Snapshot>;
    getDiagnostics(): Promise<string[]>;
  };
  const initial = await api.getSnapshot();
  assert.equal(initial.currentProjectId, process.env.HOOSAGE_TEST_PROJECT_ID);
  assert.equal(initial.status, "off", initial.statusDetail);
  assert.ok(
    initial.projects.some(
      (project) =>
        project.id === process.env.HOOSAGE_TEST_AUTO_PROJECT_ID &&
        project.name === "auto-project",
    ),
    "Completed local sessions discover projects without an enable click",
  );
  assert.equal(initial.calls.length, 2);
  assert.equal(
    initial.calls.find((call) => call.source === "cli")?.projectId,
    process.env.HOOSAGE_TEST_AUTO_PROJECT_ID,
  );
  assert.equal(
    initial.calls.find((call) => call.model === "Prior version model")?.input,
    77,
    "Activation preserves saved usage from a previous version",
  );
  assert.equal(
    JSON.parse(await readFile(process.env.HOOSAGE_TEST_PROJECT_RECORD!, "utf8"))
      .createdAt,
    1_700_000_000_000,
    "Activation preserves the original project record",
  );
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
  const chat = actual.calls.filter(
    (call) => call.model === "Integration model",
  );
  assert.equal(chat.length, 1, "Duplicate deliveries count once");
  assert.ok(
    (await readFile(process.env.HOOSAGE_TEST_CAPTURE!, "utf8")).includes(
      "Prior version model",
    ),
    "New usage appends without clearing old history",
  );
  assert.equal(chat[0]?.input, 1350);
  assert.equal(chat[0]?.output, 250);
  assert.equal(costs(chat).usd, 1.23);
  assert.equal(costs(chat).reportedCalls, 1);
  assert.equal(actual.status, "reload");
  assert.ok(!JSON.stringify(actual).includes("NEVER_STORE_THIS"));
  const diagnostics = (await api.getDiagnostics()).join("\n");
  assert.ok(diagnostics.includes("Extension host: Local extension host"));
  assert.ok(diagnostics.includes("Copilot endpoint matches collector: yes"));
  assert.ok(diagnostics.includes("Collector reachable here: yes"));
  assert.ok(
    diagnostics.includes("Saved Chat entries for this project on this host: 2"),
  );
  assert.match(diagnostics, /Saved Chat history file size: [1-9]\d* bytes/);
  assert.match(diagnostics, /Saved Chat history bytes read here: [1-9]\d*/);
  assert.ok(
    diagnostics.includes("Saved Chat history complete lines processed here: 3"),
  );
  assert.ok(
    diagnostics.includes("Saved Chat history lines ignored as non-Chat here: 0"),
  );
  assert.ok(!diagnostics.includes(process.env.HOOSAGE_TEST_ENDPOINT!));
  assert.ok(!diagnostics.includes("NEVER_STORE_THIS"));
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
    "HOOSAGE_EXTENSION_HOST_OK: automatic project indexing, activation, live HTTP ingestion, USD cost, deduplication, privacy, dashboard tab, settings restore",
  );
}
