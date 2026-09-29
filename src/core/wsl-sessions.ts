import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, win32 } from "node:path";
import { CliUsageScanner } from "./cli";
import type { UsageCall } from "./types";

// Reading \\wsl.localhost\<distro> starts a stopped distribution, so the
// running list is refreshed right before a read (at most every LIST_MAX_AGE_MS
// while catching up).
const LIST_MAX_AGE_MS = 5_000;
const SCAN_INTERVAL_MS = 15_000;
const DISCOVER_INTERVAL_MS = 60_000;
const DISTRO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Windows path for a Linux path inside a WSL distribution: DrvFs mounts
 * (/mnt/c/...) map back to the drive, everything else to the
 * \\wsl.localhost share that VS Code uses for opened WSL folders. */
export function wslPathToWindows(
  distro: string,
  path: string,
): string | undefined {
  if (!DISTRO_NAME.test(distro) || !path.startsWith("/")) return undefined;
  if (path.includes("\0")) return undefined;
  const drive = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(path);
  if (drive)
    return win32.normalize(
      `${drive[1]!.toUpperCase()}:\\${(drive[2] ?? "").replace(/\//g, "\\")}`,
    );
  return win32.normalize(
    `\\\\wsl.localhost\\${distro}${path.replace(/\//g, "\\")}`,
  );
}

/** Parses `wsl.exe --list --quiet` output, which is UTF-16LE on Windows. */
export function parseDistroList(output: Buffer): string[] {
  const text = output.includes(0)
    ? output.toString("utf16le")
    : output.toString("utf8");
  return [
    ...new Set(
      text
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .map((line) => line.replace(/\0/g, "").trim())
        .filter((name) => DISTRO_NAME.test(name)),
    ),
  ];
}

/** Only running distributions are listed, so hoosage never starts a WSL VM. */
export function runningWslDistros(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "wsl.exe",
      ["--list", "--running", "--quiet"],
      { encoding: "buffer", windowsHide: true, timeout: 10_000 },
      (error, stdout) => resolve(error ? [] : parseDistroList(stdout)),
    );
  });
}

type Resolve = (cwd: string) => string | undefined;

interface DistroScanner {
  distro: string;
  scanner: CliUsageScanner;
}

/** Reads Copilot CLI/JetBrains session-state of running WSL distributions from
 * Windows (`\\wsl.localhost\<distro>\home\<user>\.copilot\session-state`).
 * Linux working directories are translated to their Windows form before
 * project matching. Usage read earlier stays available while a distribution
 * is stopped; it is not re-read until the distribution runs again. */
export class WslCliSessions {
  private readonly scanners = new Map<string, DistroScanner>();
  private readonly discoveredAt = new Map<string, number>();
  private running: string[] = [];
  private checkedAt = -Infinity;
  private scannedAt = -Infinity;
  private busy = false;

  constructor(
    private readonly listDistros: () => Promise<string[]> = runningWslDistros,
    private readonly shareRoot = "\\\\wsl.localhost",
  ) {}

  get calls(): UsageCall[] {
    return [...this.scanners.values()].flatMap(({ scanner }) => [
      ...scanner.calls.values(),
    ]);
  }

  /** Stopped distributions are not read, so they cannot hold up indexing. */
  get caughtUp(): boolean {
    return [...this.scanners.values()].every(
      ({ distro, scanner }) =>
        scanner.caughtUp || !this.running.includes(distro),
    );
  }

  get skippedLines(): number {
    return [...this.scanners.values()].reduce(
      (n, { scanner }) => n + scanner.skippedLines,
      0,
    );
  }

  /** Session-state folders found in WSL; no paths are exposed. */
  get folderCount(): number {
    return this.scanners.size;
  }

  async poll(resolve: Resolve, now = Date.now()): Promise<void> {
    if (this.busy) return;
    if (this.caughtUp && now - this.scannedAt < SCAN_INTERVAL_MS) return;
    this.busy = true;
    try {
      this.scannedAt = now;
      if (now - this.checkedAt >= LIST_MAX_AGE_MS) {
        this.checkedAt = now;
        this.running = await this.listDistros();
      }
      for (const distro of this.running) {
        const seen = this.discoveredAt.get(distro);
        if (seen !== undefined && now - seen < DISCOVER_INTERVAL_MS) continue;
        this.discoveredAt.set(distro, now);
        await this.discover(distro);
      }
      for (const distro of this.discoveredAt.keys())
        if (!this.running.includes(distro)) this.discoveredAt.delete(distro);
      const failures: unknown[] = [];
      for (const [, { distro, scanner }] of this.scanners) {
        if (!this.running.includes(distro)) continue;
        try {
          await scanner.poll((cwd) => {
            const path = wslPathToWindows(distro, cwd);
            return path === undefined ? undefined : resolve(path);
          });
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw failures[0];
    } finally {
      this.busy = false;
    }
  }

  private async discover(distro: string): Promise<void> {
    const base = join(this.shareRoot, distro);
    const homes: string[] = [join(base, "root")];
    try {
      for (const entry of await readdir(join(base, "home"), {
        withFileTypes: true,
      }))
        if (entry.isDirectory()) homes.push(join(base, "home", entry.name));
    } catch {
      /* No readable /home in this distribution. */
    }
    for (const home of homes) {
      const root = join(home, ".copilot", "session-state");
      if (this.scanners.has(root)) continue;
      const info = await stat(root).catch(() => undefined);
      if (info?.isDirectory())
        this.scanners.set(root, {
          distro,
          scanner: new CliUsageScanner(root),
        });
    }
  }
}
