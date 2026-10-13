import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { CliUsageScanner } from "../src/core/cli";
import { wslSessionSourceId } from "../src/core/path-identity";
import * as scanCache from "../src/core/scan-cache";
import { SharedUsageSync } from "../src/core/shared-usage-sync";
import {
  parseDistroList,
  WslCliSessions,
  wslPathToWindows,
} from "../src/core/wsl-sessions";

test("WSL paths map to the wsl.localhost share or DrvFs drives", () => {
  assert.equal(
    wslPathToWindows("VRKB", "/home/me/src/repo"),
    "\\\\wsl.localhost\\VRKB\\home\\me\\src\\repo",
  );
  assert.equal(
    wslPathToWindows("Ubuntu-24.04", "/mnt/c/Users/me/repo/"),
    "C:\\Users\\me\\repo\\",
  );
  assert.equal(wslPathToWindows("Debian", "/mnt/d"), "D:\\");
  assert.equal(
    wslPathToWindows("Debian", "/home/me/../other"),
    "\\\\wsl.localhost\\Debian\\home\\other",
  );
  assert.equal(wslPathToWindows("Debian", "relative/path"), undefined);
  assert.equal(wslPathToWindows("bad\\name", "/home/me"), undefined);
  assert.equal(wslPathToWindows("Debian", "/home/\0me"), undefined);
});

test("distribution list parsing handles UTF-16LE wsl.exe output", () => {
  const utf16 = Buffer.from("\uFEFFVRKB\r\nUbuntu-24.04\r\n\r\n", "utf16le");
  assert.deepEqual(parseDistroList(utf16), ["VRKB", "Ubuntu-24.04"]);
  assert.deepEqual(parseDistroList(Buffer.from("Debian\nDebian\n")), [
    "Debian",
  ]);
  assert.deepEqual(
    parseDistroList(Buffer.from("bad name\n..\\x\nok\n", "utf8")),
    ["ok"],
  );
});

const event = (value: Record<string, unknown>) => JSON.stringify(value) + "\n";

test("running distributions are read and cwd is resolved in Windows form", async () => {
  const share = await mkdtemp(join(tmpdir(), "hoosage-wsl-"));
  try {
    const sessions = join(
      share,
      "VRKB",
      "home",
      "me",
      ".copilot",
      "session-state",
    );
    await mkdir(join(sessions, "s1"), { recursive: true });
    await writeFile(
      join(sessions, "s1", "events.jsonl"),
      event({
        type: "session.start",
        timestamp: "2026-09-28T08:00:00Z",
        data: { context: { cwd: "/home/me/src/vrkb" } },
      }) +
        event({
          type: "session.usage_checkpoint",
          id: "c1",
          timestamp: "2026-09-28T08:10:00Z",
          data: {
            totalNanoAiu: 500_000_000_000,
            modelCacheState: [{ modelId: "gpt-5.6-sol" }],
          },
        }),
    );
    await mkdir(
      join(share, "Stopped", "home", "me", ".copilot", "session-state", "s2"),
      {
        recursive: true,
      },
    );
    let running = ["VRKB"];
    let listed = 0;
    const wsl = new WslCliSessions(async () => {
      listed++;
      return running;
    }, share);
    const seen: string[] = [];
    const resolve = (cwd: string) => {
      seen.push(cwd);
      return cwd === "\\\\wsl.localhost\\VRKB\\home\\me\\src\\vrkb"
        ? "project-vrkb"
        : undefined;
    };
    await wsl.poll(resolve, 0);
    assert.equal(wsl.folderCount, 1);
    assert.equal(wsl.caughtUp, true);
    assert.deepEqual(
      wsl.calls.map((call) => [call.projectId, call.nanoAiu, call.model]),
      [["project-vrkb", 500_000_000_000, "gpt-5.6-sol"]],
    );
    assert.ok(seen.every((cwd) => cwd.startsWith("\\\\wsl.localhost\\VRKB")));

    // Reads are throttled while caught up, the running list is refreshed
    // before a read, and stopped distributions keep their earlier usage.
    await wsl.poll(resolve, 1_000);
    assert.equal(listed, 1);
    running = [];
    await wsl.poll(resolve, 16_000);
    assert.equal(listed, 2);
    await appendFile(
      join(sessions, "s1", "events.jsonl"),
      event({
        type: "session.usage_checkpoint",
        id: "c2",
        timestamp: "2026-09-28T08:20:00Z",
        data: { totalNanoAiu: 700_000_000_000 },
      }),
    );
    await wsl.poll(resolve, 32_000);
    assert.equal(listed, 3);
    assert.equal(wsl.calls.length, 1);
    running = ["VRKB"];
    await wsl.poll(resolve, 48_000);
    assert.equal(listed, 4);
    assert.equal(wsl.calls.length, 2);
    assert.equal(wsl.calls[1]!.nanoAiu, 200_000_000_000);
  } finally {
    await rm(share, { recursive: true, force: true });
  }
});

