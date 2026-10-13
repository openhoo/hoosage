import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

async function harness({
  blockScan = false,
  blockCollector = false,
  blockHistory = false,
  blockDiscovery = false,
  withWorkspace = false,
  seedTailerCall = false,
  failTailer = false,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "hoosage-lifecycle-"));
  const scanEntered = deferred();
  const scanRelease = deferred();
  const collectorEntered = deferred();
  const collectorRelease = deferred();
  const historyEntered = deferred();
  const historyRelease = deferred();
  const discoveryEntered = deferred();
  const discoveryRelease = deferred();
  const counters = {
    scans: 0,
    collectorStarts: 0,
    collectorCloses: 0,
    timersAfterDispose: 0,
    uiAfterDispose: 0,
    saveDialogs: 0,
    informationMessages: 0,
  };
  const commands = new Map();
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
      workspaceFolders: blockCollector || withWorkspace ? [folder] : [],
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
      showSaveDialog: async () => {
        counters.saveDialogs++;
        return undefined;
      },
      showInformationMessage: async () => {
        counters.informationMessages++;
        return undefined;
      },
    },
    commands: {
      registerCommand: (name, handler) => {
        commands.set(name, handler);
        return disposable();
      },
    },
    StatusBarAlignment: { Right: 1 },
    Uri: { file: (path) => path },
  };
  const mocks = {
    "./core/tailer": {
      UsageTailer: class {
        caughtUp = true;
        calls = new Map();
        skippedLines = 0;
        constructor(_file, projectId) {
          if (seedTailerCall)
            this.calls.set("synthetic-live", {
              id: "synthetic-live",
              projectId,
              timestamp: 1_750_000_000_000,
              model: "synthetic",
              failed: false,
            });
        }
        async poll() {
          if (failTailer) throw new Error("Synthetic source read failure");
        }
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
    "./core/workspace-discovery": {
      discoverKnownFolders: async () => {
        discoveryEntered.resolve();
        if (blockDiscovery) await discoveryRelease.promise;
        return blockDiscovery ? [{ id: "d".repeat(24) }] : [];
      },
    },
    "./core/chat-history-import": {
      scanChatHistory: async () => {
        historyEntered.resolve();
        if (blockHistory) await historyRelease.promise;
        return {
          projects: blockHistory ? [{ id: "e".repeat(24) }] : [],
          calls: [],
        };
      },
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
      periodEnd: (now) => now,
      startOfRange: () => 0,
      filterCallsBetween: () => [],
      localDateKey: () => "2026-10-13",
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
    historyEntered,
    historyRelease,
    discoveryEntered,
    discoveryRelease,
    async storedProjects() {
      return readdir(join(directory, "projects"));
    },
    async removeStoredProjects() {
      for (const id of await readdir(join(directory, "projects")))
        await rm(join(directory, "projects", id), {
          recursive: true,
          force: true,
        });
    },
    async removeProjectsRoot() {
      await rm(join(directory, "projects"), { recursive: true, force: true });
    },
    exportUsage: () => commands.get("hoosage.export")(),
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
      historyRelease.resolve();
      discoveryRelease.resolve();
      await module.exports.deactivate();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const deletedProject = await harness({
  withWorkspace: true,
  seedTailerCall: true,
});
try {
  assert.equal((await deletedProject.api.getSnapshot()).calls.length, 1);
  await deletedProject.removeStoredProjects();
  assert.equal(
    (await deletedProject.api.getSnapshot()).calls.length,
    0,
    "Removed project directories must not retain warm tailer usage",
  );
} finally {
  await deletedProject.cleanup();
}

const deletedRoot = await harness({
  withWorkspace: true,
  seedTailerCall: true,
});
try {
  assert.equal((await deletedRoot.api.getSnapshot()).calls.length, 1);
  await deletedRoot.removeProjectsRoot();
  const snapshot = await deletedRoot.api.getSnapshot();
  assert.equal(
    snapshot.calls.length,
    0,
    "Removed storage roots must not retain stale usage in an error snapshot",
  );
  assert.equal(snapshot.errors.length, 0);
} finally {
  await deletedRoot.cleanup();
}

const indexingExport = await harness({ blockScan: true });
try {
  await indexingExport.scanEntered.promise;
  indexingExport.scanRelease.resolve();
  await indexingExport.api.getSnapshot();
  await indexingExport.exportUsage();
  assert.equal(
    indexingExport.counters.saveDialogs,
    0,
    "Export must not offer to save an incomplete indexing snapshot",
  );
  assert.equal(
    indexingExport.counters.informationMessages,
    1,
    "Export explains why indexing must finish first",
  );
} finally {
  await indexingExport.cleanup();
}

const importingExport = await harness({ blockHistory: true });
try {
  await importingExport.historyEntered.promise;
  assert.equal(
    (await importingExport.api.getSnapshot()).indexing,
    true,
    "Cached history loading must not mark an ongoing transcript scan complete",
  );
  await importingExport.exportUsage();
  assert.equal(
    importingExport.counters.saveDialogs,
    0,
    "Export must wait for transcript recovery as well as file tailing",
  );
  assert.equal(importingExport.counters.informationMessages, 1);
} finally {
  await importingExport.cleanup();
}

const failedSourceExport = await harness({
  withWorkspace: true,
  seedTailerCall: true,
  failTailer: true,
});
try {
  assert.equal((await failedSourceExport.api.getSnapshot()).errors.length, 1);
  await failedSourceExport.exportUsage();
  assert.equal(
    failedSourceExport.counters.saveDialogs,
    0,
    "Source errors must not export an incomplete warm snapshot",
  );
  assert.equal(failedSourceExport.counters.informationMessages, 1);
} finally {
  await failedSourceExport.cleanup();
}

for (const [name, option, entered, release] of [
  ["transcript import", "blockHistory", "historyEntered", "historyRelease"],
  [
    "workspace discovery",
    "blockDiscovery",
    "discoveryEntered",
    "discoveryRelease",
  ],
]) {
  const background = await harness({ [option]: true });
  try {
    await background[entered].promise;
    let stopResolved = false;
    const stopped = background.stop().then(() => {
      stopResolved = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      stopResolved,
      false,
      `Deactivation must await pending ${name}`,
    );
    background[release].resolve();
    await stopped;
    assert.deepEqual(
      await background.storedProjects(),
      [],
      `${name} must not create project records after disposal`,
    );
    assert.equal(
      background.counters.uiAfterDispose,
      0,
      `${name} must not update disposed UI`,
    );
    assert.equal(
      background.counters.timersAfterDispose,
      0,
      `${name} must not restart indexing after disposal`,
    );
  } finally {
    await background.cleanup();
  }
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
    collector.counters.scans,
    0,
    "Delayed collector setup must not start a new CLI scan after disposal",
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
  "HOOSAGE_EXTENSION_LIFECYCLE_OK: pending refresh/import/discovery disposal, no new scans/timers/UI/writes, delayed collector closure",
);
