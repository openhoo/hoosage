import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { UsageCall } from "./types";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const sources = new Set(["chat", "cli", "jetbrains", "chat-history"]);

interface SharedEntry {
  version: 1;
  hostId: string;
  call: UsageCall;
}

interface PeerFile {
  offset: number;
  size: number;
  modified: number;
  identity: string;
  checkpoint: string;
  calls: Map<string, UsageCall>;
}

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function readCheckpoint(
  handle: FileHandle,
  offset: number,
): Promise<string> {
  const length = Math.min(offset, 256);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
  return createHash("sha256")
    .update(buffer.subarray(0, bytesRead))
    .digest("hex");
}

function validCall(value: unknown): value is UsageCall {
  if (typeof value !== "object" || value === null) return false;
  const call = value as Record<string, unknown>;
  const allowed = new Set([
    "id",
    "projectId",
    "timestamp",
    "model",
    "sessionId",
    "source",
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "nanoAiu",
    "requests",
    "durationMs",
    "failed",
  ]);
  return (
    Object.keys(call).every((key) => allowed.has(key)) &&
    typeof call.id === "string" &&
    call.id.length > 0 &&
    call.id.length <= 512 &&
    typeof call.projectId === "string" &&
    /^[a-f0-9]{24}$/.test(call.projectId) &&
    typeof call.timestamp === "number" &&
    Number.isFinite(call.timestamp) &&
    call.timestamp >= 0 &&
    call.timestamp <= 8_640_000_000_000_000 &&
    typeof call.model === "string" &&
    call.model.length <= 256 &&
    typeof call.failed === "boolean" &&
    (call.source === undefined ||
      (typeof call.source === "string" && sources.has(call.source))) &&
    (call.sessionId === undefined ||
      (typeof call.sessionId === "string" && call.sessionId.length <= 512)) &&
    (
      [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "nanoAiu",
        "requests",
        "durationMs",
      ] as const
    ).every(
      (key) =>
        call[key] === undefined ||
        (typeof call[key] === "number" &&
          Number.isFinite(call[key]) &&
          call[key] >= 0 &&
          (key === "durationMs" || Number.isSafeInteger(call[key]))),
    )
  );
}

function parseEntry(line: string, expectedHostId?: string): SharedEntry {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("A shared usage file contains malformed data.");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).some(
      (key) => !["version", "hostId", "call"].includes(key),
    ) ||
    (value as Record<string, unknown>).version !== 1 ||
    typeof (value as Record<string, unknown>).hostId !== "string" ||
    !/^[a-f0-9]{24}$/.test(
      (value as Record<string, unknown>).hostId as string,
    ) ||
    (expectedHostId !== undefined &&
      (value as Record<string, unknown>).hostId !== expectedHostId) ||
    !validCall((value as Record<string, unknown>).call)
  )
    throw new Error("A shared usage file contains an invalid entry.");
  return value as SharedEntry;
}

/** Exchanges sanitized usage records through a user-selected local directory.
 * Each VS Code session appends to its own file; host and call IDs deduplicate
 * records without exposing workspace paths or repository URLs. */
export class SharedUsageSync {
  private readonly directory: string;
  private readonly ownFile: string;
  private readonly written = new Map<string, string>();
  private readonly peerFiles = new Map<string, PeerFile>();
  private loadedOwnFile = false;

  constructor(
    sharedDirectory: string,
    groupId: string,
    private readonly hostId: string,
    sessionId: string,
  ) {
    if (!/^[a-f0-9]{24}$/.test(hostId))
      throw new Error("Invalid shared usage host identity.");
    if (!groupId.trim() || groupId.length > 128)
      throw new Error("Invalid shared usage group.");
    this.directory = join(sharedDirectory, hash(groupId.trim()));
    this.ownFile = join(this.directory, `${hostId}-${hash(sessionId)}.jsonl`);
  }

