import { runTests } from "@vscode/test-electron";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
const root = resolve(".test-work");
const profile = join(root, "profile");
const workspace = join(root, "sample-project");
const autoProject = join(root, "auto-project");
const copilotHome = join(root, "copilot-home");
const uri = pathToFileURL(workspace).toString();
const id = createHash("sha256").update(uri).digest("hex").slice(0, 24);
const autoId = createHash("sha256")
  .update(pathToFileURL(autoProject).toString())
  .digest("hex")
  .slice(0, 24);
const store = join(profile, "User/globalStorage/openhoo.hoosage/projects", id);
const token = "e".repeat(48);
const socket = createServer();
await new Promise((r) => socket.listen(0, "127.0.0.1", r));
const port = socket.address().port;
await new Promise((r) => socket.close(r));
await mkdir(store, { recursive: true });
await mkdir(join(workspace, ".vscode"), { recursive: true });
await mkdir(join(autoProject, ".git"), { recursive: true });
const cliSession = join(copilotHome, "session-state", "auto-project-session");
await mkdir(cliSession, { recursive: true });
await writeFile(
  join(cliSession, "workspace.yaml"),
  `client_name: copilot-cli\ncwd: ${autoProject}\n`,
);
await writeFile(
  join(cliSession, "events.jsonl"),
  JSON.stringify({
    type: "session.shutdown",
    id: "auto-project-usage",
    timestamp: new Date(Date.now() - 5_000).toISOString(),
    data: {
      modelMetrics: {
        "local-model": {
          usage: { inputTokens: 100, outputTokens: 20 },
          requests: { count: 1 },
        },
      },
    },
  }) + "\n",
);
await writeFile(
  join(store, "../../collector.json"),
  JSON.stringify({ port, token }),
);
await writeFile(
  join(store, "project.json"),
  JSON.stringify({
    id,
    name: "sample-project",
    kind: "folder",
    folderCount: 1,
    createdAt: Date.now(),
  }),
);
await writeFile(join(store, "copilot.jsonl"), "");
await mkdir(join(profile, "User"), { recursive: true });
await writeFile(
  join(profile, "User/settings.json"),
  JSON.stringify({
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    "extensions.autoUpdate": false,
    "telemetry.telemetryLevel": "error",
    "github.copilot.chat.otel.enabled": false,
    "github.copilot.chat.otel.exporterType": "otlp-http",
    "github.copilot.chat.otel.otlpEndpoint": `http://127.0.0.1:${port}/${token}`,
    "github.copilot.chat.otel.outfile": "",
    "github.copilot.chat.otel.captureContent": false,
  }),
);
await writeFile(join(workspace, ".vscode/settings.json"), "{}");
await build({
  entryPoints: ["test/extension-host.ts"],
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
    COPILOT_HOME: copilotHome,
    HOOSAGE_TEST_PROJECT_ID: id,
    HOOSAGE_TEST_AUTO_PROJECT_ID: autoId,
    HOOSAGE_TEST_ENDPOINT: `http://127.0.0.1:${port}/${token}`,
  },
});
