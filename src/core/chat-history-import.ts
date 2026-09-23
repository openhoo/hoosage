import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { folderPathHash } from "./cli";
import type { Project, UsageCall } from "./types";

/** Attribution bucket for Chat sessions VS Code stored without a folder. */
export const NO_FOLDER_CHAT_PROJECT_ID = "copilot-chat-no-folder";

/** Recovers historical Copilot Chat usage from this VS Code profile's own
 * chat transcripts (`workspaceStorage/<hash>/chatSessions` and
 * `globalStorage/emptyWindowChatSessions`). VS Code writes and keeps these
 * independently of hoosage's OTel exporter, so they cover usage from before
 * hoosage was installed, enabled, or opened in a project.
 *
 * Both formats are internal VS Code details: legacy `.json` snapshots and
 * `.jsonl` mutation logs (VS Code `ObjectMutationLog`: 0 = initial value,
 * 1 = set, 2 = array push with optional truncate index, 3 = delete). Reading
 * is defensive: a malformed line or file only loses that entry.
 *
 * Only an allowlist leaves this module: timestamps, model name, token counts,
 * Copilot-reported credits, duration and ids. Prompts, responses, tool data
 * and file paths are never copied. */

interface ChatRequest {
  requestId?: unknown;
  timestamp?: unknown;
  modelId?: unknown;
  isCanceled?: unknown;
  completionTokens?: unknown;
  promptTokens?: unknown;
  copilotCredits?: unknown;
  elapsedMs?: unknown;
  result?: {
    errorDetails?: { code?: unknown };
    timings?: { totalElapsed?: unknown };
    metadata?: {
      promptTokens?: unknown;
      outputTokens?: unknown;
      resolvedModel?: unknown;
      modelMessageId?: unknown;
      toolCallRounds?: unknown;
    };
  };
}

interface ChatSession {
  sessionId?: unknown;
  requests?: unknown;
}

type Path = (string | number)[];

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_MUTATION_DEPTH = 32;
const MAX_ARRAY_ITEMS = 100_000;
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

function safePath(value: unknown): value is Path {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_MUTATION_DEPTH &&
    value.every(
      (part) =>
        (typeof part === "string" &&
          part.length <= 256 &&
          !forbiddenKeys.has(part)) ||
        (typeof part === "number" &&
          Number.isSafeInteger(part) &&
          part >= 0 &&
          part < MAX_ARRAY_ITEMS),
    )
  );
}

function parent(state: unknown, path: Path): Record<string | number, unknown> | undefined {
  let node: unknown = state;
  for (let i = 0; i < path.length - 1; i++) {
    if (!node || typeof node !== "object" || !Object.hasOwn(node, path[i]!))
      return undefined;
    node = (node as Record<string | number, unknown>)[path[i]!];
  }
  return node && typeof node === "object"
    ? (node as Record<string | number, unknown>)
    : undefined;
}

/** Mirrors VS Code's ObjectMutationLog replay. */
export function replayMutationLog(raw: string): ChatSession | undefined {
  let state: unknown;
  let cursor = 0;
  while (cursor < raw.length) {
    const next = raw.indexOf("\n", cursor);
    const line = raw.slice(cursor, next < 0 ? raw.length : next);
    cursor = next < 0 ? raw.length : next + 1;
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        kind?: number;
        k?: Path;
        v?: unknown;
        i?: number;
      };
      if (entry.kind === 0) {
        if (entry.v && typeof entry.v === "object" && !Array.isArray(entry.v))
          state = entry.v;
        continue;
      }
      if (state === undefined || !safePath(entry.k))
        continue;
      const node = parent(state, entry.k);
      if (!node) continue;
      const key = entry.k[entry.k.length - 1]!;
      if (entry.kind === 1) {
        if (
          Array.isArray(node) &&
          key === "length" &&
          (!Number.isSafeInteger(entry.v) ||
            typeof entry.v !== "number" ||
            entry.v < 0 ||
            entry.v > MAX_ARRAY_ITEMS)
        )
          continue;
        node[key] = entry.v;
      }
      else if (entry.kind === 3) node[key] = undefined;
      else if (entry.kind === 2) {
        if (!Array.isArray(entry.v)) continue;
        const previous = Object.hasOwn(node, key) ? node[key] : undefined;
        if (previous !== undefined && !Array.isArray(previous)) continue;
        const array = previous ?? [];
        if (!Array.isArray(array)) continue;
        const nextLength = entry.i ?? array.length;
        if (entry.i !== undefined) {
          if (!Number.isSafeInteger(entry.i) || entry.i < 0 || entry.i > array.length)
            continue;
        }
        if (nextLength + entry.v.length > MAX_ARRAY_ITEMS) continue;
        array.length = nextLength;
        for (const item of entry.v) array.push(item);
        node[key] = array;
      }
    } catch {
      /* One malformed or out-of-order entry only loses that update. */
    }
  }
  return state && typeof state === "object" ? (state as ChatSession) : undefined;
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