  async poll(
    localCalls: UsageCall[],
    currentProjectId: string,
  ): Promise<UsageCall[]> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (!this.loadedOwnFile) {
        await this.loadWritten();
        this.loadedOwnFile = true;
      }
      const pending: SharedEntry[] = [];
      const pendingKeys: [string, string][] = [];
      for (const call of localCalls) {
        if (!validCall(call) || call.projectId !== currentProjectId)
          throw new Error("Invalid usage entry cannot be shared.");
        const key = `${call.projectId}:${call.id}`;
        const fingerprint = JSON.stringify(call);
        if (this.written.get(key) === fingerprint) continue;
        pending.push({ version: 1, hostId: this.hostId, call });
        pendingKeys.push([key, fingerprint]);
      }
      if (pending.length) {
        const handle = await open(
          this.ownFile,
          constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_CREAT |
            (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          const fileStat = await handle.stat();
          if (!fileStat.isFile())
            throw new Error("A shared usage file is not a regular file.");
          const contents =
            pending.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
          if (fileStat.size + Buffer.byteLength(contents) > MAX_FILE_BYTES)
            throw new Error("A shared usage file exceeds the 64 MiB limit.");
          await handle.writeFile(contents, { encoding: "utf8" });
        } finally {
          await handle.close();
        }
      }
      for (const [key, fingerprint] of pendingKeys)
        this.written.set(key, fingerprint);

      const entries = await readdir(this.directory, { withFileTypes: true });
      const activeFiles = new Set<string>();
      for (const file of entries) {
        if (
          !file.isFile() ||
          !/^[a-f0-9]{24}-[a-f0-9]{64}\.jsonl$/.test(file.name)
        )
          continue;
        const sourceHostId = file.name.slice(0, 24);
        if (sourceHostId === this.hostId) continue;
        activeFiles.add(file.name);
        const path = join(this.directory, file.name);
        const handle = await open(
          path,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const fileStat = await handle.stat();
          if (!fileStat.isFile())
            throw new Error("A shared usage file is not a regular file.");
          if (fileStat.size > MAX_FILE_BYTES)
            throw new Error("A shared usage file exceeds the 64 MiB limit.");
          const identity = `${fileStat.dev}:${fileStat.ino}:${fileStat.birthtimeMs}`;
          let peer = this.peerFiles.get(file.name);
          if (
            !peer ||
            identity !== peer.identity ||
            fileStat.size < peer.size ||
            (fileStat.size === peer.size &&
              fileStat.mtimeMs !== peer.modified) ||
            (peer.offset > 0 &&
              (await readCheckpoint(handle, peer.offset)) !== peer.checkpoint)
          ) {
            peer = {
              offset: 0,
              size: 0,
              modified: 0,
              identity,
              checkpoint: "",
              calls: new Map(),
            };
          }
          const length = fileStat.size - peer.offset;
          if (length) {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(
              buffer,
              0,
              length,
              peer.offset,
            );
            const contentsBuffer = buffer.subarray(0, bytesRead);
            const newline = contentsBuffer.lastIndexOf(10);
            if (newline >= 0) {
              const contents = contentsBuffer
                .subarray(0, newline)
                .toString("utf8");
              const parsed: SharedEntry[] = [];
              for (const line of contents.split("\n")) {
                if (!line) continue;
                parsed.push(parseEntry(line, sourceHostId));
              }
              for (const entry of parsed) {
                const key = `${entry.hostId}:${entry.call.projectId}:${entry.call.id}`;
                peer.calls.set(key, entry.call);
              }
              peer.offset += newline + 1;
            }
          }
          peer.size = fileStat.size;
          peer.modified = fileStat.mtimeMs;
          peer.checkpoint = await readCheckpoint(handle, peer.offset);
          this.peerFiles.set(file.name, peer);
        } finally {
          await handle.close();
        }
      }
      for (const name of this.peerFiles.keys())
        if (!activeFiles.has(name)) this.peerFiles.delete(name);
      const seen = new Set<string>();
      const imported: UsageCall[] = [];
      // A restarted window writes a new session file. Prefer its refreshed
      // metadata over an older window's copy of the same request.
      for (const [, peer] of [...this.peerFiles.entries()].sort(
        ([nameA, a], [nameB, b]) =>
          b.modified - a.modified || nameA.localeCompare(nameB),
      ))
        for (const call of peer.calls.values())
          if (!seen.has(call.id)) {
            seen.add(call.id);
            imported.push({ ...call, projectId: currentProjectId });
          }
      return imported;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("A shared usage file") ||
          error.message.startsWith("Invalid shared usage") ||
          error.message.startsWith("Invalid usage entry"))
      )
        throw error;
      throw new Error("Could not access the configured shared usage folder.");
    }
  }

  private async loadWritten() {
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        this.ownFile,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const fileStat = await handle.stat();
      if (!fileStat.isFile())
        throw new Error("A shared usage file is not a regular file.");
      if (fileStat.size > MAX_FILE_BYTES)
        throw new Error("A shared usage file exceeds the 64 MiB limit.");
      const contents = await handle.readFile({ encoding: "utf8" });
      const loaded = new Map<string, string>();
      for (const line of contents.split("\n")) {
        if (!line) continue;
        const entry = parseEntry(line, this.hostId);
        loaded.set(
          `${entry.call.projectId}:${entry.call.id}`,
          JSON.stringify(entry.call),
        );
      }
      for (const [key, fingerprint] of loaded)
        this.written.set(key, fingerprint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    } finally {
      await handle?.close();
    }
  }
}
