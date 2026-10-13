import { createHash } from "node:crypto";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { cacheFile, readCache, writeCache, type ScanCache } from "./scan-cache";
import { wslSessionSourceId } from "./path-identity";
import { validateCacheSubsets, type UsageCall } from "./types";

const MAX_LINE = 2 * 1024 * 1024;
const BATCH = 4 * 1024 * 1024;
const MAX_SKEW = 24 * 60 * 60 * 1000;
const EMPTY = Buffer.alloc(0);
/** Bump when the cached reader state changes shape. */
const CACHE_FORMAT = 8;
const SAVE_INTERVAL_MS = 30_000;

/** Attribution bucket for CLI sessions whose cwd matches no known project. */
export const CLI_PROJECT_ID = "copilot-cli";

/** Attribution bucket for JetBrains Copilot sessions whose cwd matches no
 * known project. JetBrains-hosted CLI sessions share the session-state tree;
 * they are identified by client_name in workspace.yaml. */
export const JETBRAINS_PROJECT_ID = "copilot-jetbrains";

/** client_name value the JetBrains Copilot plugin writes to workspace.yaml. */
const JETBRAINS_CLIENT = "copilot-intellij";

/** sha256 hex of the normalized folder path: absolute, forward slashes,
 * no trailing slash, lowercased. Local-only attribution key; never exported. */
export function folderPathHash(fsPath: string): string {
  let normalized = resolvePath(fsPath).replace(/\\/g, "/");
  while (normalized.length > 1 && normalized.endsWith("/"))
    normalized = normalized.slice(0, -1);
  return createHash("sha256").update(normalized.toLowerCase()).digest("hex");
}

interface ModelSnapshot {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  requests?: number;
  nanoAiu?: number;
  /** Last reliable cumulative cost, including snapshots with unknown delta. */
  observedNanoAiu?: number;
}

interface FileState {
  offset: number;
  inode?: number;
  /** Bytes after the last newline; always a partial line. */
  pending: Buffer;
  dropping: boolean;
  cwd?: string;
  /** An explicit event cwd (including invalid/null) overrides workspace.yaml. */
  cwdExplicit: boolean;
  /** Event ordinal within this file; disambiguates events lacking an id. */
  seq: number;
  emitted: Set<string>;
  /** Usage event IDs already applied to cumulative counters. */
  seenEvents: Set<string>;
  baselines: Map<string, ModelSnapshot>;
  /** Model resets already observed while this session total was unchanged. */
  modelResetTotals: Map<string, number>;
  /** workspace.yaml probe: undefined until read, null when absent/unreadable. */
  workspace?: { clientName?: string; cwd?: string } | null;
  /** Latest model the session named; receives session-level cost. */
  model?: string;
  /** Last raw session-level cumulative nano-AIU counter value. */
  totalRaw?: number;
  /** Sum of earlier counter runs (older CLIs restart the counter on resume). */
  totalOffset: number;
  /** Session-level nano-AIU already emitted as entries. */
  accounted: number;
  /** Reliable model-cost deltas accumulated independently of checkpoints. */
  modelCostTotal: number;
  /** Session cost outside model counters at a synchronized shutdown. */
  modelCostOffset: number;
}
const freshState = (): FileState => ({
  offset: 0,
  pending: EMPTY,
  dropping: false,
  cwdExplicit: false,
  seq: 0,
  emitted: new Set(),
  seenEvents: new Set(),
  baselines: new Map(),
  modelResetTotals: new Map(),
  totalOffset: 0,
  accounted: 0,
  modelCostTotal: 0,
  modelCostOffset: 0,
});

/** Read the CLI's small YAML subset, including plugin metadata nesting. Do
 * not select an arbitrary first value when attribution fields conflict. */
function parseWorkspace(content: string): {
  clientName?: string;
  cwd?: string;
} | null {
  const fields = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match =
      /^[ \t]*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(
        line,
      );
    if (!match) continue;
    const key = workspaceScalar(match[1]!);
    if (key !== "cwd" && key !== "client_name") continue;
    const value = workspaceScalar(match[2]!);
    if (value === undefined || (fields.has(key) && fields.get(key) !== value))
      return null;
    fields.set(key, value);
  }
  if (!fields.size) return null;
  return {
    clientName: fields.get("client_name") || undefined,
    cwd: fields.get("cwd") || undefined,
  };
}

