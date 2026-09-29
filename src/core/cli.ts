import { createHash } from "node:crypto";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { UsageCall } from "./types";

const MAX_LINE = 2 * 1024 * 1024;
const BATCH = 4 * 1024 * 1024;
const MAX_SKEW = 24 * 60 * 60 * 1000;

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
}

interface FileState {
  offset: number;
  inode?: number;
  decoder: StringDecoder;
  pending: string;
  dropping: boolean;
  cwd?: string;
  /** Event ordinal within this file; disambiguates events lacking an id. */
  seq: number;
  emitted: Set<string>;
  baselines: Map<string, ModelSnapshot>;
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
}
const freshState = (): FileState => ({
  offset: 0,
  decoder: new StringDecoder("utf8"),
  pending: "",
  dropping: false,
  seq: 0,
  emitted: new Set(),
  baselines: new Map(),
  totalOffset: 0,
  accounted: 0,
});

/** Minimal field extraction from workspace.yaml — a flat CLI-written file.
 * `client_name` and `cwd` are matched at any indentation (the plugin may nest
 * them under a metadata block); everything else is ignored. Quoting is
 * tolerated; a `#` starts a comment only after whitespace, so paths
 * containing `#` survive. */
function parseWorkspace(content: string): {
  clientName?: string;
  cwd?: string;
} {
  const field = (name: string): string | undefined => {
    const match = content.match(
      new RegExp(
        `^[ \\t]*${name}:[ \\t]*(?:["']([^"'\\n]*)["']|([^\\s#][^\\n]*?))(?:[ \\t]+#[^\\n]*)?[ \\t]*$`,
        "m",
      ),
    );
    const value = match?.[1] ?? match?.[2];
    return value?.trim() || undefined;
  };
  return { clientName: field("client_name"), cwd: field("cwd") };
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
 * missing to the current model. */
export class CliUsageScanner {
  readonly calls = new Map<string, UsageCall>();
  skippedLines = 0;
  caughtUp = true;
  detected = false;
  private readonly root: string;
  private readonly files = new Map<string, FileState>();
  /** Local-only cwd for reattributing a session when new workspaces appear. */
  private readonly callCwds = new Map<string, string>();
  private busy = false;

  constructor(root?: string) {
    this.root =
      root ??
      join(
        process.env.COPILOT_HOME || join(homedir(), ".copilot"),
        "session-state",
      );
  }

  async poll(resolve: Resolve): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const rootInfo = await stat(this.root).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      });
      this.detected = rootInfo?.isDirectory() === true;
      if (!this.detected) {
        this.caughtUp = true;
        return;
      }
      const entries = await readdir(this.root, { withFileTypes: true });
      let caughtUp = true;
      const sessions = entries.filter((entry) => entry.isDirectory());
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
      this.caughtUp = caughtUp;
    } finally {
      this.busy = false;
    }
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
    if (!file) return true;
    try {
      const info = await file.stat();
      if (!info.isFile()) return true;
      let st = this.files.get(sessionId) ?? freshState();
      if (st.inode !== info.ino || info.size < st.offset) {
        // Rotation or truncation: emitted calls and cumulative baselines
        // belong to the old stream and must not survive the reset.
        for (const id of st.emitted) {
          this.calls.delete(id);
          this.callCwds.delete(id);
        }
        st = freshState();
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
          if (st.cwd === undefined && st.workspace.cwd)
            st.cwd = st.workspace.cwd;
          // Re-tag calls emitted before the file appeared.
          for (const id of st.emitted) {
            const call = this.calls.get(id);
            if (!call) continue;
            if (!this.callCwds.has(id) && st.cwd) this.callCwds.set(id, st.cwd);
            call.source =
              st.workspace.clientName === JETBRAINS_CLIENT
                ? "jetbrains"
                : "cli";
            call.projectId = this.projectIdFor(st, resolve);
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
        this.consume(
          sessionId,
          st,
          st.decoder.write(buffer.subarray(0, bytesRead)),
          resolve,
        );
      } catch {
        return false;
      }
      return caughtUp;
    } finally {
      await file.close();
    }
  }

  private consume(
    sessionId: string,
    st: FileState,
    chunk: string,
    resolve: Resolve,
  ): void {
    const lines = (st.pending + chunk).split("\n");
    st.pending = lines.pop() ?? "";
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
      st.pending = "";
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
      const cwd = record(record(event.data)?.context)?.cwd;
      if (typeof cwd === "string" && cwd !== st.cwd) {
        st.cwd = cwd;
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
    for (const [model, raw] of Object.entries(metrics)) {
      if (!model) continue;
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
      if (
        !snapshot.input &&
        !snapshot.output &&
        !snapshot.cacheRead &&
        !snapshot.cacheWrite &&
        !snapshot.requests &&
        !snapshot.nanoAiu
      )
        continue;
      const baseline = st.baselines.get(model);
      const delta: ModelSnapshot = {
        input: deltaCount(snapshot.input, baseline?.input),
        output: deltaCount(snapshot.output, baseline?.output),
        cacheRead: deltaCount(snapshot.cacheRead, baseline?.cacheRead),
        cacheWrite: deltaCount(snapshot.cacheWrite, baseline?.cacheWrite),
        requests: deltaCount(snapshot.requests, baseline?.requests),
        nanoAiu: deltaReportedCost(snapshot.nanoAiu, baseline),
      };
      st.baselines.set(model, {
        input: snapshot.input ?? baseline?.input,
        output: snapshot.output ?? baseline?.output,
        cacheRead: snapshot.cacheRead ?? baseline?.cacheRead,
        cacheWrite: snapshot.cacheWrite ?? baseline?.cacheWrite,
        requests: snapshot.requests ?? baseline?.requests,
        nanoAiu: snapshot.nanoAiu,
      });
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
    const timestamp = Date.parse(event.timestamp as string);
    if (!Number.isFinite(timestamp) || timestamp > Date.now() + MAX_SKEW) {
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
    return { timestamp, eventId };
  }

  /** Advances the session-level cumulative counter and returns the session
   * total. A drop means the CLI restarted its counters (older versions do on
   * resume): earlier runs stay counted and per-model baselines restart. */
  private sessionTotal(st: FileState, reported: number): number {
    if (st.totalRaw !== undefined && reported < st.totalRaw) {
      st.totalOffset += st.totalRaw;
      st.baselines.clear();
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
      projectId: this.projectIdFor(st, resolve),
      sessionId,
      source:
        st.workspace?.clientName === JETBRAINS_CLIENT ? "jetbrains" : "cli",
      failed: false,
    };
    this.calls.set(full.id, full);
    if (st.cwd) this.callCwds.set(full.id, st.cwd);
    st.emitted.add(full.id);
    return full;
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
