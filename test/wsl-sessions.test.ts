import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