function modelName(request: ChatRequest): string {
  const selected =
    typeof request.modelId === "string"
      ? request.modelId.slice(request.modelId.indexOf("/") + 1)
      : undefined;
  const resolved = request.result?.metadata?.resolvedModel;
  const name =
    selected && selected !== "auto"
      ? selected
      : typeof resolved === "string" && resolved
        ? resolved
        : "unknown";
  return name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160);
}

/** One transcript request -> one usage entry, or undefined when VS Code
 * recorded no completed result for it. Agent requests can make several model
 * calls ("tool call rounds"); VS Code records their summed output tokens and
 * Copilot-reported credits, but the prompt size only for the last round, so
 * input stays unknown unless the request made exactly one model call. */
export function requestUsage(
  request: ChatRequest,
  projectId: string,
  sessionId: string | undefined,
): (UsageCall & { dedupeKey: string }) | undefined {
  const timestamp = count(request.timestamp);
  const result = request.result;
  if (timestamp === undefined || !result || typeof result !== "object")
    return undefined;
  const metadata = result.metadata ?? {};
  const rounds = Array.isArray(metadata.toolCallRounds)
    ? metadata.toolCallRounds.length
    : undefined;
  const credits =
    typeof request.copilotCredits === "number" &&
    Number.isFinite(request.copilotCredits) &&
    request.copilotCredits >= 0
      ? request.copilotCredits
      : undefined;
  const singleCall = rounds === 1;
  const lastOutput = count(metadata.outputTokens);
  const output =
    count(request.completionTokens) ?? (singleCall ? lastOutput : undefined);
  const input = singleCall
    ? (count(metadata.promptTokens) ?? count(request.promptTokens))
    : undefined;
  const errorCode = result.errorDetails?.code;
  const identity =
    typeof metadata.modelMessageId === "string" && metadata.modelMessageId
      ? `message:${metadata.modelMessageId}`
      : typeof request.requestId === "string" && request.requestId
        ? `request:${request.requestId}`
        : `time:${projectId}:${sessionId ?? ""}:${timestamp}`;
  return {
    id: createHash("sha256")
      .update(`chat-history:${identity}`)
      .digest("hex")
      .slice(0, 24),
    dedupeKey: identity,
    projectId,
    timestamp,
    model: modelName(request),
    sessionId,
    source: "chat-history",
    input,
    output,
    nanoAiu:
      credits === undefined
        ? undefined
        : count(Math.round(credits * 1_000_000_000)),
    requests: rounds && rounds > 0 ? rounds : undefined,
    durationMs:
      count(request.elapsedMs) ?? count(result.timings?.totalElapsed),
    failed: Boolean(result.errorDetails) && errorCode !== "canceled",
  };
}

async function sessionCalls(
  file: string,
  projectId: string,
): Promise<(UsageCall & { dedupeKey: string })[]> {
  let session: ChatSession | undefined;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_SESSION_BYTES) return [];
    const raw = await readFile(file, "utf8");
    session = file.endsWith(".jsonl")
      ? replayMutationLog(raw)
      : (JSON.parse(raw) as ChatSession);
  } catch {
    return [];
  }
  if (!session || !Array.isArray(session.requests)) return [];
  const sessionId =
    typeof session.sessionId === "string" && session.sessionId
      ? session.sessionId
      : basename(file).replace(/\.jsonl?$/, "");
  return session.requests.slice(0, MAX_ARRAY_ITEMS).flatMap((request) => {
    if (!request || typeof request !== "object") return [];
    const call = requestUsage(request as ChatRequest, projectId, sessionId);
    return call ? [call] : [];
  });
}

async function directoryCalls(
  dir: string,
  projectId: string,
): Promise<(UsageCall & { dedupeKey: string })[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const calls: (UsageCall & { dedupeKey: string })[] = [];
  for (const file of files.filter((f) => /\.jsonl?$/.test(f)))
    for (const call of await sessionCalls(join(dir, file), projectId))
      calls.push(call);
  return calls;
}

const projectId = (identity: string) =>
  createHash("sha256").update(identity).digest("hex").slice(0, 24);

/** Maps a saved workspace record to the same project identity hoosage
 * derives for an open window: the hash of the workspace file URI, or of the
 * single folder URI. Remote and missing folders keep their own identity. */
function historyProject(
  record: { folder?: unknown; workspace?: unknown },
  lastUsedAt: number,
): Project | undefined {
  const workspace =
    typeof record.workspace === "string" ? record.workspace : undefined;
  const folder = typeof record.folder === "string" ? record.folder : undefined;
  const identity = workspace ?? folder;
  if (!identity) return undefined;
  let url: URL;
  try {
    url = new URL(identity);
  } catch {
    return undefined;
  }
  const segments = decodeURIComponent(url.pathname)
    .split("/")
    .filter(Boolean);
  const last = segments[segments.length - 1] ?? "Workspace";
  let pathHashes: string[] | undefined;
  if (folder && url.protocol === "file:")
    try {
      pathHashes = [folderPathHash(fileURLToPath(url))];
    } catch {
      /* A path that cannot be converted only loses CLI attribution. */
    }
  return {
    id: projectId(identity),
    name: workspace ? last.replace(/\.code-workspace$/i, "") : last,
    kind: workspace ? "workspace" : "folder",
    folderCount: workspace ? 0 : 1,
    createdAt: lastUsedAt,
    pathHashes,
  };
}

