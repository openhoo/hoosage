import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { open, readdir, readFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { folderPathHash } from "./cli";
import { exactFolderPathHash } from "./path-identity";
import { cacheFile, readCache, writeCache, type ScanCache } from "./scan-cache";
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

function parent(
  state: unknown,
  path: Path,
): Record<string | number, unknown> | undefined {
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
      if (state === undefined || !safePath(entry.k)) continue;
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
      } else if (entry.kind === 3) node[key] = undefined;
      else if (entry.kind === 2) {
        if (!Array.isArray(entry.v)) continue;
        const previous = Object.hasOwn(node, key) ? node[key] : undefined;
        if (previous !== undefined && !Array.isArray(previous)) continue;
        const array = previous ?? [];
        if (!Array.isArray(array)) continue;
        const nextLength = entry.i ?? array.length;
        if (entry.i !== undefined) {
          if (
            !Number.isSafeInteger(entry.i) ||
            entry.i < 0 ||
            entry.i > array.length
          )
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
  return state && typeof state === "object"
    ? (state as ChatSession)
    : undefined;
}

// Link request IDs to later model-message IDs without exporting or persisting
// additional fields on usage calls. The transcript cache stores hashes only.
const identityAliases = new WeakMap<UsageCall, string[]>();
const historyId = (identity: string) =>
  createHash("sha256")
    .update(`chat-history:${identity}`)
    .digest("hex")
    .slice(0, 24);

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
  const call: UsageCall & { dedupeKey: string } = {
    id: historyId(identity),
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
    durationMs: count(request.elapsedMs) ?? count(result.timings?.totalElapsed),
    failed: Boolean(result.errorDetails) && errorCode !== "canceled",
  };
  const aliases = [call.id];
  if (typeof request.requestId === "string" && request.requestId)
    aliases.push(historyId(`request:${request.requestId}`));
  identityAliases.set(call, [...new Set(aliases)]);
  return call;
}

type RecoveredCall = UsageCall & { dedupeKey: string };

interface TranscriptEntry {
  size: number;
  mtimeMs: number;
  projectId: string;
  calls: RecoveredCall[];
}

/** Results of transcripts parsed earlier, keyed by path below the VS Code
 * user folder; unchanged files (same size and modification time) are not
 * parsed again. */
interface TranscriptIndex {
  userDir: string;
  previous: Map<string, TranscriptEntry>;
  next: Map<string, TranscriptEntry>;
  changed: boolean;
}

const TRANSCRIPT_CACHE_FORMAT = 2;

async function sessionCalls(
  file: string,
  projectId: string,
  index?: TranscriptIndex,
): Promise<RecoveredCall[]> {
  let session: ChatSession | undefined;
  let info: Stats;
  let handle: FileHandle | undefined;
  const key = index ? relative(index.userDir, file) : "";
  try {
    // Checks and reads the same open file, so a replaced path cannot slip in.
    handle = await open(file, "r");
    info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SESSION_BYTES) return [];
    const cached = index?.previous.get(key);
    if (
      cached &&
      cached.size === info.size &&
      cached.mtimeMs === info.mtimeMs &&
      cached.projectId === projectId
    ) {
      index!.next.set(key, cached);
      return cached.calls;
    }
    const raw = await handle.readFile("utf8");
    session = file.endsWith(".jsonl")
      ? replayMutationLog(raw)
      : (JSON.parse(raw) as ChatSession);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
  const calls = requestCalls(file, session, projectId);
  if (index) {
    index.next.set(key, {
      size: info.size,
      mtimeMs: info.mtimeMs,
      projectId,
      calls,
    });
    index.changed = true;
  }
  return calls;
}

function requestCalls(
  file: string,
  session: ChatSession | undefined,
  projectId: string,
): RecoveredCall[] {
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
  index?: TranscriptIndex,
): Promise<RecoveredCall[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const calls: RecoveredCall[] = [];
  for (const file of files.filter((f) => /\.jsonl?$/.test(f)))
    for (const call of await sessionCalls(join(dir, file), projectId, index))
      calls.push(call);
  return calls;
}

async function loadTranscriptIndex(
  cache: ScanCache,
  userDir: string,
): Promise<TranscriptIndex> {
  const index: TranscriptIndex = {
    userDir,
    previous: new Map(),
    next: new Map(),
    changed: false,
  };
  const payload = await readCache(
    cacheFile(cache, "chat", userDir),
    TRANSCRIPT_CACHE_FORMAT,
    cache.key,
    userDir,
  );
  const files = payload?.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return index;
  for (const [key, value] of Object.entries(files)) {
    const entry = value as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.calls))
      continue;
    const size = count(entry.size);
    const mtimeMs = entry.mtimeMs;
    const projectId = label(entry.projectId);
    if (
      size === undefined ||
      typeof mtimeMs !== "number" ||
      !Number.isFinite(mtimeMs) ||
      !projectId
    )
      continue;
    const calls: RecoveredCall[] = [];
    for (const item of entry.calls) {
      const call = restoreCall(item, projectId);
      const dedupeKey = (item as { dedupeKey?: unknown } | null)?.dedupeKey;
      if (!call || typeof dedupeKey !== "string" || dedupeKey.length > 2048)
        break;
      const restored = { ...call, dedupeKey };
      const aliases = (item as { identityAliases?: unknown }).identityAliases;
      if (
        !Array.isArray(aliases) ||
        aliases.some(
          (alias) => typeof alias !== "string" || !/^[a-f0-9]{24}$/.test(alias),
        )
      )
        break;
      identityAliases.set(restored, aliases);
      calls.push(restored);
    }
    // A partly invalid entry is parsed again from the transcript.
    if (calls.length === entry.calls.length)
      index.previous.set(key, { size, mtimeMs, projectId, calls });
  }
  return index;
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
  const segments = decodeURIComponent(url.pathname).split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "Workspace";
  let pathHashes: string[] | undefined;
  let exactPathHashes: string[] | undefined;
  if (folder && url.protocol === "file:")
    try {
      const path = fileURLToPath(url);
      pathHashes = [folderPathHash(path)];
      exactPathHashes = [exactFolderPathHash(path)];
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
    exactPathHashes,
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
  const savedAliases = (raw as { identityAliases?: unknown } | undefined)
    ?.identityAliases;
  return list.flatMap((item): UsageCall[] => {
    const call = restoreCall(item, projectId);
    if (!call) return [];
    const aliases =
      savedAliases && typeof savedAliases === "object"
        ? (savedAliases as Record<string, unknown>)[call.id]
        : undefined;
    if (
      Array.isArray(aliases) &&
      aliases.every((id) => typeof id === "string" && /^[a-f0-9]{24}$/.test(id))
    )
      identityAliases.set(call, [...new Set([call.id, ...aliases])]);
    return [call];
  });
}

