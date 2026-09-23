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
}

interface FileState {
  offset: number;
  inode?: number;
  decoder: StringDecoder;
  pending: string;
  dropping: boolean;
  cwd?: string;
  projectId?: string;
  /** Event ordinal within this file; disambiguates events lacking an id. */
  seq: number;
  emitted: Set<string>;
  baselines: Map<string, ModelSnapshot>;
  /** workspace.yaml probe: undefined until read, null when absent/unreadable. */
  workspace?: { clientName?: string; cwd?: string } | null;
}
const freshState = (): FileState => ({
  offset: 0,
  decoder: new StringDecoder("utf8"),
  pending: "",
  dropping: false,
  seq: 0,
  emitted: new Set(),
  baselines: new Map(),
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

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

type Resolve = (cwd: string) => string | undefined;

/** Incremental reader for Copilot CLI session-state event streams
 * (<root>/<session-id>/events.jsonl). Only type, id, timestamp,
 * data.context.cwd and data.modelMetrics are ever extracted — prompts and
 * tool arguments in these files are never retained. Shutdown metrics are
 * cumulative per (session, model), so each event emits the delta against
 * the stored baseline; inputTokens stays inclusive of cache tokens. */
export class CliUsageScanner {
  readonly calls = new Map<string, UsageCall>();
  skippedLines = 0;
  caughtUp = true;
  detected = false;
  private readonly root: string;
  private readonly files = new Map<string, FileState>();
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
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!(await this.pollFile(entry.name, resolve))) caughtUp = false;
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
        for (const id of st.emitted) this.calls.delete(id);
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
          st.projectId = undefined;
          for (const id of st.emitted) {
            const call = this.calls.get(id);
            if (!call) continue;
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
        st.projectId = undefined;
      }
      return;
    }
    if (event.type !== "session.shutdown") return;
    const timestamp = Date.parse(event.timestamp as string);
    if (!Number.isFinite(timestamp) || timestamp > Date.now() + MAX_SKEW) {
      this.skippedLines++;
      return;
    }
    const metrics = record(record(event.data)?.modelMetrics);
    if (!metrics) return;
    const eventId =
      typeof event.id === "string" && event.id
        ? event.id
        : typeof event.id === "number" && Number.isFinite(event.id)
          ? String(event.id)
          : // Events without an id fall back to timestamp + file ordinal, so
            // same-millisecond shutdowns cannot overwrite each other.
            `t${timestamp}-${st.seq}`;
    for (const [model, raw] of Object.entries(metrics)) {
      if (!model) continue;
      const entry = record(raw);
      const usage = record(entry?.usage);
      if (!usage) continue;
      const snapshot: ModelSnapshot = {
        input: num(usage.inputTokens),
        output: num(usage.outputTokens),
        cacheRead: num(usage.cacheReadTokens),
        cacheWrite: num(usage.cacheWriteTokens),
        requests: num(record(entry?.requests)?.count),
      };
      if (
        !snapshot.input &&
        !snapshot.output &&
        !snapshot.cacheRead &&
        !snapshot.cacheWrite &&
        !snapshot.requests
      )
        continue;
      const baseline = st.baselines.get(model);
      const delta: ModelSnapshot = {
        input: deltaCount(snapshot.input, baseline?.input),
        output: deltaCount(snapshot.output, baseline?.output),
        cacheRead: deltaCount(snapshot.cacheRead, baseline?.cacheRead),
        cacheWrite: deltaCount(snapshot.cacheWrite, baseline?.cacheWrite),
        requests: deltaCount(snapshot.requests, baseline?.requests),
      };
      st.baselines.set(model, {
        input: snapshot.input ?? baseline?.input,
        output: snapshot.output ?? baseline?.output,
        cacheRead: snapshot.cacheRead ?? baseline?.cacheRead,
        cacheWrite: snapshot.cacheWrite ?? baseline?.cacheWrite,
        requests: snapshot.requests ?? baseline?.requests,
      });
      if (
        !delta.input &&
        !delta.output &&
        !delta.cacheRead &&
        !delta.cacheWrite &&
        !delta.requests
      )
        continue;
      const id = `cli:${sessionId}:${eventId}:${model}`;
      this.calls.set(id, {
        id,
        projectId: this.projectIdFor(st, resolve),
        timestamp,
        model,
        sessionId,
        source:
          st.workspace?.clientName === JETBRAINS_CLIENT ? "jetbrains" : "cli",
        input: delta.input,
        output: delta.output,
        cacheRead: delta.cacheRead,
        cacheWrite: delta.cacheWrite,
        requests: delta.requests,
        failed: false,
      });
      st.emitted.add(id);
    }
  }

  /** Resolved lazily at emit time; only positive matches are cached, so a
   * session whose project registers later can still be attributed. */
  private projectIdFor(st: FileState, resolve: Resolve): string {
    if (st.projectId) return st.projectId;
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
    if (projectId) st.projectId = projectId;
    return projectId ?? fallback;
  }
}
