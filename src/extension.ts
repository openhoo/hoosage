import * as vscode from "vscode";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UsageTailer } from "./core/tailer";
import {
  CliUsageScanner,
  CLI_PROJECT_ID,
  JETBRAINS_PROJECT_ID,
  folderPathHash,
} from "./core/cli";
import { ProjectIndex } from "./core/project-index";
import {
  discoverKnownFolders,
  placeholderProject,
} from "./core/workspace-discovery";
import {
  mergeStoredHistory,
  NO_FOLDER_CHAT_PROJECT_ID,
  restoreHistory,
  scanChatHistory,
  withoutLiveOverlap,
} from "./core/chat-history-import";
import {
  isOwnCollectorHealth,
  startCollector,
  type Collector,
} from "./core/collector";
import {
  exportCsv,
  filterCalls,
  localDateKey,
  periodEnd,
  startOfRange,
  totals,
} from "./core/analytics";
import {
  costs,
  costLabel,
  costDescription,
  PRICING_DATE,
} from "./core/pricing";
import type { Project, Snapshot, UsageCall } from "./core/types";
import { registerWindow, routeWindow } from "./core/routing";
import { hasTelemetryEnvironmentConflict } from "./core/environment";

const KEYS = [
  "enabled",
  "exporterType",
  "outfile",
  "captureContent",
  "otlpEndpoint",
] as const;
const BACKUP = "copilotSettingsBackup";
type Connection = { port: number; token: string };
const parseConnection = (value: unknown): Connection | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const saved = value as Record<string, unknown>;
  return Number.isInteger(saved.port) &&
    (saved.port as number) > 1023 &&
    (saved.port as number) < 65536 &&
    typeof saved.token === "string" &&
    /^[a-f0-9]{48}$/.test(saved.token)
    ? { port: saved.port as number, token: saved.token }
    : undefined;
};
const connectionFromEndpoint = (value: unknown): Connection | undefined => {
  if (typeof value !== "string") return undefined;
  const match = /^http:\/\/127\.0\.0\.1:(\d{4,5})\/([a-f0-9]{48})$/.exec(value);
  return match
    ? parseConnection({ port: Number(match[1]), token: match[2] })
    : undefined;
};
const isStoredFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export async function activate(context: vscode.ExtensionContext) {
  if (!vscode.workspace.isTrusted) return;
  const storage = context.globalStorageUri.fsPath;
  const storeId = createHash("sha256")
    .update(storage)
    .digest("hex")
    .slice(0, 24);
  const root = join(storage, "projects");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const remoteName = vscode.env.remoteName?.toLowerCase();
  const remoteLabel = remoteName?.startsWith("wsl")
    ? "WSL"
    : remoteName?.startsWith("dev-container")
      ? "Dev Container"
      : "remote";
  const remoteUiFallback =
    Boolean(remoteName) &&
    vscode.extensions.getExtension("openhoo.hoosage")?.extensionKind ===
      vscode.ExtensionKind.UI;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const identity =
    vscode.workspace.workspaceFile?.toString() ?? folders[0]?.uri.toString();
  const current: Project | undefined =
    identity && !remoteUiFallback
      ? {
          id: createHash("sha256").update(identity).digest("hex").slice(0, 24),
          name: vscode.workspace.name ?? folders[0]?.name ?? "Workspace",
          kind:
            folders.length > 1 || vscode.workspace.workspaceFile
              ? "workspace"
              : "folder",
          folderCount: folders.length,
          createdAt: Date.now(),
          pathHashes: folders.map((f) => folderPathHash(f.uri.fsPath)),
        }
      : undefined;
  const capture = (id: string) => join(root, id, "copilot.jsonl");
  const tailers = new Map<string, UsageTailer>();
  const discovering = new Set<string>();
  const cliScanner = new CliUsageScanner();
  const views = new Set<vscode.Webview>();
  const diagnostics = vscode.window.createOutputChannel("hoosage tracking");
  context.subscriptions.push(diagnostics);
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    40,
  );
  statusBar.command = "hoosage.open";
  statusBar.name = "hoosage project usage";
  context.subscriptions.push(statusBar);
  let panel: vscode.WebviewPanel | undefined;
  let snapshot: Snapshot = {
    projects: current ? [current] : [],
    calls: [],
    currentProjectId: current?.id,
    status: "waiting",
    statusDetail: "Reading saved usage on this extension host…",
    updatedAt: Date.now(),
    skippedLines: 0,
    errors: [],
    indexing: true,
  };
  let refreshPromise: Promise<Snapshot> | undefined;
  let indexingTimer: ReturnType<typeof setTimeout> | undefined;
  let needsReload = false;
  let reloadPromptVersion = 0;
  let changingSettings = false;
  let collector: Collector | undefined;
  let collectorError: string | undefined;
  const config = () =>
    vscode.workspace.getConfiguration("github.copilot.chat.otel");
  let connection: Connection | undefined;
  try {
    connection = parseConnection(
      JSON.parse(await readFile(join(storage, "collector.json"), "utf8")),
    );
  } catch {
    /* A fresh profile has no connection until tracking is enabled. */
  }
  const c = config();
  const configured =
    c.get("enabled") === true &&
    c.get("exporterType") === "otlp-http" &&
    !c.get("outfile") &&
    c.get("captureContent") === false
      ? connectionFromEndpoint(c.get("otlpEndpoint"))
      : undefined;
  if (configured && !remoteUiFallback) {
    // VS Code's configured endpoint is authoritative for an existing local
    // setup. Rebind that exact port/token when collector.json is missing or
    // stale, so Copilot never keeps sending to an abandoned listener.
    if (
      !connection ||
      connection.port !== configured.port ||
      connection.token !== configured.token
    ) {
      connection = configured;
      await writeFile(
        join(storage, "collector.json"),
        JSON.stringify(configured),
        {
          mode: 0o600,
        },
      );
    }
    if (!context.globalState.get(BACKUP))
      await context.globalState.update(
        BACKUP,
        Object.fromEntries(KEYS.map((key) => [key, { value: undefined }])),
      );
  }
  let registrationError: string | undefined;
  let missingHistoryFile = false;
  if (current) {
    await mkdir(join(root, current.id), { recursive: true, mode: 0o700 });
    const existed = await isStoredFile(join(root, current.id, "project.json"));
    const hadHistory = await isStoredFile(capture(current.id));
    await persistProject(current);
    missingHistoryFile = existed && !hadHistory;
    if (!missingHistoryFile)
      await writeFile(capture(current.id), "", { flag: "a", mode: 0o600 });
    try {
      await registerWindow(storage, vscode.env.sessionId, current.id);
    } catch {
      registrationError =
        "This window was previously linked to another project. Open this project in a new window to keep usage separate.";
    }
  }

  // project.json is written once ("wx"); a stored file predating pathHashes is
  // upgraded in place so CLI sessions can be attributed to this project.
  async function persistProject(project: Project) {
    const metadata = join(root, project.id, "project.json");
    try {
      await writeFile(metadata, JSON.stringify(project), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stored: Project = JSON.parse(await readFile(metadata, "utf8"));
        if (!stored.pathHashes?.length && project.pathHashes?.length)
          await writeFile(
            metadata,
            JSON.stringify({ ...stored, pathHashes: project.pathHashes }),
            { mode: 0o600 },
          );
      } catch {
        /* A failed upgrade only delays CLI attribution to this project. */
      }
    }
  }

  // Register this profile's previously opened local folders in the background.
  // These are empty placeholders, not evidence of earlier Chat collection.
  // Remote workspace URIs have different identities and stay isolated.
  if (!remoteName)
    void (async () => {
      for (const folder of await discoverKnownFolders(storage)) {
        if (folder.id === current?.id) continue;
        discovering.add(folder.id);
        try {
          await mkdir(join(root, folder.id), { recursive: true, mode: 0o700 });
          await persistProject(placeholderProject(folder));
        } catch {
          /* One unavailable project directory does not block the rest. */
        } finally {
          discovering.delete(folder.id);
        }
      }
    })().catch(() => {
      /* A missing workspaceStorage directory leaves discovery best-effort. */
    });

  // Import earlier Chat usage that VS Code itself stored in its local Chat
  // transcripts, once per activation. Recovered entries are saved per project
  // (sanitized allowlist only) so they survive VS Code pruning its history.
  // Projects with recovered usage are registered even when the folder was
  // deleted, is remote, or is a multi-root workspace: their identity matches
  // what an open window would derive, so later live usage joins the same card.
  let chatHistory = new Map<string, UsageCall[]>();
  let chatHistoryComplete = Boolean(remoteName);
  const importedHistoryFile = (id: string) =>
    join(root, id, "chat-history.json");
  if (!remoteName)
    void (async () => {
      const recovered = new Map<string, UsageCall[]>();
      try {
        const scanned = await scanChatHistory(storage);
        for (const project of scanned.projects) {
          if (project.id === current?.id) continue;
          discovering.add(project.id);
          try {
            await mkdir(join(root, project.id), {
              recursive: true,
              mode: 0o700,
            });
            await persistProject(project);
          } catch {
            /* One unavailable project directory does not block the rest. */
          } finally {
            discovering.delete(project.id);
          }
        }
        for (const call of scanned.calls)
          recovered.set(call.projectId, [
            ...(recovered.get(call.projectId) ?? []),
            call,
          ]);
      } catch {
        /* Unreadable transcripts leave previously imported history intact. */
      }
      const result = new Map<string, UsageCall[]>();
      let ids: string[] = [];
      try {
        ids = await readdir(root);
      } catch {}
      for (const id of new Set([...ids, ...recovered.keys()])) {
        if (!/^[a-f0-9]{24}$/.test(id) && id !== NO_FOLDER_CHAT_PROJECT_ID)
          continue;
        let stored: UsageCall[] = [];
        try {
          stored = restoreHistory(
            JSON.parse(await readFile(importedHistoryFile(id), "utf8")),
            id,
          );
        } catch {}
        const merged = mergeStoredHistory(stored, recovered.get(id) ?? []);
        if (merged.changed)
          try {
            await mkdir(join(root, id), { recursive: true, mode: 0o700 });
            await writeFile(
              importedHistoryFile(id),
              JSON.stringify({ version: 1, calls: merged.calls }),
              { mode: 0o600 },
            );
          } catch {
            /* Unsaved entries are still shown and retried next activation. */
          }
        if (merged.calls.length) result.set(id, merged.calls);
      }
      chatHistory = result;
      chatHistoryComplete = true;
      // Transcript recovery runs in the background. Refresh once it finishes,
      // even when another snapshot was already being read at that moment.
      const pending = refreshPromise;
      if (pending) void pending.finally(() => void refresh());
      else void refresh();
    })();

  const endpoint = () =>
    connection
      ? `http://127.0.0.1:${connection.port}/${connection.token}`
      : undefined;
  const canStopTracking = () =>
    Boolean(context.globalState.get(BACKUP)) &&
    config().get("enabled") === true;

  async function ensureCollector(force = false) {
    if (!connection) {
      try {
        connection = parseConnection(
          JSON.parse(await readFile(join(storage, "collector.json"), "utf8")),
        );
      } catch {}
    }
    if (
      !current ||
      !connection ||
      collector ||
      (!force &&
        (config().get("enabled") !== true ||
          config().get("otlpEndpoint") !== endpoint()))
    )
      return;
    collectorError = undefined;
    try {
      collector = await startCollector({
        ...connection,
        projectId: "host",
        file: "",
        storeId,
        route: (sessionId) => routeWindow(storage, sessionId),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        try {
          const response = await fetch(`${endpoint()}/health`, {
            signal: AbortSignal.timeout(1500),
            redirect: "error",
          });
          const health = await response.json();
          if (isOwnCollectorHealth(health, storeId)) return; // Another window owns this profile's collector.
          collectorError =
            "The configured collector belongs to another VS Code profile or extension host. Tracking is blocked to keep projects separate; run Diagnose Tracking.";
          return;
        } catch {
          /* A different listener must not receive project telemetry. */
        }
      }
      collectorError =
        "The local collector port is unavailable. Stop the conflicting listener and refresh; usage is not being collected.";
    }
  }

  function blocker(): string | undefined {
    if (remoteUiFallback)
      return `Hoosage is running locally while this project is in ${remoteLabel}. Install Hoosage on the remote workspace host and reload the window. Use Diagnose Tracking to inspect this window.`;
    if (registrationError) return registrationError;
    if (!current || !folders.length)
      return canStopTracking()
        ? "Tracking is enabled for other VS Code windows. Open a project folder to view usage, or stop tracking here."
        : "Open a project folder to track Copilot Chat. Previously opened local folders and completed local CLI and JetBrains sessions are indexed in the background.";
    // Newer VS Code builds bundle Copilot without exposing a separate extension
    // object. Feature-detect its registered setting instead of an extension ID.
    if (config().inspect("otlpEndpoint")?.defaultValue === undefined)
      return "Install or enable Copilot, then update VS Code to a version that supports OpenTelemetry export.";
    if (
      vscode.workspace.getConfiguration("telemetry").get("telemetryLevel") ===
      "off"
    )
      return "VS Code telemetry is off, which also disables Copilot’s local exporter. hoosage respects this setting.";
    if (
      hasTelemetryEnvironmentConflict(
        process.env,
        config().get("enabled") === true &&
          config().get("otlpEndpoint") === endpoint()
          ? endpoint()
          : undefined,
      )
    )
      return "Copilot telemetry environment overrides are present. Remove them before enabling project-isolated tracking.";
    return undefined;
  }

  async function readSnapshot(): Promise<Snapshot> {
    const projects: Project[] = [];
    const errors: string[] = [];
    if (missingHistoryFile)
      errors.push(
        "Saved Chat history is missing for this previously registered project on this host. Check the original VS Code profile or remote host.",
      );
    await ensureCollector();
    const ids = (await readdir(root)).filter((id) => /^[a-f0-9]{24}$/.test(id));
    for (let start = 0; start < ids.length; start += 8)
      await Promise.all(
        ids.slice(start, start + 8).map(async (id) => {
          try {
            const project: Project = JSON.parse(
              await readFile(join(root, id, "project.json"), "utf8"),
            );
            if (project.id !== id || typeof project.name !== "string") return;
            projects.push(project);
            if (!tailers.has(id))
              tailers.set(id, new UsageTailer(capture(id), id));
            await tailers.get(id)!.poll();
          } catch (error) {
            // The background registrar may have created the directory while
            // project.json is still being written. The next refresh sees it.
            if (
              discovering.has(id) &&
              (error as NodeJS.ErrnoException).code === "ENOENT"
            )
              return;
            errors.push(
              `Could not read local usage for ${id.slice(0, 8)}. Check storage permissions and refresh.`,
            );
          }
        }),
      );
    if (current && !projects.some((p) => p.id === current.id))
      projects.unshift(current);
    const projectIndex = new ProjectIndex(projects);
    try {
      await cliScanner.poll((cwd) => projectIndex.resolve(cwd));
    } catch {
      errors.push(
        "Could not read Copilot CLI session data. Check storage permissions and refresh.",
      );
    }
    const calls = [
      ...[...tailers.values()].flatMap((t) => [...t.calls.values()]),
      ...cliScanner.calls.values(),
    ];
    for (const [id, imported] of chatHistory) {
      const live = tailers.get(id);
      for (const call of withoutLiveOverlap(
        imported,
        live
          ? [...live.calls.values()]
              .filter((c) => !c.source || c.source === "chat")
              .map((c) => c.timestamp)
          : [],
      )) calls.push(call);
    }
    projects.push(
      ...projectIndex
        .projects([...cliScanner.calls.values()])
        .filter(
          (project) => !projects.some((known) => known.id === project.id),
        ),
    );
    for (const [bucketId, bucketName, kind] of [
      [CLI_PROJECT_ID, "Copilot CLI", "cli"],
      [JETBRAINS_PROJECT_ID, "Copilot (JetBrains)", "jetbrains"],
      [NO_FOLDER_CHAT_PROJECT_ID, "Copilot Chat (no folder)", "chat"],
    ] as const) {
      const bucketCalls = calls.filter((c) => c.projectId === bucketId);
      if (bucketCalls.length && !projects.some((p) => p.id === bucketId))
        projects.push({
          id: bucketId,
          name: bucketName,
          kind,
          folderCount: 0,
          createdAt: bucketCalls.reduce((first, call) => Math.min(first, call.timestamp), Infinity),
        });
    }
    const problem = blocker() ?? collectorError;
    const connected =
      current &&
      connection &&
      config().get("enabled") === true &&
      config().get("otlpEndpoint") === endpoint() &&
      config().get("exporterType") === "otlp-http" &&
      !config().get("outfile") &&
      config().get("captureContent") === false;
    const settingsMismatch =
      current && connection && config().get("enabled") === true && !connected;
    const currentCalls = calls.filter((c) => c.projectId === current?.id);
    const status = problem
      ? "blocked"
      : needsReload
        ? "reload"
        : !connected
          ? "off"
          : currentCalls.length
            ? "active"
            : "waiting";
    const statusDetail =
      problem ??
      (needsReload
        ? "Reload VS Code to apply the Copilot exporter settings."
        : !connected
          ? settingsMismatch
            ? "Copilot telemetry settings do not match the local collector. Run Diagnose Tracking to inspect this window."
            : "Enable Copilot Chat tracking once for open projects. Completed local CLI and JetBrains sessions are indexed automatically."
          : currentCalls.length
            ? "Tracking enabled for all open projects. Updates every 5 seconds."
            : remoteName
              ? `Collector ready on the ${remoteLabel} host. Run Copilot Chat, then Diagnose Tracking to confirm a Chat span arrives here.`
              : "This project is registered automatically. Use Copilot Chat to record usage; reload if you just enabled tracking.");
    const indexing =
      [...tailers.values()].some((t) => !t.caughtUp) ||
      !cliScanner.caughtUp;
    return {
      projects,
      calls,
      currentProjectId: current?.id,
      status,
      statusDetail,
      canStopTracking: canStopTracking(),
      updatedAt: Date.now(),
      skippedLines:
        [...tailers.values()].reduce((n, t) => n + t.skippedLines, 0) +
        cliScanner.skippedLines,
      errors,
      indexing,
    };
  }

  async function refresh(): Promise<Snapshot> {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        snapshot = await readSnapshot();
      } catch {
        snapshot = {
          ...snapshot,
          status: "blocked",
          statusDetail:
            "Local storage could not be read. Check permissions and refresh.",
          indexing: false,
          errors: [
            "Local storage could not be read. Check permissions and refresh.",
          ],
        };
      }
      const today = totals(filterCalls(snapshot.calls, current?.id ?? "", 1));
      const todayCost = costs(
        filterCalls(snapshot.calls, current?.id ?? "", 1),
      );
      const number = new Intl.NumberFormat("en", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(today.tokens);
      statusBar.text = snapshot.indexing
        ? "$(sync~spin) hoosage"
        : snapshot.status === "active"
          ? `$(graph) ${costLabel(todayCost)} · ${number} tokens`
          : "$(graph) hoosage";
      statusBar.tooltip = snapshot.indexing
        ? "hoosage · Indexing saved usage on this host. Totals will appear when the scan completes."
        : `hoosage · ${current?.name ?? "No project"}\n${today.calls} model calls today · ${today.missingUsage} with incomplete token data\nUSD: ${costDescription(todayCost)}\n${snapshot.statusDetail}`;
      vscode.workspace.getConfiguration("hoosage").get("showStatusBar")
        ? statusBar.show()
        : statusBar.hide();
      for (const view of views)
        void view.postMessage({ type: "snapshot", snapshot });
      return snapshot;
    })().finally(() => {
      refreshPromise = undefined;
      if (snapshot.indexing && !indexingTimer)
        indexingTimer = setTimeout(() => {
          indexingTimer = undefined;
          void refresh();
        }, 250);
    });
    return refreshPromise;
  }

  async function diagnosticLines(): Promise<string[]> {
    const state = await refresh();
    let collectorReachable = false;
    if (connection) {
      try {
        const response = await fetch(`${endpoint()}/health`, {
          signal: AbortSignal.timeout(1500),
          redirect: "error",
        });
        collectorReachable =
          response.ok && isOwnCollectorHealth(await response.json(), storeId);
      } catch {
        /* An unreachable collector is reported below without its URL. */
      }
    }
    const chatCalls = state.calls.filter(
      (call) => call.projectId === current?.id && !call.source,
    );
    const registered = state.projects.find((p) => p.id === current?.id);
    const history = current ? tailers.get(current.id) : undefined;
    const historyFile = current
      ? await stat(capture(current.id)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw error;
        })
      : undefined;
    const location = !remoteName
      ? "Local extension host"
      : remoteUiFallback
        ? `Local UI host for ${remoteLabel} workspace`
        : `${remoteLabel} workspace host`;
    return [
      "hoosage tracking diagnostics",
      `VS Code application: ${vscode.env.appName}`,
      `Extension host: ${location}`,
      `Extension storage fingerprint: ${storeId}`,
      `Current project ID: ${current?.id ?? "none"}`,
      `Current project name: ${current?.name ?? "none"}`,
      `Current project registered here: ${registered ? "yes" : "no"}`,
      `Project record created here: ${registered && Number.isFinite(registered.createdAt) ? new Date(registered.createdAt).toISOString() : "unknown"}`,
      `Saved Chat entries for this project on this host: ${chatCalls.length}`,
      `Imported earlier Chat requests for this project: ${current ? (chatHistory.get(current.id)?.length ?? 0) : 0}`,
      `Earlier Chat history import complete here: ${chatHistoryComplete ? "yes" : "no"}`,
      `Saved Chat history file for this project: ${historyFile?.isFile() ? "present" : "missing"}`,
      `Saved Chat history file size: ${historyFile?.isFile() ? `${historyFile.size} bytes` : "unavailable"}`,
      `Saved Chat history file last modified: ${historyFile?.isFile() ? historyFile.mtime.toISOString() : "unavailable"}`,
      `Saved Chat history bytes read here: ${history?.readBytes ?? 0}`,
      `Saved Chat history complete lines processed here: ${history?.processedLines ?? 0}`,
      `Saved Chat history lines ignored as non-Chat here: ${history?.ignoredLines ?? 0}`,
      `Saved Chat history invalid lines skipped here: ${history?.skippedLines ?? 0}`,
      `Saved Chat history bytes awaiting a newline here: ${history?.bufferedBytes ?? 0}`,
      `Collector configuration: ${connection ? "present" : "missing"}`,
      `Copilot endpoint matches collector: ${connection && config().get("otlpEndpoint") === endpoint() ? "yes" : "no"}`,
      `Collector reachable here: ${collectorReachable ? "yes" : "no"}`,
      `Tracking status: ${state.status}`,
      `Indexing saved usage: ${state.indexing ? "yes" : "no"}`,
      `Chat history scan complete here: ${history?.caughtUp ? "yes" : "no"}`,
      `Local CLI session scan complete here: ${cliScanner.caughtUp ? "yes" : "no"}`,
      ...(remoteUiFallback
        ? [
            `Next step: install Hoosage inside the ${remoteLabel} workspace, then reload.`,
          ]
        : remoteName
          ? [
              "Remote delivery is confirmed only after a real Copilot Chat span appears in this host's saved entries.",
            ]
          : []),
      "If older history is missing, check the original VS Code profile and extension host. Hoosage cannot recreate events that were never saved there.",
    ];
  }

  async function showDiagnostics() {
    diagnostics.clear();
    diagnostics.appendLine((await diagnosticLines()).join("\n"));
    diagnostics.show(true);
  }

  async function reloadPrompt() {
    needsReload = true;
    const version = ++reloadPromptVersion;
    await refresh();
    void Promise.resolve(
      vscode.window.showInformationMessage(
        "hoosage: Reload the window to apply Copilot tracking settings.",
        "Reload window",
      ),
    )
      .then(async (answer) => {
        if (answer && version === reloadPromptVersion)
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
      })
      .catch(() => {
        /* The prompt is optional; the dashboard still exposes Reload window. */
      });
  }

  async function enable() {
    if (changingSettings) return;
    const problem = blocker();
    if (problem) {
      await vscode.window.showWarningMessage(problem);
      return;
    }
    if (!current) return;
    changingSettings = true;
    try {
      const c = config();
      if (c.get("enabled") && c.get("otlpEndpoint") !== endpoint()) {
        const choice = await vscode.window.showWarningMessage(
          "VS Code already exports Copilot telemetry. hoosage will replace that destination with a local collector for all windows and disable content capture. Window IDs keep projects separate. Previous user settings are restored when tracking is stopped.",
          { modal: true },
          "Use hoosage locally",
        );
        if (!choice) return;
      }
      if (!context.globalState.get(BACKUP)) {
        const previous = Object.fromEntries(
          KEYS.map((key) => [key, { value: c.inspect(key)?.globalValue }]),
        );
        await context.globalState.update(BACKUP, previous);
      }
      await mkdir(join(root, current.id), { recursive: true, mode: 0o700 });
      await persistProject(current);
      // The collector persists only allowlisted usage metadata, never raw payloads.
      await writeFile(capture(current.id), "", { flag: "a", mode: 0o600 });
      if (!connection) {
        const token = randomBytes(24).toString("hex"); // hooray:allow-secret — runtime-generated collector URL token, not a stored credential
        const candidate = await startCollector({
          port: 0,
          token,
          projectId: "host",
          file: "",
          storeId,
          route: (sessionId) => routeWindow(storage, sessionId),
        });
        connection = { port: candidate.port, token };
        try {
          await writeFile(
            join(storage, "collector.json"),
            JSON.stringify(connection),
            { flag: "wx", mode: 0o600 },
          );
          collector = candidate;
        } catch (error) {
          await candidate.close();
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          connection = parseConnection(
            JSON.parse(await readFile(join(storage, "collector.json"), "utf8")),
          );
          if (!connection) throw new Error("Invalid local collector settings.");
        }
      }
      await ensureCollector(true);
      if (collectorError) throw new Error(collectorError);
      const desired: Record<string, unknown> = {
        captureContent: false,
        exporterType: "otlp-http",
        outfile: "",
        otlpEndpoint: endpoint(),
        enabled: true,
      };
      try {
        for (const [key, value] of Object.entries(desired))
          await c.update(key, value, vscode.ConfigurationTarget.Global);
        if (KEYS.some((key) => config().get(key) !== desired[key]))
          throw new Error("A managed policy overrides the exporter settings.");
      } catch (error) {
        await restoreSettings();
        throw error;
      }
      await reloadPrompt();
    } catch {
      await vscode.window.showErrorMessage(
        "hoosage could not configure the local exporter. User settings or enterprise policies may prevent this change.",
      );
    } finally {
      changingSettings = false;
    }
  }

  async function restoreSettings() {
    const backup =
      context.globalState.get<Record<string, { value?: unknown }>>(BACKUP);
    if (!backup) return;
    const owned: Record<string, unknown> = {
      enabled: true,
      exporterType: "otlp-http",
      outfile: "",
      captureContent: false,
      otlpEndpoint: endpoint(),
    };
    const c = config();
    // Only restore values still owned by hoosage; preserve subsequent user edits.
    for (const key of KEYS) {
      if (c.inspect(key)?.globalValue === owned[key])
        await c.update(
          key,
          backup[key]?.value,
          vscode.ConfigurationTarget.Global,
        );
    }
    await context.globalState.update(BACKUP, undefined);
  }

  async function disable() {
    if (changingSettings) return;
    changingSettings = true;
    try {
      await restoreSettings();
      await collector?.close();
      collector = undefined;
      collectorError = undefined;
      await reloadPrompt();
    } catch {
      await vscode.window.showErrorMessage(
        "Could not restore Copilot workspace settings. Please check workspace write permissions.",
      );
    } finally {
      changingSettings = false;
    }
  }

  async function exportUsage(
    projectId = "all",
    days = 30,
    format = "csv",
    endDate?: string,
  ) {
    const end = periodEnd(Date.now(), endDate);
    if (end === undefined) return;
    const calls = filterCalls(snapshot.calls, projectId, days, end);
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        `hoosage-${localDateKey(startOfRange(days, end))}-to-${localDateKey(end)}.${format}`,
      ),
      filters: format === "csv" ? { CSV: ["csv"] } : { JSON: ["json"] },
    });
    if (!uri) return;
    const content =
      format === "csv"
        ? exportCsv(calls)
        : JSON.stringify(
            {
              schemaVersion: 2,
              measurement:
                "Observed Copilot Chat spans and CLI session summaries; not GitHub billing",
              exportedAt: new Date().toISOString(),
              cost: costs(calls),
              priceTableDate: PRICING_DATE,
              projects: snapshot.projects
                .filter((p) => projectId === "all" || p.id === projectId)
                .map(({ pathHashes, ...p }) => p),
              calls,
            },
            null,
            2,
          );
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
    await vscode.window.showInformationMessage(
      `Exported ${calls.length} usage entries.`,
    );
  }

  function attach(webview: vscode.Webview) {
    views.add(webview);
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "dist"),
        vscode.Uri.joinPath(context.extensionUri, "media"),
      ],
    };
    const nonce = randomBytes(24).toString("base64");
    const resource = (path: string) =>
      esc(
        webview
          .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, path))
          .toString(),
      );
    webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};"><title>hoosage</title><link rel="stylesheet" href="${resource("media/app.css")}"></head><body><div id="app" aria-busy="true"><p class="loading">Loading usage…</p></div><script nonce="${nonce}" src="${resource("dist/webview.js")}"></script></body></html>`;
    const subscription = webview.onDidReceiveMessage(
      async (message: unknown) => {
        if (!message || typeof message !== "object") return;
        const m = message as Record<string, unknown>;
        try {
          switch (m.type) {
            case "ready":
              await webview.postMessage({ type: "snapshot", snapshot });
              break;
            case "refresh":
              await refresh();
              break;
            case "diagnose":
              await showDiagnostics();
              break;
            case "enable":
              await enable();
              break;
            case "disable":
              await disable();
              break;
            case "open":
              await vscode.commands.executeCommand("hoosage.open");
              break;
            case "reload":
              await vscode.commands.executeCommand(
                "workbench.action.reloadWindow",
              );
              break;
            case "settings":
              await vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "@ext:openhoo.hoosage",
              );
              break;
            case "export":
              if (
                typeof m.projectId === "string" &&
                (m.projectId === "all" ||
                  snapshot.projects.some((p) => p.id === m.projectId)) &&
                [7, 14, 30].includes(Number(m.days)) &&
                (m.endDate === undefined ||
                  (typeof m.endDate === "string" &&
                    periodEnd(Date.now(), m.endDate) !== undefined)) &&
                ["csv", "json"].includes(String(m.format))
              )
                await exportUsage(
                  m.projectId,
                  Number(m.days),
                  String(m.format),
                  m.endDate as string | undefined,
                );
              break;
          }
        } catch {
          await vscode.window.showErrorMessage(
            "hoosage could not complete this action. Check file permissions and try again.",
          );
        }
      },
    );
    return () => {
      views.delete(webview);
      subscription.dispose();
    };
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("hoosage.open", () => {
      if (panel) {
        panel.reveal();
        return;
      }
      panel = vscode.window.createWebviewPanel(
        "hoosage.dashboard",
        "hoosage",
        vscode.ViewColumn.One,
        { retainContextWhenHidden: true },
      );
      panel.iconPath = vscode.Uri.joinPath(
        context.extensionUri,
        "media/mark.svg",
      );
      const dispose = attach(panel.webview);
      panel.onDidDispose(() => {
        dispose();
        panel = undefined;
      });
    }),
    vscode.commands.registerCommand("hoosage.enable", enable),
    vscode.commands.registerCommand("hoosage.disable", disable),
    vscode.commands.registerCommand("hoosage.refresh", refresh),
    vscode.commands.registerCommand("hoosage.diagnose", showDiagnostics),
    vscode.commands.registerCommand("hoosage.export", () => exportUsage()),
    vscode.window.registerWebviewViewProvider("hoosage.overview", {
      resolveWebviewView(view) {
        const dispose = attach(view.webview);
        view.onDidDispose(dispose);
      },
    }),
    vscode.workspace.onDidChangeConfiguration(() => {
      void refresh();
    }),
  );
  const timer = setInterval(() => {
    void refresh();
  }, 5_000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(timer);
      if (indexingTimer) clearTimeout(indexingTimer);
      panel?.dispose();
      void collector?.close();
    },
  });
  void refresh();
  // Read-only API used by the real extension-host integration test.
  return { getSnapshot: refresh, getDiagnostics: diagnosticLines };
}