/** Hashed request/message aliases live beside calls in local storage. They
 * never become call properties or appear in dashboard and usage exports. */
export function storedHistoryPayload(calls: UsageCall[]) {
  return {
    version: 2,
    calls: calls.flatMap((call) => {
      const sanitized = restoreCall(call, call.projectId);
      return sanitized ? [sanitized] : [];
    }),
    identityAliases: Object.fromEntries(
      calls.flatMap((call) => {
        const aliases = identityAliases.get(call);
        return aliases && aliases.length > 1 ? [[call.id, aliases]] : [];
      }),
    ),
  };
}

function restoreCall(item: unknown, projectId: string): UsageCall | undefined {
  if (!item || typeof item !== "object") return undefined;
  const c = item as Record<string, unknown>;
  const id = label(c.id);
  const timestamp = count(c.timestamp);
  if (!id || !/^[a-f0-9]{24}$/.test(id) || timestamp === undefined)
    return undefined;
  return {
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
  };
}

/** Merges current transcript metadata into stored history. Completed results
 * can receive token/cost metadata later; retain the latest allowlisted fields
 * without moving a copied request to a different project or session. */
export function mergeStoredHistory(
  stored: UsageCall[],
  recovered: UsageCall[],
): { calls: UsageCall[]; changed: boolean } {
  const byId = new Map(stored.map((c) => [c.id, c]));
  let changed = false;
  const byAlias = new Map<string, UsageCall>();
  for (const call of stored)
    for (const alias of identityAliases.get(call) ?? [call.id])
      byAlias.set(alias, call);
  for (const call of recovered) {
    const aliases = identityAliases.get(call) ?? [call.id];
    const matches = [
      ...new Set(
        aliases.flatMap((id) => {
          const direct = byId.get(id);
          const linked = byAlias.get(id);
          return [direct, linked].filter(
            (value): value is UsageCall => value !== undefined,
          );
        }),
      ),
    ].sort((a, b) => a.timestamp - b.timestamp);
    const previous = matches[0];
    if (!previous) {
      byId.set(call.id, call);
      for (const alias of aliases) byAlias.set(alias, call);
      changed = true;
      continue;
    }
    // Transcript output, credits, duration and model-call rounds grow as a
    // request completes. Older copied snapshots cannot roll these back.
    const maximum = (a?: number, b?: number) =>
      a === undefined ? b : b === undefined ? a : Math.max(a, b);
    const requests = maximum(previous.requests, call.requests);
    const stale =
      (previous.requests !== undefined &&
        (call.requests === undefined || call.requests < previous.requests)) ||
      (previous.output !== undefined &&
        (call.output === undefined || call.output < previous.output));
    const updated: UsageCall = {
      ...previous,
      // Once a message ID arrived, an older request-only copy cannot move
      // the canonical identity back to its initial request ID.
      id:
        aliases.length === 1 && (identityAliases.get(previous)?.length ?? 0) > 1
          ? previous.id
          : call.id,
      model: call.model === "unknown" || stale ? previous.model : call.model,
      // Prompt size is only the last round's input once tool rounds grow.
      input:
        requests !== undefined && requests > 1
          ? undefined
          : stale
            ? previous.input
            : (call.input ?? previous.input),
      // A single round's fallback output is not a measured aggregate after
      // more rounds appear. Older lower-round copies cannot restore it.
      output:
        requests !== undefined &&
        previous.requests !== undefined &&
        requests > previous.requests &&
        call.output === undefined
          ? undefined
          : previous.requests !== undefined &&
              (call.requests === undefined || call.requests < previous.requests)
            ? previous.output
            : maximum(previous.output, call.output),
      nanoAiu: maximum(previous.nanoAiu, call.nanoAiu),
      requests,
      durationMs: maximum(previous.durationMs, call.durationMs),
      failed: stale ? previous.failed : call.failed,
    };
    const combinedAliases = [
      ...new Set(
        matches
          .flatMap((match) => identityAliases.get(match) ?? [match.id])
          .concat(aliases),
      ),
    ];
    identityAliases.set(updated, combinedAliases);
    const previousAliases = identityAliases.get(previous) ?? [previous.id];
    if (
      combinedAliases.some((alias) => !previousAliases.includes(alias)) ||
      updated.id !== previous.id ||
      matches.length > 1 ||
      updated.model !== previous.model ||
      updated.input !== previous.input ||
      updated.output !== previous.output ||
      updated.nanoAiu !== previous.nanoAiu ||
      updated.requests !== previous.requests ||
      updated.durationMs !== previous.durationMs ||
      updated.failed !== previous.failed
    ) {
      for (const match of matches) byId.delete(match.id);
      byId.set(updated.id, updated);
      for (const alias of combinedAliases) byAlias.set(alias, updated);
      changed = true;
    }
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
  const cutoff = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
  ).getTime();
  return imported.filter((call) => call.timestamp < cutoff);
}