test("no running distribution means nothing is read", async () => {
  const share = await mkdtemp(join(tmpdir(), "hoosage-wsl-"));
  try {
    const wsl = new WslCliSessions(async () => [], share);
    await wsl.poll(() => "p", 0);
    assert.equal(wsl.folderCount, 0);
    assert.deepEqual(wsl.calls, []);
    assert.equal(wsl.caughtUp, true);
  } finally {
    await rm(share, { recursive: true, force: true });
  }
});

test("Linux normalization precedes DrvFs mapping and unrepresentable names stay unassigned", () => {
  assert.equal(
    wslPathToWindows("Debian", "/mnt/c/../../home/me"),
    "\\\\wsl.localhost\\Debian\\home\\me",
  );
  assert.equal(wslPathToWindows("Debian", "/mnt/c/../d/repo"), "D:\\repo");
  for (const path of [
    "/home/me/literal\\name",
    "/home/me/file:stream",
    "/home/me/question?",
    "/home/me/control\nname",
  ])
    assert.equal(wslPathToWindows("Debian", path), undefined);
});

test("equal session IDs in separate WSL homes retain separate call and session identities", async () => {
  const share = await mkdtemp(join(tmpdir(), "hoosage-wsl-identities-"));
  const cache = { directory: join(share, "cache"), key: "test" };
  try {
    for (const [distro, home] of [
      ["One", "alice"],
      ["One", "bob"],
      ["Two", "alice"],
    ]) {
      const session = join(
        share,
        distro!,
        "home",
        home!,
        ".copilot",
        "session-state",
        "same-session",
      );
      await mkdir(session, { recursive: true });
      await writeFile(
        join(session, "events.jsonl"),
        event({
          type: "session.start",
          data: { context: { cwd: "/mnt/c/shared-project" } },
        }) +
          event({
            type: "session.shutdown",
            id: "same-event",
            timestamp: "2026-09-28T08:10:00Z",
            data: {
              modelMetrics: {
                "gpt-5.4": {
                  usage: { inputTokens: 100, outputTokens: 20 },
                  requests: { count: 1 },
                },
              },
            },
          }),
      );
    }
    const first = new WslCliSessions(async () => ["One", "Two"], share, cache);
    await first.poll(() => "shared-windows-project", 0);
    assert.equal(first.calls.length, 3);
    assert.equal(new Set(first.calls.map((call) => call.id)).size, 3);
    assert.equal(new Set(first.calls.map((call) => call.sessionId)).size, 3);
    const restarted = new WslCliSessions(
      async () => ["One", "Two"],
      share,
      cache,
    );
    await restarted.poll(() => "shared-windows-project", 0);
    assert.deepEqual(restarted.calls, first.calls);
    assert.ok(!JSON.stringify(first.calls).includes(share));
  } finally {
    await rm(share, { recursive: true, force: true });
  }
});

