import { runTests } from "@vscode/test-electron";
import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";

const scenario = ["mismatch", "missing-history"].includes(process.argv[2])
  ? process.argv[2]
  : "missing";
const root = resolve(`.test-work/collector-recovery-${scenario}`);
const profile = join(root, "profile");
const workspace = join(root, "project");
const id = createHash("sha256")
  .update(pathToFileURL(workspace).toString())
  .digest("hex")
  .slice(0, 24);
const token = "d".repeat(48);
const socket = createServer();
await new Promise((done) => socket.listen(0, "127.0.0.1", done));
const port = socket.address().port;
await new Promise((done) => socket.close(done));
const endpoint = `http://127.0.0.1:${port}/${token}`;

await rm(root, { recursive: true, force: true });
await mkdir(join(workspace, ".vscode"), { recursive: true });
await mkdir(join(profile, "User/globalStorage/openhoo.hoosage/projects", id), {
  recursive: true,
});
await writeFile(join(workspace, ".vscode/settings.json"), "{}");
await writeFile(
  join(profile, "User/settings.json"),
  JSON.stringify({
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    "extensions.autoUpdate": false,
    "telemetry.telemetryLevel": "error",
    "github.copilot.chat.otel.enabled": true,
    "github.copilot.chat.otel.exporterType": "otlp-http",
    "github.copilot.chat.otel.otlpEndpoint": endpoint,
    "github.copilot.chat.otel.outfile": "",
    "github.copilot.chat.otel.captureContent": false,
  }),
);
await writeFile(
  join(
    profile,
    "User/globalStorage/openhoo.hoosage/projects",
    id,
    "project.json",
  ),
  JSON.stringify({
    id,
    name: "project",
    kind: "folder",
    folderCount: 1,
    createdAt: Date.now(),
  }),
);
if (scenario !== "missing-history")
  await writeFile(
    join(
      profile,
      "User/globalStorage/openhoo.hoosage/projects",
      id,
      "copilot.jsonl",
    ),
    JSON.stringify({
      traceId: "c".repeat(32),
      spanId: "d".repeat(16),
      startTimeUnixNano: String(BigInt(Date.now() - 2000) * 1_000_000n),
      endTimeUnixNano: String(BigInt(Date.now() - 1000) * 1_000_000n),
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "Existing model",
        "gen_ai.usage.input_tokens": 11,
        "gen_ai.usage.output_tokens": 3,
      },
    }) + "\n",
  );
// Reproduce either lost storage or a stale file after a collector restart.
// Both previously left VS Code pointing at an endpoint with no listener.
if (scenario === "mismatch")
  await writeFile(
    join(profile, "User/globalStorage/openhoo.hoosage/collector.json"),
    JSON.stringify({
      port: port === 1024 ? 1025 : port - 1,
      token: "e".repeat(48),
    }),
  );
await build({
  entryPoints: ["test/extension-recovery-host.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["vscode"],
  outfile: join(root, "extension-test.cjs"),
});
await runTests({
  ...(process.env.VSCODE_EXECUTABLE
    ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE }
    : { version: "insiders" }),
  extensionDevelopmentPath: process.env.COPILOT_EXTENSION_PATH
    ? [resolve("."), process.env.COPILOT_EXTENSION_PATH]
    : resolve("."),
  extensionTestsPath: join(root, "extension-test.cjs"),
  launchArgs: [
    workspace,
    "--user-data-dir",
    profile,
    "--extensions-dir",
    join(root, "extensions"),
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    "--disable-updates",
    "--disable-gpu",
    "--no-sandbox",
  ],
  extensionTestsEnv: {
    HOOSAGE_TEST_PROJECT_ID: id,
    HOOSAGE_TEST_ENDPOINT: endpoint,
    HOOSAGE_TEST_STORAGE: join(profile, "User/globalStorage/openhoo.hoosage"),
    HOOSAGE_TEST_MISSING_HISTORY: String(scenario === "missing-history"),
  },
});