/** Scans every Chat transcript of this VS Code profile. The earliest copy of
 * a request retains attribution when VS Code duplicates a session (for
 * example after continuing a chat); richer copied metadata is merged into
 * that request so usage counts once. With a
 * cache, only transcripts that changed since the last scan are parsed. */
export async function scanChatHistory(
  globalStorageFsPath: string,
  cache?: ScanCache,
): Promise<ChatHistory> {
  const userDir = dirname(dirname(globalStorageFsPath));
  const storageRoot = join(userDir, "workspaceStorage");
  const index = cache ? await loadTranscriptIndex(cache, userDir) : undefined;
  const found: RecoveredCall[] = [];
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
    const calls = await directoryCalls(
      join(dir, "chatSessions"),
      project.id,
      index,
    );
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
    index,
  );
  for (const call of noFolder) found.push(call);
  if (
    cache &&
    index &&
    (index.changed || index.next.size !== index.previous.size)
  )
    await writeCache(
      cacheFile(cache, "chat", userDir),
      TRANSCRIPT_CACHE_FORMAT,
      cache.key,
      userDir,
      {
        files: Object.fromEntries(
          [...index.next].map(([key, entry]) => [
            key,
            {
              ...entry,
              calls: entry.calls.map((call) => ({
                ...call,
                identityAliases: identityAliases.get(call) ?? [call.id],
              })),
            },
          ]),
        ),
      },
    );
  found.sort((a, b) => a.timestamp - b.timestamp);
  const recoveredCalls: UsageCall[] = [];
  for (const recovered of found) {
    const { dedupeKey, ...call } = recovered;
    identityAliases.set(call, identityAliases.get(recovered) ?? [call.id]);
    recoveredCalls.push(call);
  }
  // Earliest attribution stays fixed, while later copies can complete usage
  // and link request identities to their subsequently written message IDs.
  const calls = mergeStoredHistory([], recoveredCalls).calls;
  return { projects: [...projects.values()], calls };
}