test("native WSL and Windows UNC reads share identical source identities across shared sync", async () => {
  const share = await mkdtemp(join(tmpdir(), "hoosage-wsl-shared-parity-"));
  try {
    const linuxRoot = "/home/alice/.copilot/session-state";
    const localRoot = join(
      share,
      "One",
      "home",
      "alice",
      ".copilot",
      "session-state",
    );
    const session = join(localRoot, "same-session");
    await mkdir(session, { recursive: true });
    await writeFile(
      join(session, "events.jsonl"),
      event({
        type: "session.start",
        data: { context: { cwd: "/mnt/c/shared-project" } },
      }) +
        event({
          type: "session.shutdown",
          id: "same-event",
          timestamp: "2026-09-28T08:10:00Z",
          data: {
            modelMetrics: {
              "gpt-5.4": {
                usage: { inputTokens: 100, outputTokens: 20 },
                requests: { count: 1 },
                totalNanoAiu: 100_000_000_000,
              },
            },
          },
        }),
    );
    const windowsProject = "1".repeat(24);
    const nativeProject = "2".repeat(24);
    const windows = new WslCliSessions(async () => ["One"], share);
    await windows.poll(() => windowsProject, 0);

    // Execute the actual scanner with synthetic native Linux process context
    // and map only its synthetic /home source to the fixture. This exercises
    // WSL_DISTRO_NAME inference on macOS without reading any personal history.
    const cliSource = join(__dirname, "../src/core/cli.ts");
    const require = createRequire(cliSource);
    const realFs = require("node:fs/promises");
    const mappedFs = Object.fromEntries(
      ["open", "readFile", "readdir", "stat"].map((method) => [
        method,
        (path: string, ...args: unknown[]) =>
          realFs[method](
            path === linuxRoot || path.startsWith(linuxRoot + "/")
              ? localRoot + path.slice(linuxRoot.length)
              : path,
            ...args,
          ),
      ]),
    );
    const module = { exports: {} };
    const code = transformSync(
      await readFile(cliSource, "utf8"),
      { loader: "ts", format: "cjs", target: "es2022" },
    ).code;
    vm.runInNewContext(code, {
      module,
      exports: module.exports,
      require: (id: string) =>
        id === "node:fs/promises"
          ? mappedFs
          : id === "./path-identity"
            ? { wslSessionSourceId }
            : id === "./scan-cache"
              ? scanCache
              : require(id),
      process: {
        platform: "linux",
        env: { WSL_DISTRO_NAME: "One", COPILOT_HOME: "/home/alice/.copilot" },
      },
      Buffer,
    });
    const NativeScanner = (
      module.exports as { CliUsageScanner: typeof CliUsageScanner }
    ).CliUsageScanner;
    const native = new NativeScanner();
    await native.poll(() => nativeProject);
    assert.equal(native.calls.size, 1);
    assert.equal([...native.calls.values()][0]!.id, windows.calls[0]!.id);
    assert.equal(
      [...native.calls.values()][0]!.sessionId,
      windows.calls[0]!.sessionId,
    );
    const shared = join(share, "shared");
    const writer = new SharedUsageSync(
      shared,
      "project",
      "a".repeat(24),
      "native",
    );
    const reader = new SharedUsageSync(
      shared,
      "project",
      "b".repeat(24),
      "windows",
    );
    await writer.poll([...native.calls.values()], nativeProject);
    const imported = await reader.poll([], windowsProject);
    const localIds = new Set(windows.calls.map((call) => call.id));
    assert.equal(imported.length, 1);
    assert.equal(
      imported.filter((call) => !localIds.has(call.id)).length,
      0,
      "the same physical usage is already read through UNC",
    );
    assert.ok(
      !JSON.stringify([
        ...native.calls.values(),
        ...windows.calls,
        ...imported,
      ]).includes("/home/alice"),
    );
  } finally {
    await rm(share, { recursive: true, force: true });
  }
});
