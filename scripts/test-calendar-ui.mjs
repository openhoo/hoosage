import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chromeCandidates = process.env.CHROME_BIN
  ? [process.env.CHROME_BIN]
  : process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];
let chrome;
for (const candidate of chromeCandidates) {
  try {
    await access(candidate);
    chrome = candidate;
    break;
  } catch {
    /* Check the next browser location. */
  }
}
assert.ok(chrome, "Chrome or Chromium is required for the calendar UI test");
const profile = await mkdtemp(join(tmpdir(), "hoosage-calendar-"));
const routes = new Map([
  [
    "/",
    [
      "text/html",
      '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body class="vscode-dark"><div id="app"></div><script src="/webview.js"></script></body></html>',
    ],
  ],
  ["/app.css", ["text/css", "media/app.css"]],
  ["/webview.js", ["text/javascript", "dist/webview.js"]],
]);
const server = createServer(async (request, response) => {
  const route = routes.get(new URL(request.url, "http://localhost").pathname);
  if (!route) return void response.writeHead(404).end();
  response.setHeader("Content-Type", route[0]);
  response.end(route[0] === "text/html" ? route[1] : await readFile(route[1]));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    url,
  ],
  { stdio: "ignore" },
);
let socket;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      port = Number(
        (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
          "\n",
        )[0],
      );
      break;
    } catch {
      if (browser.exitCode !== null)
        throw new Error(`Chrome exited with ${browser.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(port, "Chrome debugger did not start");
  const pages = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json();
  const page = pages.find(
    (entry) => entry.type === "page" && entry.url.startsWith(url),
  );
  assert.ok(page, "Calendar preview page missing");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) =>
    socket.addEventListener("open", resolve, { once: true }),
  );
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    message.error
      ? request.reject(message.error)
      : request.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails)
      throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const click = async (selector) => {
    const box = await evaluate(
      `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; })()`,
    );
    assert.ok(box, `${selector} missing`);
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: box.x,
      y: box.y,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
  };
  await send("Runtime.enable");
  await send("Page.enable");
  for (const width of [1408, 390]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await click('[data-focus="calendar-trigger"]');
    assert.equal(
      await evaluate('Boolean(document.querySelector(".calendar-popover"))'),
      true,
      `${width}px: calendar opens`,
    );
    const firstMonth = await evaluate(
      'document.querySelector("#calendar-month-title").textContent',
    );
    await click('[data-calendar-nav="-1"]');
    assert.equal(
      await evaluate('Boolean(document.querySelector(".calendar-popover"))'),
      true,
      `${width}px: month navigation keeps calendar open`,
    );
    assert.notEqual(
      await evaluate(
        'document.querySelector("#calendar-month-title").textContent',
      ),
      firstMonth,
      `${width}px: month changes`,
    );
    const firstRange = await evaluate(
      'document.querySelector(".calendar-bottom strong").textContent',
    );
    await click(".calendar-day:not(.other-month):not(:disabled)");
    assert.equal(
      await evaluate('Boolean(document.querySelector(".calendar-popover"))'),
      true,
      `${width}px: day selection keeps calendar open`,
    );
    assert.notEqual(
      await evaluate(
        'document.querySelector(".calendar-bottom strong").textContent',
      ),
      firstRange,
      `${width}px: draft range changes`,
    );
    await click('[data-calendar-action="apply"]');
    assert.equal(
      await evaluate('Boolean(document.querySelector(".calendar-popover"))'),
      false,
      `${width}px: Apply closes calendar`,
    );
    assert.equal(
      await evaluate(
        'document.querySelector(".date-trigger strong").textContent',
      ),
      await evaluate(
        'document.querySelector(".date-trigger").getAttribute("aria-label").replace("Choose date range, ", "")',
      ),
      `${width}px: applied range reaches toolbar`,
    );

    await click('[data-calendar-action="custom"]');
    assert.equal(
      await evaluate('Boolean(document.querySelector(".calendar-popover"))'),
      true,
      `${width}px: custom range opens`,
    );
    await click(".calendar-day:not(.other-month):not(:disabled)");
    assert.equal(
      await evaluate('Boolean(document.querySelector(".calendar-popover"))'),
      true,
      `${width}px: custom start keeps calendar open`,
    );
    const lastDay = await evaluate(
      '[...document.querySelectorAll(".calendar-day:not(.other-month):not(:disabled)")].at(-1).dataset.calendarDay',
    );
    await click(`[data-calendar-day="${lastDay}"]`);
    assert.equal(
      await evaluate('Boolean(document.querySelector(".calendar-popover"))'),
      true,
      `${width}px: custom end keeps calendar open`,
    );
    const customRange = await evaluate(
      'document.querySelector(".calendar-bottom strong").textContent',
    );
    await click('[data-calendar-action="apply"]');
    assert.equal(
      await evaluate(
        'document.querySelector("[data-calendar-action=custom]").getAttribute("aria-pressed")',
      ),
      "true",
      `${width}px: custom range applies`,
    );
    assert.equal(
      await evaluate(
        'document.querySelector(".date-trigger strong").textContent',
      ),
      customRange,
      `${width}px: custom dates reach toolbar`,
    );

    await click('[data-focus="calendar-trigger"]');
    await click('[data-calendar-action="today"]');
    assert.equal(
      await evaluate('Boolean(document.querySelector(".calendar-popover"))'),
      true,
      `${width}px: Today keeps calendar open`,
    );
    await click('[data-calendar-action="cancel"]');
    assert.equal(
      await evaluate(
        'document.querySelector(".date-trigger strong").textContent',
      ),
      customRange,
      `${width}px: Cancel preserves applied dates`,
    );
    await click('[data-focus="calendar-trigger"]');
    await click('[data-page="projects"]');
    assert.equal(
      await evaluate('Boolean(document.querySelector(".calendar-popover"))'),
      false,
      `${width}px: outside click closes calendar`,
    );
  }
  console.log(
    "Calendar month, day, Apply, and custom range passed at desktop and mobile widths.",
  );
} finally {
  socket?.close();
  if (browser.exitCode === null) {
    browser.kill();
    await new Promise((resolve) => browser.once("exit", resolve));
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
