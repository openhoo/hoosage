import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { parseLine } from "./parser";
import type { UsageCall } from "./types";

const MAX_LINE = 2 * 1024 * 1024;
const BATCH = 4 * 1024 * 1024;

/** Bounded incremental reads. Partial UTF-8 and lines survive polling boundaries.
 * Rotation/truncation resets the read cursor but not span deduplication. */
export class UsageTailer {
  readonly calls = new Map<string, UsageCall>();
  skippedLines = 0;
  ignoredLines = 0;
  processedLines = 0;
  private offset = 0;
  private inode?: number;
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private dropping = false;
  private busy = false;
  caughtUp = true;

  constructor(
    readonly path: string,
    readonly projectId: string,
  ) {}

  get readBytes(): number {
    return this.offset;
  }

  get bufferedBytes(): number {
    return Buffer.byteLength(this.pending, "utf8");
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const info = await stat(this.path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      });
      if (!info) return;
      if (this.inode !== info.ino || info.size < this.offset) {
        this.offset = 0;
        this.pending = "";
        this.dropping = false;
        this.decoder = new StringDecoder("utf8");
      }
      this.inode = info.ino;
      const length = Math.min(BATCH, info.size - this.offset);
      this.caughtUp = info.size <= this.offset + length;
      if (!length) return;
      const file = await open(this.path, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, this.offset);
        this.offset += bytesRead;
        this.consume(this.decoder.write(buffer.subarray(0, bytesRead)));
      } finally {
        await file.close();
      }
    } finally {
      this.busy = false;
    }
  }

  private consume(chunk: string): void {
    const lines = (this.pending + chunk).split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) {
      if (this.dropping) {
        this.dropping = false;
        continue;
      }
      if (!line.trim()) continue;
      this.processedLines++;
      if (line.length > MAX_LINE) {
        this.skippedLines++;
        continue;
      }
      try {
        const calls = parseLine(line, this.projectId);
        if (!calls.length) this.ignoredLines++;
        for (const call of calls)
          this.calls.set(call.id, call);
      } catch {
        this.skippedLines++;
      }
    }
    if (this.pending.length > MAX_LINE) {
      this.pending = "";
      this.dropping = true;
      this.skippedLines++;
    }
  }
}
