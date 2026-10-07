import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";

// Exercise the actual extension lifecycle without an IDE or real usage history.
// Only external services and the VS Code UI are mocked; disposal, refresh,
// timer scheduling and collector ownership execute the production source.
const require = createRequire(import.meta.url);
const source = await readFile(
  new URL("../src/extension.ts", import.meta.url),
  "utf8",
);
const code = transformSync(source, {
  loader: "ts",
  format: "cjs",
  target: "es2022",
}).code;
const noop = () => {};
const disposable = () => ({ dispose: noop });
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function harness({ blockScan = false, blockCollector = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "hoosage-lifecycle-"));
  const scanEntered = deferred();
  const scanRelease = deferred();
  const collectorEntered = deferred();
  const collectorRelease = deferred();
  const counters = {
    scans: 0,
    collectorStarts: 0,
    collectorCloses: 0,
    timersAfterDispose: 0,
    uiAfterDispose: 0,
  };
  let disposed = false;
  const token = "a".repeat(48);
  const endpoint = `http://127.0.0.1:54321/${token}`;
  if (blockCollector)
    await writeFile(
      join(directory, "collector.json"),
      JSON.stringify({ port: 54321, token }),
    );
  const settings = blockCollector
    ? {
        enabled: true,
        exporterType: "otlp-http",
        outfile: "",
        captureContent: false,
        otlpEndpoint: endpoint,
      }
    : {};
  const folder = {
    name: "Synthetic workspace",
    uri: { fsPath: directory, toString: () => `file://${directory}` },
  };
  const uiUpdate = () => {
    if (disposed) counters.uiAfterDispose++;
  };
  const vscode = {
    workspace: {
      isTrusted: true,
      workspaceFolders: blockCollector ? [folder] : [],
      getConfiguration: () => ({
        get: (key) => settings[key],
        inspect: () => ({ defaultValue: "" }),
      }),
      onDidChangeConfiguration: disposable,
    },
    env: { sessionId: "synthetic-lifecycle-window" },
    window: {
      createOutputChannel: () => ({ dispose: noop }),
      createStatusBarItem: () => ({
        show: uiUpdate,
        hide: uiUpdate,
        dispose: noop,
      }),
      registerWebviewViewProvider: disposable,
    },
    commands: { registerCommand: disposable },
    StatusBarAlignment: { Right: 1 },
  };
  const mocks = {
    "./core/tailer": {
      UsageTailer: class {
        caughtUp = true;
        calls = new Map();
        skippedLines = 0;
        async poll() {}
      },
    },
    "./core/cli": {
      CliUsageScanner: class {
        caughtUp = !blockScan;
        calls = new Map();
        skippedLines = 0;
        async poll() {
          counters.scans++;
          scanEntered.resolve();
          if (blockScan) await scanRelease.promise;
        }
      },
      folderPathHash: () => "0".repeat(64),
      CLI_PROJECT_ID: "cli",
      JETBRAINS_PROJECT_ID: "jetbrains",
    },
    "./core/wsl-sessions": {
      WslCliSessions: class {
        caughtUp = true;
        calls = [];
        folderCount = 0;
        skippedLines = 0;
        async poll() {}
      },
    },
    "./core/path-identity": { exactFolderPathHash: () => "0".repeat(64) },
    "./core/project-index": {
      ProjectIndex: class {
        projects() {
          return [];
        }
      },
    },
    "./core/project-metadata": { restoreProject: (value) => value },
    "./core/workspace-discovery": { discoverKnownFolders: async () => [] },
    "./core/chat-history-import": {
      scanChatHistory: async () => ({ projects: [], calls: [] }),
      restoreHistory: () => [],
      storedHistoryPayload: (calls) => ({ version: 1, calls }),
      mergeStoredHistory: () => ({ changed: false, calls: [] }),
      withoutLiveOverlap: () => [],
      NO_FOLDER_CHAT_PROJECT_ID: "no-folder",
    },
    "./core/collector": {
      startCollector: async () => {
        counters.collectorStarts++;
        collectorEntered.resolve();
        if (blockCollector) await collectorRelease.promise;
        return {
          port: 54321,
          close: async () => {
            counters.collectorCloses++;
          },
        };
      },
    },
    "./core/routing": { registerWindow: async () => {} },
    "./core/environment": { hasTelemetryEnvironmentConflict: () => false },
    "./core/analytics": {
      filterCalls: () => [],
      totals: () => ({ tokens: 0, calls: 0, missingUsage: 0 }),
    },
    "./core/pricing": {
      costs: () => ({}),
      costLabel: () => "$0",
      costDescription: () => "$0",
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (id) =>
      id === "vscode"
        ? vscode
        : id.startsWith("./")
          ? (mocks[id] ?? {})
          : require(id),
    process,
    Buffer,
    console,
    AbortSignal,
    setInterval: () => 1,
    clearInterval: noop,
    setTimeout: () => {
      if (disposed) counters.timersAfterDispose++;
      return 2;
    },
    clearTimeout: noop,
  });
  const context = {
    globalStorageUri: { fsPath: directory },
    extension: { packageJSON: { version: "synthetic" } },
    globalState: { get: (_key, fallback) => fallback, update: async () => {} },
    subscriptions: [],
  };
  const api = await module.exports.activate(context);
  return {
    api,
    counters,
    scanEntered,
    scanRelease,
    collectorEntered,
    collectorRelease,
    stop() {
      disposed = true;
      return module.exports.deactivate();
    },
    disposeSubscriptions() {
      disposed = true;
      for (const subscription of context.subscriptions) subscription.dispose();
    },
    async cleanup() {
      scanRelease.resolve();
      collectorRelease.resolve();
      await module.exports.deactivate();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const scanner = await harness({ blockScan: true });
try {
  await scanner.scanEntered.promise;
  scanner.disposeSubscriptions();
  let stopResolved = false;
  const stopped = scanner.stop().then(() => {
    stopResolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    stopResolved,
    false,
    "Deactivation must await the scan even after subscriptions disposed it",
  );
  scanner.scanRelease.resolve();
  await stopped;
  await scanner.api.getSnapshot();
  assert.equal(
    scanner.counters.timersAfterDispose,
    0,
    "An in-flight scan must not restart indexing after disposal",
  );
  assert.equal(
    scanner.counters.uiAfterDispose,
    0,
    "A completed scan must not update disposed VS Code UI",
  );
  assert.equal(
    scanner.counters.scans,
    1,
    "Snapshot requests must not start new scans after disposal",
  );
} finally {
  await scanner.cleanup();
}

const collector = await harness({ blockCollector: true });
try {
  await collector.collectorEntered.promise;
  let stopResolved = false;
  const stopped = collector.stop().then(() => {
    stopResolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    stopResolved,
    false,
    "Deactivation must await a pending collector startup",
  );
  collector.collectorRelease.resolve();
  await stopped;
  await collector.api.getSnapshot();
  assert.equal(
    collector.counters.collectorStarts,
    1,
    "Only the pending collector may start",
  );
  assert.equal(
    collector.counters.collectorCloses,
    1,
    "A collector finishing after disposal must be closed exactly once",
  );
  assert.equal(
    collector.counters.timersAfterDispose,
    0,
    "Delayed collector setup must not restart indexing",
  );
  assert.equal(
    collector.counters.uiAfterDispose,
    0,
    "Delayed collector setup must not update disposed UI",
  );
} finally {
  await collector.cleanup();
}

console.log(
  "HOOSAGE_EXTENSION_LIFECYCLE_OK: pending refresh disposal, no new scans/timers/UI, delayed collector closure",
);