export interface ChatHistory {
  /** Projects that have at least one recovered Chat request. */
  projects: Project[];
  calls: UsageCall[];
}

const label = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160)
    : undefined;

/** Validates entries previously saved by `mergeStoredHistory`; anything that
 * is not part of the usage allowlist is dropped. */
export function restoreHistory(raw: unknown, projectId: string): UsageCall[] {
  const list = (raw as { calls?: unknown } | undefined)?.calls;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): UsageCall[] => {
    if (!item || typeof item !== "object") return [];
    const c = item as Record<string, unknown>;
    const id = label(c.id);
    const timestamp = count(c.timestamp);
    if (!id || !/^[a-f0-9]{24}$/.test(id) || timestamp === undefined)
      return [];
    return [
      {
        id,
        projectId,
        timestamp,
        model: label(c.model) ?? "unknown",
        sessionId: label(c.sessionId),
        source: "chat-history",
        input: count(c.input),
        output: count(c.output),
        nanoAiu: count(c.nanoAiu),
        requests: count(c.requests),
        durationMs: count(c.durationMs),
        failed: c.failed === true,
      },
    ];
  });
}

/** Adds newly recovered entries to the stored ones. Returns the merged list
 * and whether anything new was added, so callers only rewrite on change. */
export function mergeStoredHistory(
  stored: UsageCall[],
  recovered: UsageCall[],
): { calls: UsageCall[]; changed: boolean } {
  const byId = new Map(stored.map((c) => [c.id, c]));
  let changed = false;
  for (const call of recovered)
    if (!byId.has(call.id)) {
      byId.set(call.id, call);
      changed = true;
    }
  return {
    calls: [...byId.values()].sort((a, b) => a.timestamp - b.timestamp),
    changed,
  };
}

/** Treats the first day with live OTel capture as the start of live coverage.
 * Request IDs are not shared between VS Code transcripts and OTel spans, so
 * timing proximity cannot identify duplicates. Keep all imported requests
 * before that local day; retain later ones in storage for future recovery. */
export function withoutLiveOverlap(
  imported: UsageCall[],
  liveTimestamps: number[],
): UsageCall[] {
  if (!liveTimestamps.length) return imported;
  let first = Infinity;
  for (const timestamp of liveTimestamps)
    if (Number.isFinite(timestamp) && timestamp < first) first = timestamp;
  if (!Number.isFinite(first)) return imported;
  const day = new Date(first);
  const cutoff = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  return imported.filter((call) => call.timestamp < cutoff);
}

/** Scans every Chat transcript of this VS Code profile. The earliest copy of
 * a request wins when VS Code duplicated a session (for example after
 * continuing a chat in a new session), so copied requests count once. */
export async function scanChatHistory(
  globalStorageFsPath: string,
): Promise<ChatHistory> {
  const userDir = dirname(dirname(globalStorageFsPath));
  const storageRoot = join(userDir, "workspaceStorage");
  const found: (UsageCall & { dedupeKey: string })[] = [];
  const projects = new Map<string, Project>();
  let entries: string[] = [];
  try {
    entries = await readdir(storageRoot);
  } catch {
    /* No saved workspaces on this host. */
  }
  for (const entry of entries) {
    const dir = join(storageRoot, entry);
    let project: Project | undefined;
    try {
      project = historyProject(
        JSON.parse(await readFile(join(dir, "workspace.json"), "utf8")),
        0,
      );
    } catch {
      continue;
    }
    if (!project) continue;
    const calls = await directoryCalls(join(dir, "chatSessions"), project.id);
    if (!calls.length) continue;
    let createdAt = Infinity;
    for (const call of calls) {
      found.push(call);
      if (call.timestamp < createdAt) createdAt = call.timestamp;
    }
    const known = projects.get(project.id);
    projects.set(project.id, {
      ...project,
      createdAt: Math.min(createdAt, known?.createdAt ?? createdAt),
    });
  }
  const noFolder = await directoryCalls(
    join(userDir, "globalStorage", "emptyWindowChatSessions"),
    NO_FOLDER_CHAT_PROJECT_ID,
  );
  for (const call of noFolder) found.push(call);
  found.sort((a, b) => a.timestamp - b.timestamp);
  const seen = new Set<string>();
  const calls: UsageCall[] = [];
  for (const { dedupeKey, ...call } of found) {
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    calls.push(call);
  }
  return { projects: [...projects.values()], calls };
}