function workspaceScalar(value: string): string | undefined {
  let parsed: string;
  if (value.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")(?:[ \t]+#.*)?[ \t]*$/.exec(value);
    if (!match) return undefined;
    try {
      parsed = JSON.parse(match[1]!) as string;
    } catch {
      return undefined;
    }
  } else if (value.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(?:[ \t]+#.*)?[ \t]*$/.exec(value);
    if (!match) return undefined;
    parsed = match[1]!.replace(/''/g, "'");
  } else {
    // A '#' in a plain path is literal unless whitespace precedes it.
    parsed = value.replace(/[ \t]+#.*$/, "").trim();
  }
  return parsed.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(parsed)
    ? parsed
    : undefined;
}

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const deltaCount = (current?: number, previous?: number) =>
  current === undefined ? undefined : Math.max(0, current - (previous ?? 0));

// A newly appearing cumulative cost cannot be assigned to just the latest
// interval if earlier snapshots for this model had no cost field.
const deltaReportedCost = (
  current: number | undefined,
  previous: ModelSnapshot | undefined,
): number | undefined => {
  if (current === undefined) return undefined;
  if (!previous) return current;
  if (previous.nanoAiu === undefined || current < previous.nanoAiu)
    return undefined;
  return current - previous.nanoAiu;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const modelName = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160) || undefined
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !value.includes("\0")
    ? value
    : undefined;

type CachedCall = Omit<
  UsageCall,
  "projectId" | "sessionId" | "source" | "failed"
> & { cwd?: string; cwdExplicit?: boolean };

/** Validates one cached file entry; undefined means "read the file again". */
function restoreFile(
  sessionId: string,
  value: unknown,
  sourceId?: string,
): { st: FileState; calls: CachedCall[] } | undefined {
  const saved = record(value);
  if (
    !saved ||
    !/^[^\\/\0]{1,255}$/.test(sessionId) ||
    sessionId === "." ||
    sessionId === ".."
  )
    return undefined;
  const offset = num(saved.offset);
  const seq = num(saved.seq);
  if (offset === undefined || seq === undefined) return undefined;
  const workspace = record(saved.workspace);
  const st: FileState = {
    ...freshState(),
    offset,
    inode:
      typeof saved.inode === "number" && Number.isFinite(saved.inode)
        ? saved.inode
        : undefined,
    dropping: saved.dropping === true,
    cwd: text(saved.cwd),
    cwdExplicit: saved.cwdExplicit === true,
    seq,
    workspace: workspace
      ? { clientName: text(workspace.clientName), cwd: text(workspace.cwd) }
      : undefined,
    model: modelName(saved.model),
    totalRaw: num(saved.totalRaw),
    totalOffset: num(saved.totalOffset) ?? 0,
    accounted: num(saved.accounted) ?? 0,
    modelCostTotal: num(saved.modelCostTotal) ?? 0,
    modelCostOffset: num(saved.modelCostOffset) ?? 0,
  };
  for (const [model, raw] of Object.entries(record(saved.baselines) ?? {})) {
    const baseline = record(raw);
    if (!model || !baseline) return undefined;
    st.baselines.set(model, {
      input: num(baseline.input),
      output: num(baseline.output),
      cacheRead: num(baseline.cacheRead),
      cacheWrite: num(baseline.cacheWrite),
      requests: num(baseline.requests),
      nanoAiu: num(baseline.nanoAiu),
      observedNanoAiu: num(baseline.observedNanoAiu),
    });
  }
  for (const [model, raw] of Object.entries(
    record(saved.modelResetTotals) ?? {},
  )) {
    const total = num(raw);
    if (!model || total === undefined) return undefined;
    st.modelResetTotals.set(model, total);
  }
  if (
    !Array.isArray(saved.seenEvents) ||
    saved.seenEvents.some((id) => typeof id !== "string")
  )
    return undefined;
  st.seenEvents = new Set(saved.seenEvents as string[]);
  if (!Array.isArray(saved.calls)) return undefined;
  const calls: CachedCall[] = [];
  for (const item of saved.calls) {
    const call = record(item);
    const id = call?.id;
    const timestamp = num(call?.timestamp);
    const model = modelName(call?.model);
    // Entries missing here would never be emitted again from the saved offset.
    if (
      !call ||
      typeof id !== "string" ||
      id.length > 2048 ||
      !id.startsWith(
        sourceId ? `wsl:${sourceId}:cli:${sessionId}:` : `cli:${sessionId}:`,
      ) ||
      timestamp === undefined ||
      !model
    )
      return undefined;
    calls.push({
      id,
      timestamp,
      model,
      input: num(call.input),
      output: num(call.output),
      cacheRead: num(call.cacheRead),
      cacheWrite: num(call.cacheWrite),
      requests: num(call.requests),
      nanoAiu: num(call.nanoAiu),
      ...(call.costIncludedInSessionTotal === true
        ? { costIncludedInSessionTotal: true as const }
        : {}),
      cwd: text(call.cwd),
      cwdExplicit: call.cwdExplicit === true,
    });
    st.emitted.add(id);
  }
  return { st, calls };
}

type Resolve = (cwd: string) => string | undefined;

/** Incremental reader for Copilot CLI session-state event streams
 * (<root>/<session-id>/events.jsonl). Only type, id, timestamp,
 * data.context.cwd, model names, data.modelMetrics and the session-level
 * totalNanoAiu are ever extracted — prompts and tool arguments in these files
 * are never retained. Shutdown metrics are cumulative per (session, model),
 * so each event emits the delta against the stored baseline; inputTokens
 * stays inclusive of cache tokens. The CLI resets modelMetrics on compaction
 * and omits sub-agent calls, so when the session-level cumulative
 * totalNanoAiu (usage checkpoints and shutdowns) is present it is
 * authoritative for cost: checkpoints emit cost-only increments (tokens and
 * requests are counted at shutdown) and each shutdown adds what is still
 * missing to the current model.
 *
 * With a cache, the reader state of each file (read position, cumulative
 * baselines and emitted entries) is saved locally, so a new window only
 * reads bytes appended since then. */
export class CliUsageScanner {
  readonly calls = new Map<string, UsageCall>();
  skippedLines = 0;
  caughtUp = true;
  detected = false;
  private readonly root: string;
  private readonly sourceId?: string;
  private readonly files = new Map<string, FileState>();
  /** Local-only cwd for reattributing a session when new workspaces appear. */
  private readonly callCwds = new Map<string, string>();
  /** Intervals with explicit cwd must never borrow a later resume's cwd. */
  private readonly callCwdExplicit = new Set<string>();
  private busy = false;
  private readonly cacheFile?: string;
  private restored = false;
  private dirty = false;
  private savedAt = -Infinity;

  constructor(
    root?: string,
    private readonly cache?: ScanCache,
    sourceId?: string,
  ) {
    this.root =
      root ??
      join(
        process.env.COPILOT_HOME || join(homedir(), ".copilot"),
        "session-state",
      );
    if (sourceId !== undefined && !/^[a-f0-9]{24}$/.test(sourceId))
      throw new Error("Invalid CLI source identity.");
    const distro =
      process.platform === "linux" ? process.env.WSL_DISTRO_NAME : undefined;
    this.sourceId =
      sourceId ?? (distro ? wslSessionSourceId(distro, this.root) : undefined);
    if (cache) this.cacheFile = cacheFile(cache, "cli", this.root);
  }

  async poll(resolve: Resolve): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.restored) {
        this.restored = true;
        await this.restore();
      }
      const rootInfo = await stat(this.root).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      });
      this.detected = rootInfo?.isDirectory() === true;
      if (!this.detected) {
        for (const sessionId of [...this.files.keys()]) this.forget(sessionId);
        this.caughtUp = true;
        if (this.dirty) await this.persist();
        return;
      }
      const entries = await readdir(this.root, { withFileTypes: true });
      let caughtUp = true;
      const sessions = entries.filter((entry) => entry.isDirectory());
      // Usage of removed session folders disappears, as it would after a
      // restart without cache.
      const listed = new Set(sessions.map((entry) => entry.name));
      for (const sessionId of [...this.files.keys()])
        if (!listed.has(sessionId)) this.forget(sessionId);
      for (let start = 0; start < sessions.length; start += 16) {
        const batch = await Promise.allSettled(
          sessions
            .slice(start, start + 16)
            .map((entry) => this.pollFile(entry.name, resolve)),
        );
        const failed = batch.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        if (
          batch.some((result) => result.status === "fulfilled" && !result.value)
        )
          caughtUp = false;
      }
      for (const [id, cwd] of this.callCwds) {
        const call = this.calls.get(id);
        if (call) {
          let projectId: string | undefined;
          try {
            projectId = resolve(cwd);
          } catch {
            /* Keep usage unassigned. */
          }
          call.projectId =
            projectId ??
            (call.source === "jetbrains"
              ? JETBRAINS_PROJECT_ID
              : CLI_PROJECT_ID);
        }
      }
      const wasCaughtUp = this.caughtUp;
      this.caughtUp = caughtUp;
      if (
        this.dirty &&
        (Date.now() - this.savedAt >= SAVE_INTERVAL_MS ||
          (caughtUp && !wasCaughtUp))
      )
        await this.persist();
    } finally {
      this.busy = false;
    }
  }

  private forget(sessionId: string): void {
    const st = this.files.get(sessionId);
    if (!st) return;
    for (const id of st.emitted) {
      this.calls.delete(id);
      this.callCwds.delete(id);
      this.callCwdExplicit.delete(id);
    }
    this.files.delete(sessionId);
    this.dirty = true;
  }

  /** Restores the reader state an earlier window saved for this folder. A
   * file entry that fails validation is dropped and read again. */
  private async restore(): Promise<void> {
    if (!this.cacheFile || !this.cache) return;
    const payload = await readCache(
      this.cacheFile,
      CACHE_FORMAT,
      this.cache.key,
      this.root,
    );
    const files = record(payload?.files);
    if (!payload || !files) return;
    this.skippedLines = num(payload.skippedLines) ?? 0;
    for (const [sessionId, value] of Object.entries(files)) {
      const restored = restoreFile(sessionId, value, this.sourceId);
      if (!restored) continue;
      const { st, calls } = restored;
      const source =
        st.workspace?.clientName === JETBRAINS_CLIENT ? "jetbrains" : "cli";
      for (const { cwd, cwdExplicit, ...call } of calls) {
        // Project attribution is resolved again at the end of each poll.
        this.calls.set(call.id, {
          ...call,
          projectId:
            source === "jetbrains" ? JETBRAINS_PROJECT_ID : CLI_PROJECT_ID,
          sessionId: this.sessionIdentity(sessionId),
          source,
          failed: false,
        });
        if (cwd) this.callCwds.set(call.id, cwd);
        if (cwdExplicit) this.callCwdExplicit.add(call.id);
      }
      this.files.set(sessionId, st);
    }
  }

  private async persist(): Promise<void> {
    if (!this.cacheFile || !this.cache) return;
    const files: Record<string, unknown> = {};
    for (const [sessionId, st] of this.files)
      files[sessionId] = {
        // Resume at the start of the unfinished line.
        offset: st.offset - st.pending.length,
        inode: st.inode,
        dropping: st.dropping,
        seq: st.seq,
        seenEvents: [...st.seenEvents],
        cwd: st.cwd,
        cwdExplicit: st.cwdExplicit,
        workspace: st.workspace ?? undefined,
        model: st.model,
        totalRaw: st.totalRaw,
        totalOffset: st.totalOffset,
        accounted: st.accounted,
        modelCostTotal: st.modelCostTotal,
        modelCostOffset: st.modelCostOffset,
        baselines: Object.fromEntries(st.baselines),
        modelResetTotals: Object.fromEntries(st.modelResetTotals),
        calls: [...st.emitted].flatMap((id) => {
          const call = this.calls.get(id);
          return call
            ? [
                {
                  id,
                  timestamp: call.timestamp,
                  model: call.model,
                  input: call.input,
                  output: call.output,
                  cacheRead: call.cacheRead,
                  cacheWrite: call.cacheWrite,
                  requests: call.requests,
                  nanoAiu: call.nanoAiu,
                  costIncludedInSessionTotal: call.costIncludedInSessionTotal,
                  cwd: this.callCwds.get(id),
                  cwdExplicit: this.callCwdExplicit.has(id),
                },
              ]
            : [];
        }),
      };
    this.dirty = false;
    this.savedAt = Date.now();
    const saved = await writeCache(
      this.cacheFile,
      CACHE_FORMAT,
      this.cache.key,
      this.root,
      { skippedLines: this.skippedLines, files },
    );
    if (!saved) this.dirty = true;
  }

  /** Returns false while the file still has unread bytes. */
  private async pollFile(
    sessionId: string,
    resolve: Resolve,
  ): Promise<boolean> {
    const path = join(this.root, sessionId, "events.jsonl");
    const file = await open(path, "r").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!file) {
      this.forget(sessionId);
      return true;
    }
    try {
      const info = await file.stat();
      if (!info.isFile()) {
        this.forget(sessionId);
        return true;
      }
      let st = this.files.get(sessionId) ?? freshState();
      if (st.inode !== info.ino || info.size < st.offset) {
        // Rotation or truncation: emitted calls and cumulative baselines
        // belong to the old stream and must not survive the reset.
        for (const id of st.emitted) {
          this.calls.delete(id);
          this.callCwds.delete(id);
          this.callCwdExplicit.delete(id);
        }
        st = freshState();
        this.dirty = true;
      }
      st.inode = info.ino;
      this.files.set(sessionId, st);
      if (st.workspace === undefined || st.workspace === null) {
        // workspace.yaml is written once at session start; a missing file is
        // re-probed on each poll so late writes are still picked up.
        const content = await readFile(
          join(this.root, sessionId, "workspace.yaml"),
          "utf8",
        ).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw error;
        });
        st.workspace = content === undefined ? null : parseWorkspace(content);
        if (st.workspace) {
          this.dirty = true;
          if (!st.cwdExplicit && st.cwd === undefined && st.workspace.cwd)
            st.cwd = st.workspace.cwd;
          // Re-tag calls emitted before the file appeared.
          for (const id of st.emitted) {
            const call = this.calls.get(id);
            if (!call) continue;
            if (
              !this.callCwds.has(id) &&
              !this.callCwdExplicit.has(id) &&
              st.workspace.cwd
            )
              this.callCwds.set(id, st.workspace.cwd);
            call.source =
              st.workspace.clientName === JETBRAINS_CLIENT
                ? "jetbrains"
                : "cli";
            // The final pass resolves each interval's own cwd. An interval
            // whose cwd was explicitly cleared remains in its source bucket.
            call.projectId =
              call.source === "jetbrains"
                ? JETBRAINS_PROJECT_ID
                : CLI_PROJECT_ID;
          }
        }
      }
      const length = Math.min(BATCH, info.size - st.offset);
      const caughtUp = info.size <= st.offset + length;
      if (!length) return caughtUp;
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, st.offset);
        st.offset += bytesRead;
        if (bytesRead) this.dirty = true;
        this.consume(sessionId, st, buffer.subarray(0, bytesRead), resolve);
      } catch {
        return false;
      }
      return caughtUp;
    } finally {
      await file.close();
    }
  }

  /** Splits on newline bytes, so a resumable position is always the start of
   * `pending` (UTF-8 never contains 0x0a inside a multi-byte character). */
  private consume(
    sessionId: string,
    st: FileState,
    chunk: Buffer,
    resolve: Resolve,
  ): void {
    const data = st.pending.length ? Buffer.concat([st.pending, chunk]) : chunk;
    const end = data.lastIndexOf(0x0a);
    // Copy, so the pending tail does not retain the whole read buffer.
    st.pending = Buffer.from(data.subarray(end + 1));
    const lines = end < 0 ? [] : data.toString("utf8", 0, end).split("\n");
    for (const line of lines) {
      if (st.dropping) {
        st.dropping = false;
        continue;
      }
      if (!line.trim()) continue;
      if (line.length > MAX_LINE) {
        this.skippedLines++;
        continue;
      }
      try {
        this.event(sessionId, st, line, resolve);
      } catch {
        this.skippedLines++;
      }
    }
    if (st.pending.length > MAX_LINE) {
      st.pending = EMPTY;
      st.dropping = true;
      this.skippedLines++;
    }
  }

  private event(
    sessionId: string,
    st: FileState,
    line: string,
    resolve: Resolve,
  ): void {
    const event = record(JSON.parse(line));
    if (!event) {
      this.skippedLines++;
      return;
    }
    st.seq++;
    if (event.type === "session.start" || event.type === "session.resume") {
      const context = record(record(event.data)?.context);
      if (context && Object.hasOwn(context, "cwd")) {
        st.cwdExplicit = true;
        st.cwd = text(context.cwd);
      }
      return;
    }
    if (event.type === "session.model_change") {
      const model = modelName(record(event.data)?.newModel);
      if (model) st.model = model;
      return;
    }
    if (event.type === "session.usage_checkpoint") {
      const data = record(event.data);
      const reported = num(data?.totalNanoAiu);
      if (reported === undefined) return;
      const stamp = this.stamp(event, st);
      if (!stamp) return;
      const caches = data?.modelCacheState;
      const model = modelName(
        Array.isArray(caches) ? record(caches[0])?.modelId : undefined,
      );
      if (model) st.model = model;
      const total = this.sessionTotal(st, reported);
      const increment = total - st.accounted;
      if (increment <= 0) return;
      st.accounted = total;
      // Cost only: tokens and requests of this interval arrive with the
      // shutdown's modelMetrics, so zero keeps them from being counted twice.
      this.emit(sessionId, st, resolve, {
        id: `cli:${sessionId}:${stamp.eventId}:${st.model ?? "unknown"}`,
        timestamp: stamp.timestamp,
        model: st.model ?? "unknown",
        input: 0,
        output: 0,
        requests: 0,
        nanoAiu: increment,
      });
      return;
    }
    if (event.type !== "session.shutdown") return;
    const stamp = this.stamp(event, st);
    if (!stamp) return;
    const { timestamp, eventId } = stamp;
    const data = record(event.data);
    const currentModel = modelName(data?.currentModel);
    if (currentModel) st.model = currentModel;
    // Session-level cost not yet emitted by earlier checkpoints/shutdowns.
    // Undefined keeps the per-model cost behaviour of CLIs without the total.
    let unassigned: number | undefined;
    const reportedTotal = num(data?.totalNanoAiu);
    if (reportedTotal !== undefined) {
      const total = this.sessionTotal(st, reportedTotal);
      unassigned = Math.max(0, total - st.accounted);
      st.accounted = Math.max(st.accounted, total);
    }
    const emitted = new Map<string, UsageCall>();
    const metrics = record(data?.modelMetrics) ?? {};
    let synchronizedModelCost = Object.keys(metrics).length > 0;
    for (const [model, raw] of Object.entries(metrics)) {
      if (!model) {
        synchronizedModelCost = false;
        continue;
      }
      const entry = record(raw);
      const usage = record(entry?.usage) ?? {};
      const snapshot: ModelSnapshot = {
        input: num(usage.inputTokens),
        output: num(usage.outputTokens),
        cacheRead: num(usage.cacheReadTokens),
        cacheWrite: num(usage.cacheWriteTokens),
        requests: num(record(entry?.requests)?.count),
        nanoAiu: num(entry?.totalNanoAiu),
      };
      validateCacheSubsets(snapshot);
      if (Object.values(snapshot).every((value) => value === undefined)) {
        synchronizedModelCost = false;
        continue;
      }
      let baseline = st.baselines.get(model);
      // CLI compaction/resume can restart model counters without a session
      // cost counter. A decreasing request counter (or both token counters)
      // identifies a new run; its first snapshot must count in full.
      const decreased = (current?: number, previous?: number) =>
        current !== undefined && previous !== undefined && current < previous;
      if (
        decreased(snapshot.requests, baseline?.requests) ||
        (decreased(snapshot.input, baseline?.input) &&
          decreased(snapshot.output, baseline?.output))
      ) {
        if (st.totalRaw !== undefined)
          st.modelResetTotals.set(model, st.totalRaw);
        baseline = undefined;
      }
      const observedCost = baseline?.observedNanoAiu ?? baseline?.nanoAiu;
      const costDecreased = decreased(snapshot.nanoAiu, observedCost);
      if (snapshot.nanoAiu === undefined || costDecreased)
        synchronizedModelCost = false;
      const delta: ModelSnapshot = {
        input: deltaCount(snapshot.input, baseline?.input),
        output: deltaCount(snapshot.output, baseline?.output),
        cacheRead: deltaCount(snapshot.cacheRead, baseline?.cacheRead),
        cacheWrite: deltaCount(snapshot.cacheWrite, baseline?.cacheWrite),
        requests: deltaCount(snapshot.requests, baseline?.requests),
        nanoAiu: deltaReportedCost(snapshot.nanoAiu, baseline),
      };
      validateCacheSubsets(delta);
      st.baselines.set(model, {
        input: snapshot.input ?? baseline?.input,
        output: snapshot.output ?? baseline?.output,
        cacheRead: snapshot.cacheRead ?? baseline?.cacheRead,
        cacheWrite: snapshot.cacheWrite ?? baseline?.cacheWrite,
        requests: snapshot.requests ?? baseline?.requests,
        // A falling cost without a token/request reset is unreliable, not a
        // new baseline. A genuinely missing field still breaks known coverage.
        nanoAiu: costDecreased ? baseline?.nanoAiu : snapshot.nanoAiu,
        observedNanoAiu:
          snapshot.nanoAiu === undefined || costDecreased
            ? observedCost
            : snapshot.nanoAiu,
      });
      // A newly known cumulative counter establishes covered model cost even
      // when its individual interval cannot be priced after a missing field.
      if (snapshot.nanoAiu !== undefined && !costDecreased)
        st.modelCostTotal += snapshot.nanoAiu - (observedCost ?? 0);
      if (
        !delta.input &&
        !delta.output &&
        !delta.cacheRead &&
        !delta.cacheWrite &&
        !delta.requests &&
        !delta.nanoAiu
      )
        continue;
      let nanoAiu = delta.nanoAiu;
      if (unassigned !== undefined) {
        // The session total already covers this model's cost; never exceed
        // it and never fall back to a token estimate on top of it.
        nanoAiu = Math.min(nanoAiu ?? 0, unassigned);
        unassigned -= nanoAiu;
      } else if (nanoAiu !== undefined) {
        // A checkpoint can cover model costs whose counters arrive later in
        // a shutdown that omits its session total. Only the cumulative model
        // cost beyond already emitted coverage is an additional charge.
        nanoAiu = Math.min(
          nanoAiu,
          Math.max(0, st.modelCostTotal + st.modelCostOffset - st.accounted),
        );
        st.accounted += nanoAiu;
      }
      emitted.set(
        model,
        this.emit(sessionId, st, resolve, {
          id: `cli:${sessionId}:${eventId}:${model}`,
          timestamp,
          model,
          input: delta.input,
          output: delta.output,
          cacheRead: delta.cacheRead,
          cacheWrite: delta.cacheWrite,
          requests: delta.requests,
          nanoAiu,
        }),
      );
    }
    if (reportedTotal !== undefined && synchronizedModelCost)
      // A simultaneous model snapshot establishes the covered boundary.
      // Any residual session cost is outside those counters, so future model
      // increments must not be suppressed by it. Total-only checkpoints keep
      // their coverage available for model counters that arrive later.
      st.modelCostOffset = Math.max(
        st.modelCostOffset,
        st.accounted - st.modelCostTotal,
      );
    if (!unassigned) return;
    const model = st.model ?? "unknown";
    const call = emitted.get(model);
    if (call) call.nanoAiu = (call.nanoAiu ?? 0) + unassigned;
    else
      this.emit(sessionId, st, resolve, {
        id: `cli:${sessionId}:${eventId}:${model}`,
        timestamp,
        model,
        input: 0,
        output: 0,
        requests: 0,
        nanoAiu: unassigned,
      });
  }

  /** Validated timestamp and a stable per-file event id. */
  private stamp(
    event: Record<string, unknown>,
    st: FileState,
  ): { timestamp: number; eventId: string } | undefined {
    const timestamp =
      typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
    if (
      !Number.isFinite(timestamp) ||
      timestamp < 0 ||
      timestamp > Date.now() + MAX_SKEW
    ) {
      this.skippedLines++;
      return undefined;
    }
    const eventId =
      typeof event.id === "string" && event.id
        ? event.id
        : typeof event.id === "number" && Number.isFinite(event.id)
          ? String(event.id)
          : // Events without an id fall back to timestamp + file ordinal, so
            // same-millisecond events cannot overwrite each other.
            `t${timestamp}-${st.seq}`;
    // Replayed events must not roll back baselines, restart session counters,
    // or overwrite an earlier emitted interval. Persist this across windows.
    if (st.seenEvents.has(eventId)) return undefined;
    st.seenEvents.add(eventId);
    return { timestamp, eventId };
  }

  /** Advances the session-level cumulative counter and returns the session
   * total. A drop means the CLI restarted its counters (older versions do on
   * resume): earlier runs stay counted and per-model baselines restart. */
  private sessionTotal(st: FileState, reported: number): number {
    // Newly available authoritative totals cover earlier token-only intervals.
    // Keep their individual costs unknown; suppress only their fallback estimate.
    for (const id of st.emitted) {
      const call = this.calls.get(id);
      if (call && call.nanoAiu === undefined)
        call.costIncludedInSessionTotal = true;
    }
    if (st.totalRaw !== undefined && reported < st.totalRaw) {
      st.totalOffset += st.totalRaw;
      // Model counters may have restarted before the session total did.
      // Preserve those new-run baselines instead of counting them twice.
      for (const model of st.baselines.keys())
        if (st.modelResetTotals.get(model) !== st.totalRaw)
          st.baselines.delete(model);
      st.modelResetTotals.clear();
    }
    st.totalRaw = reported;
    return st.totalOffset + reported;
  }

  private emit(
    sessionId: string,
    st: FileState,
    resolve: Resolve,
    call: Omit<UsageCall, "projectId" | "sessionId" | "source" | "failed">,
  ): UsageCall {
    const full: UsageCall = {
      ...call,
      id: this.sourceId ? `wsl:${this.sourceId}:${call.id}` : call.id,
      projectId: this.projectIdFor(st, resolve),
      sessionId: this.sessionIdentity(sessionId),
      source:
        st.workspace?.clientName === JETBRAINS_CLIENT ? "jetbrains" : "cli",
      failed: false,
    };
    this.calls.set(full.id, full);
    if (st.cwd) this.callCwds.set(full.id, st.cwd);
    if (st.cwdExplicit) this.callCwdExplicit.add(full.id);
    st.emitted.add(full.id);
    return full;
  }

  private sessionIdentity(sessionId: string): string {
    return this.sourceId ? `wsl:${this.sourceId}:${sessionId}` : sessionId;
  }

  /** Use the current project index; stored intervals are rechecked each poll. */
  private projectIdFor(st: FileState, resolve: Resolve): string {
    const fallback =
      st.workspace?.clientName === JETBRAINS_CLIENT
        ? JETBRAINS_PROJECT_ID
        : CLI_PROJECT_ID;
    if (st.cwd === undefined) return fallback;
    let projectId: string | undefined;
    try {
      projectId = resolve(st.cwd);
    } catch {
      projectId = undefined;
    }
    return projectId ?? fallback;
  }
}
