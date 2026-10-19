import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
      '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'self\'; script-src \'nonce-hoosage-test\'; img-src \'self\' data:; font-src \'self\';"><link rel="stylesheet" href="/app.css"></head><body class="vscode-dark"><div id="app" aria-busy="true"><p class="loading">Loading usage…</p></div><script nonce="hoosage-test" src="/webview.js"></script></body></html>',
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
  const browserErrors = [];
  const policyViolations = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) {
      if (message.method === "Runtime.exceptionThrown")
        browserErrors.push(message.params.exceptionDetails);
      if (
        message.method === "Log.entryAdded" &&
        message.params.entry.source === "security"
      )
        policyViolations.push(message.params.entry.text);
      return;
    }
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
  const key = async (value, modifiers = 0) => {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: value,
      modifiers,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: value,
      modifiers,
    });
  };
  const screenshot = async (name) => {
    const directory = process.env.HOOSAGE_UI_SCREENSHOT_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    const result = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(
      join(directory, `${name}.png`),
      Buffer.from(result.data, "base64"),
    );
  };
  const click = async (selector) => {
    const box = await evaluate(
      `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; node.scrollIntoView({ block: "center", inline: "center" }); const r = node.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; })()`,
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
  await send("Log.enable");
  for (const width of [1408, 768, 390, 320]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url });
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const page of ["overview", "projects", "activity", "about"]) {
      await click(`[data-page="${page}"]`);
      assert.equal(
        await evaluate(
          "document.documentElement.scrollWidth <= window.innerWidth",
        ),
        true,
        `${width}px: ${page} has no horizontal page overflow`,
      );
      assert.equal(
        await evaluate(
          `document.querySelector('.nav-item[data-page="${page}"]').getAttribute("aria-label")`,
        ),
        {
          overview: "Overview",
          projects: "Projects",
          activity: "Activity",
          about: "Usage details",
        }[page],
        `${width}px: icon navigation has a clear name`,
      );
      await screenshot(`${width}-${page}`);
    }
    await click('[data-page="overview"]');
    await click('[data-focus="calendar-trigger"]');
    const focusedDay = await evaluate(
      "document.activeElement.dataset.calendarDay",
    );
    assert.ok(
      focusedDay,
      `${width}px: opening the calendar moves focus to a date`,
    );
    await key("ArrowLeft");
    assert.notEqual(
      await evaluate("document.activeElement.dataset.calendarDay"),
      focusedDay,
      `${width}px: arrow key moves date focus`,
    );
    const beforeMonth = await evaluate(
      "document.activeElement.dataset.calendarDay.slice(0, 7)",
    );
    await key("PageUp");
    assert.notEqual(
      await evaluate("document.activeElement.dataset.calendarDay.slice(0, 7)"),
      beforeMonth,
      `${width}px: Page Up moves to a previous month`,
    );
    await key("Home");
    assert.equal(
      await evaluate(
        'new Date(document.activeElement.dataset.calendarDay + "T12:00:00").getDay()',
      ),
      1,
      `${width}px: Home moves to Monday`,
    );
    await key("End");
    assert.equal(
      await evaluate(
        'new Date(document.activeElement.dataset.calendarDay + "T12:00:00").getDay()',
      ),
      0,
      `${width}px: End moves to Sunday`,
    );
    const weekEnd = await evaluate(
      "document.activeElement.dataset.calendarDay",
    );
    await key("ArrowUp");
    assert.notEqual(
      await evaluate("document.activeElement.dataset.calendarDay"),
      weekEnd,
      `${width}px: Arrow Up moves to the previous week`,
    );
    await key("ArrowDown");
    assert.equal(
      await evaluate("document.activeElement.dataset.calendarDay"),
      weekEnd,
      `${width}px: Arrow Down restores the same weekday`,
    );
    const beforeYear = await evaluate(
      "document.activeElement.dataset.calendarDay.slice(0, 4)",
    );
    await key("PageUp", 8);
    assert.equal(
      await evaluate(
        "Number(document.activeElement.dataset.calendarDay.slice(0, 4))",
      ),
      Number(beforeYear) - 1,
      `${width}px: Shift Page Up moves to the previous year`,
    );
    await key("PageDown", 8);
    assert.equal(
      await evaluate("document.activeElement.dataset.calendarDay.slice(0, 4)"),
      beforeYear,
      `${width}px: Shift Page Down restores the year`,
    );
    await key("Escape");
    assert.equal(
      await evaluate("document.activeElement.dataset.focus"),
      "calendar-trigger",
      `${width}px: Escape restores trigger focus`,
    );
    await click('[data-focus="calendar-trigger"]');
    await screenshot(`${width}-calendar`);
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
  // A browser preview has no VS Code host. Even a same-origin snapshot must
  // not become active after the user exits sample-data mode.
  await evaluate(`window.dispatchEvent(new MessageEvent("message", {
    origin: window.origin, source: window.parent,
    data: { type: "snapshot", snapshot: {
      projects: [], calls: [], status: "active", statusDetail: "Untrusted preview snapshot",
      updatedAt: Date.now(), skippedLines: 0, errors: []
    } }
  }))`);
  await click('[data-action="exitDemo"]');
  assert.equal(
    await evaluate('document.querySelector(".onboarding h2").textContent'),
    "Tracking is off",
    "browser preview rejects snapshots even after exiting sample data",
  );

  // Real-host fixture: snapshots and status updates must not steal keyboard focus.
  await send("Page.addScriptToEvaluateOnNewDocument", {
    // The actual VS Code API bootstrap hides the physical parent from content.
    source: `window.parent = window; window.top = window; window.frameElement = null; window.acquireVsCodeApi = () => ({ getState: () => window.fixtureState || {}, setState: state => { window.savedState = state; }, postMessage: message => { window.hostMessages = [...(window.hostMessages || []), message]; } });`,
  });
  await send("Page.navigate", { url });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    await evaluate('document.querySelector("#app").getAttribute("aria-busy")'),
    "true",
    "host-backed dashboard exposes a loading state before the first snapshot",
  );
  const now = Date.now();
  const fixture = {
    projects: [
      {
        id: "synthetic",
        name: "A very long synthetic project name <script>",
        kind: "folder",
        folderCount: 1,
        createdAt: now,
      },
    ],
    calls: [
      {
        id: "synthetic-call",
        projectId: "synthetic",
        timestamp: now,
        model: "Unknown synthetic model",
        failed: false,
      },
    ],
    status: "active",
    statusDetail: "Synthetic tracking fixture",
    updatedAt: now,
    skippedLines: 0,
    errors: [],
  };
  const snapshot = async (value, modelColors = {}) =>
    evaluate(
      `window.dispatchEvent(new MessageEvent("message", { origin: window.origin, source: window.parent, data: { type: "snapshot", snapshot: ${JSON.stringify(value)}, modelColors: ${JSON.stringify(modelColors)} } }))`,
    );
  const modelTestViewport = await evaluate(
    "({width: innerWidth, height: innerHeight})",
  );
  const manyModels = {
    ...fixture,
    calls: Array.from({ length: 16 }, (_, i) => ({
      ...fixture.calls[0],
      id: `color-${i}`,
      model: `Model ${String(i).padStart(2, "0")}`,
      input: (16 - i) * 100,
      output: 20,
    })),
  };
  const modelTones = () =>
    evaluate(
      `Object.fromEntries([...document.querySelectorAll("[data-model]")].map(node => [node.dataset.model, getComputedStyle(node.querySelector("progress")).accentColor]))`,
    );
  await snapshot(manyModels);
  const automaticTones = await modelTones();
  assert.equal(
    Object.keys(automaticTones).length,
    16,
    "all models are reachable beyond the former four-model limit",
  );
  assert.equal(
    new Set(Object.values(automaticTones)).size,
    16,
    "large inventories use distinct model colors",
  );
  for (const width of [1408, 768, 390, 320]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.equal(
      await evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
      true,
      `${width}px: many models fit the dashboard`,
    );
  }
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1408,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await screenshot("1408-model-colors-dark");
  await evaluate(
    'document.querySelector(".model-list").focus(); document.querySelector(".model-list").scrollTop = 150',
  );
  const modelScroll = await evaluate(
    'document.querySelector(".model-list").scrollTop',
  );
  assert.ok(modelScroll > 0, "the model list can be scrolled");
  await snapshot(manyModels);
  assert.equal(
    await evaluate("document.activeElement.dataset.focus"),
    "model-list",
    "refresh preserves keyboard focus in the model list",
  );
  assert.equal(
    await evaluate('document.querySelector(".model-list").scrollTop'),
    modelScroll,
    "refresh preserves the model list scroll position",
  );
  await snapshot({
    ...manyModels,
    calls: manyModels.calls.map((call, i) => ({ ...call, input: i * 100 })),
  });
  assert.deepEqual(
    await modelTones(),
    automaticTones,
    "token ranking changes do not recolor models",
  );
  await snapshot({ ...manyModels, calls: [manyModels.calls[7]] });
  assert.equal(
    (await modelTones())[manyModels.calls[7].model],
    automaticTones[manyModels.calls[7].model],
    "filtering to one model retains its color",
  );
  await snapshot(manyModels, {
    "Model 00": "#123456",
    "Model 01": "red; background: url(/missing)",
  });
  assert.equal(
    (await modelTones())["Model 00"],
    "rgb(18, 52, 86)",
    "custom colors apply immediately",
  );
  assert.equal(
    (await modelTones())["Model 01"],
    automaticTones["Model 01"],
    "invalid CSS falls back to the automatic color",
  );
  await evaluate('document.body.className = "vscode-light"');
  assert.equal(
    (await modelTones())["Model 00"],
    "rgb(18, 52, 86)",
    "custom colors apply to the light theme",
  );
  await snapshot(manyModels);
  const lightTones = await modelTones();
  assert.equal(
    new Set(Object.values(lightTones)).size,
    16,
    "light theme keeps models distinct",
  );
  assert.notEqual(
    lightTones["Model 00"],
    automaticTones["Model 00"],
    "automatic colors adapt to the theme",
  );
  await screenshot("1408-model-colors-light");
  await click('[data-action="modelColors"]');
  assert.equal(
    await evaluate("window.hostMessages.at(-1).type"),
    "modelColors",
    "Colors opens the model color settings through the host",
  );
  await evaluate('document.body.className = "vscode-dark"');
  await send("Emulation.setDeviceMetricsOverride", {
    ...modelTestViewport,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await snapshot(fixture);
  const initialHostMarkup = await evaluate(
    'document.querySelector("#app").innerHTML',
  );
  for (const boundary of [
    'origin: "https://attacker.invalid", source: window.parent',
    'origin: "null", source: window.parent',
  ]) {
    await evaluate(`window.dispatchEvent(new MessageEvent("message", {
      ${boundary}, data: { type: "snapshot", snapshot: ${JSON.stringify({ ...fixture, statusDetail: "Untrusted host snapshot" })} }
    }))`);
    assert.equal(
      await evaluate('document.querySelector("#app").innerHTML'),
      initialHostMarkup,
      `untrusted message boundary leaves the current snapshot unchanged: ${boundary}`,
    );
  }
  for (const malformed of [
    {
      ...fixture,
      calls: [
        {
          ...fixture.calls[0],
          input:
            '\"><img id="snapshot-injected" src="/missing" onerror="window.snapshotInjected=true"><progress value="',
        },
      ],
    },
    { ...fixture, updatedAt: "2026-10-13" },
    { ...fixture, projects: [{ ...fixture.projects[0], folderCount: "1" }] },
  ]) {
    await snapshot(malformed);
    assert.equal(
      await evaluate('document.querySelector("#app").innerHTML'),
      initialHostMarkup,
      "malformed trusted-origin snapshots leave the current snapshot unchanged",
    );
  }
  assert.equal(
    await evaluate(
      'Boolean(document.querySelector("#snapshot-injected")) || window.snapshotInjected === true',
    ),
    false,
    "malformed counter payloads cannot inject HTML or execute code",
  );
  for (const field of ["projects", "calls", "errors"]) {
    // Construct holes in the browser: JSON.stringify would turn them into
    // null and would miss the Array.every sparse-array validation regression.
    await evaluate(`window.dispatchEvent(new MessageEvent("message", {
      origin: window.origin, source: window.parent,
      data: { type: "snapshot", snapshot: { ...${JSON.stringify(fixture)}, ${field}: Array(1) } }
    }))`);
    assert.equal(
      await evaluate('document.querySelector("#app").innerHTML'),
      initialHostMarkup,
      `sparse ${field} cannot replace the current snapshot`,
    );
  }
  await snapshot({
    ...fixture,
    projects: [
      {
        ...fixture.projects[0],
        name: "Fractional timestamp accepted",
        createdAt: 0.5,
      },
    ],
    calls: [{ ...fixture.calls[0], timestamp: now - 0.5, durationMs: 0.5 }],
    updatedAt: now + 0.5,
  });
  assert.equal(
    await evaluate(
      'document.querySelector("#project option:last-child").textContent',
    ),
    "Fractional timestamp accepted",
    "finite fractional timestamps and durations remain valid",
  );
  await snapshot(fixture);
  assert.equal(
    await evaluate('document.querySelectorAll(".stat-number")[1].textContent'),
    "—",
    "unknown usage remains unknown",
  );
  const accessibility = await send("Accessibility.getFullAXTree");
  assert.ok(
    accessibility.nodes.some(
      (node) =>
        !node.ignored && node.name?.value?.includes("incomplete token data"),
    ),
    "incomplete chart buckets reach the accessibility tree",
  );
  await snapshot({
    ...fixture,
    calls: [0, 1].map((i) => ({
      ...fixture.calls[0],
      id: `synthetic-unknown-${i}`,
      source: "chat-history",
    })),
  });
  assert.deepEqual(
    await evaluate(
      '[...document.querySelectorAll(".stat-number")].slice(1).map(node => node.textContent)',
    ),
    ["—", "—", "—", "—"],
    "unknown imported token and request totals remain unknown in every summary",
  );
  assert.equal(
    await evaluate('document.querySelectorAll(".stat-number")[2].title'),
    "2 entries with unknown call count",
    "unknown aggregate count has a clear plural label",
  );
  await screenshot("320-unknown");
  await snapshot({
    ...fixture,
    projects: [
      ...fixture.projects,
      {
        ...fixture.projects[0],
        id: "synthetic-other",
        name: "Other synthetic project",
      },
    ],
    calls: [
      ...fixture.calls,
      {
        ...fixture.calls[0],
        id: "synthetic-other-call",
        projectId: "synthetic-other",
        input: 1,
        output: 2,
      },
    ],
  });
  await evaluate(
    'document.querySelector("#project").value = "synthetic"; document.querySelector("#project").dispatchEvent(new Event("change", { bubbles: true }))',
  );
  assert.equal(
    await evaluate('document.querySelectorAll(".stat-number")[2].textContent'),
    "1",
    "project filter isolates its own calls",
  );
  assert.equal(
    await evaluate("window.savedState.projectId"),
    "synthetic",
    "project filter is retained in host state",
  );
  await click('[data-page="projects"]');
  assert.equal(
    await evaluate('document.querySelectorAll(".project-card").length'),
    2,
    "Projects always displays the complete index",
  );
  await click('[data-action="export"]');
  assert.equal(
    await evaluate(
      'window.hostMessages.findLast(message => message.type === "export").projectId',
    ),
    "all",
    "Projects exports the same all-project scope it displays",
  );
  await click('[data-page="activity"]');
  assert.equal(
    await evaluate('document.querySelectorAll(".session").length'),
    1,
    "activity restores the selected project filter",
  );
  await snapshot(fixture);
  await click('[data-page="about"]');
  await evaluate('document.querySelector("[data-action=settings]").focus()');
  const settingsFocus = await evaluate("document.activeElement.dataset.focus");
  await snapshot(fixture);
  assert.equal(
    await evaluate("document.activeElement.dataset.focus"),
    settingsFocus,
    "incoming snapshot preserves settings focus",
  );
  await click('[data-page="projects"]');
  assert.equal(
    await evaluate('Boolean(document.querySelector(".projects-card script"))'),
    false,
    "project labels are escaped",
  );
  await click(".project-cards [data-project]");
  assert.equal(
    await evaluate("document.activeElement.dataset.focus"),
    "page-heading",
    "project drill-down moves focus to its destination",
  );
  await click('[data-action="refresh"]');
  assert.equal(
    await evaluate('document.querySelector(".toast").textContent'),
    "Refreshing…",
    "refresh announces pending state",
  );
  await evaluate(
    'window.originalToast = document.querySelector(".toast"); document.querySelector("[data-focus=days-7]").focus()',
  );
  await snapshot(fixture);
  assert.equal(
    await evaluate('document.querySelector(".toast") === window.originalToast'),
    true,
    "live status region remains stable across snapshot renders",
  );
  assert.equal(
    await evaluate('document.querySelector(".toast").textContent'),
    "Usage refreshed.",
    "refresh announces successful response",
  );
  assert.equal(
    await evaluate("document.activeElement.dataset.focus"),
    "days-7",
    "refresh response preserves focus",
  );
  await snapshot({
    ...fixture,
    calls: [],
    indexing: true,
    errors: ["Synthetic local file error"],
  });
  assert.equal(
    await evaluate(
      'Boolean(document.querySelector(".onboarding[aria-busy=true]"))',
    ),
    true,
    "indexing state is explicit",
  );
  assert.equal(
    await evaluate('document.querySelector(".notice").textContent'),
    "Synthetic local file error",
    "error state is visible",
  );
  assert.equal(
    await evaluate('document.querySelector("[data-action=export]").disabled'),
    true,
    "export is disabled while usage totals are still indexing",
  );
  const indexingAccessibility = await send("Accessibility.getFullAXTree");
  assert.ok(
    indexingAccessibility.nodes.some(
      (node) =>
        !node.ignored &&
        node.name?.value === "Export" &&
        node.description?.value ===
          "Export is unavailable while saved usage is being indexed.",
    ),
    "disabled export has an accessible explanation",
  );
  const messagesBeforeIndexingExport = await evaluate(
    "window.hostMessages.length",
  );
  await evaluate('document.querySelector("[data-action=export]").click()');
  assert.equal(
    await evaluate("window.hostMessages.length"),
    messagesBeforeIndexingExport,
    "indexing does not emit an export request",
  );
  await screenshot("320-indexing");
  await snapshot({
    ...fixture,
    errors: ["Synthetic local file error"],
    indexing: false,
  });
  assert.equal(
    await evaluate('document.querySelector("[data-action=export]").disabled'),
    true,
    "export is disabled when source errors leave coverage incomplete",
  );
  const errorAccessibility = await send("Accessibility.getFullAXTree");
  assert.ok(
    errorAccessibility.nodes.some(
      (node) =>
        !node.ignored &&
        node.name?.value === "Export" &&
        node.description?.value ===
          "Some usage could not be read. Resolve the storage errors and refresh before exporting.",
    ),
    "error-blocked export has an accessible explanation",
  );
  const messagesBeforeErrorExport = await evaluate(
    "window.hostMessages.length",
  );
  await evaluate('document.querySelector("[data-action=export]").click()');
  assert.equal(
    await evaluate("window.hostMessages.length"),
    messagesBeforeErrorExport,
    "source errors do not emit an export request",
  );
  await screenshot("320-error");
  await snapshot({ ...fixture, calls: [], status: "blocked", indexing: false });
  assert.equal(
    await evaluate('document.querySelector(".onboarding h2").textContent'),
    "Tracking unavailable",
    "blocked empty state is explicit",
  );
  await screenshot("320-blocked");
  await snapshot({
    ...fixture,
    calls: [],
    status: "active",
    statusDetail: "Tracking is active; no completed calls yet.",
  });
  assert.equal(
    await evaluate('document.querySelector(".onboarding h2").textContent'),
    "No usage yet",
    "active tracking with no completed calls does not claim tracking is off",
  );
  assert.equal(
    await evaluate(
      'document.querySelector(".onboarding [data-action=disable]") !== null',
    ),
    true,
    "active empty state offers Stop tracking",
  );

  const manySessions = {
    ...fixture,
    calls: Array.from({ length: 205 }, (_, i) => ({
      id: `synthetic-pagination-${i}`,
      sessionId: `synthetic-session-${i}`,
      projectId: "synthetic",
      timestamp: now - i * 1000,
      model:
        '<img src="remote.invalid/model" onerror="window.modelInjected=true">',
      input: 1,
      output: 2,
      failed: false,
    })),
  };
  await snapshot(manySessions);
  await click('[data-page="activity"]');
  assert.equal(
    await evaluate('document.querySelectorAll(".session").length'),
    100,
  );
  await click('[data-action="moreSessions"]');
  assert.equal(
    await evaluate('document.querySelectorAll(".session").length'),
    200,
  );
  assert.equal(
    await evaluate(
      'document.activeElement === document.querySelectorAll(".session-toggle")[100]',
    ),
    true,
    "pagination moves keyboard focus to the first newly revealed session",
  );
  await click('[data-action="moreSessions"]');
  assert.equal(
    await evaluate('document.querySelectorAll(".session").length'),
    205,
  );
  assert.equal(
    await evaluate(
      'document.activeElement === document.querySelectorAll(".session-toggle")[200]',
    ),
    true,
    "final pagination preserves meaningful keyboard focus when the control disappears",
  );
  assert.equal(
    await evaluate('document.querySelector(".toast").textContent'),
    "205 of 205 sessions shown.",
    "pagination announces its result",
  );
  await click(".session-toggle");
  assert.equal(
    await evaluate('document.querySelectorAll(".session-detail img").length'),
    0,
  );
  assert.equal(
    await evaluate("window.modelInjected === true"),
    false,
    "model names stay escaped",
  );
  await snapshot({ ...fixture, updatedAt: now - 1000 });
  assert.equal(
    await evaluate('document.querySelectorAll(".session").length'),
    0,
    "a snapshot after a local clock rollback is still rendered",
  );
  const includedCall = {
    id: "synthetic-included-call",
    projectId: "synthetic",
    sessionId: "synthetic-included-session",
    timestamp: now - 1000,
    model: "gpt-5.4",
    source: "cli",
    requests: 2,
    input: 1000,
    output: 100,
    costIncludedInSessionTotal: true,
    failed: false,
  };
  await snapshot({ ...fixture, calls: [includedCall] });
  await click('[data-page="overview"]');
  assert.equal(
    await evaluate(
      'document.querySelector(".cost-stat .stat-number").textContent',
    ),
    "Included",
    "covered CLI increments have an explicit cost label",
  );
  assert.equal(
    await evaluate(
      'document.querySelector(".cost-stat .stat-foot").textContent',
    ),
    "Included in session total",
    "covered increments are not called unknown or unpriced",
  );
  await click('[data-page="activity"]');
  assert.equal(
    await evaluate(
      'document.querySelector(".session-figures > strong").textContent',
    ),
    "Included",
    "included session cost is explicit in activity",
  );
  await click(".session-toggle");
  assert.equal(
    await evaluate(
      'document.querySelector(".session-model > strong").textContent',
    ),
    "Included",
    "included model cost is explicit in expanded details",
  );
  await snapshot({
    ...fixture,
    calls: [
      includedCall,
      {
        ...includedCall,
        id: "synthetic-reported-total",
        timestamp: now,
        input: 0,
        output: 0,
        requests: 0,
        nanoAiu: 10_000_000_000,
        costIncludedInSessionTotal: undefined,
      },
    ],
  });
  assert.equal(
    await evaluate(
      'document.querySelector(".session-figures > strong").textContent',
    ),
    "$0.10",
    "reported session total is counted once without a second estimate or unpriced suffix",
  );
  await screenshot("320-included-session");

  // Exercise local calendar filtering across both spring and autumn DST boundaries.
  for (const scenario of [
    {
      timezone: "America/Los_Angeles",
      start: "2026-03-07",
      end: "2026-03-10",
      days: 4,
    },
    {
      timezone: "Europe/Berlin",
      start: "2026-03-27",
      end: "2026-03-31",
      days: 5,
    },
    {
      timezone: "America/Los_Angeles",
      start: "2025-10-31",
      end: "2025-11-03",
      days: 4,
    },
    {
      timezone: "Europe/Berlin",
      start: "2025-10-24",
      end: "2025-10-28",
      days: 5,
    },
  ]) {
    await send("Emulation.setTimezoneOverride", {
      timezoneId: scenario.timezone,
    });
    const stateScript = await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.fixtureState = ${JSON.stringify({ page: "overview", days: 14, rangeMode: "custom", customStartDate: scenario.start, customEndDate: scenario.end })};`,
    });
    await send("Page.navigate", { url });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const timestamps = await evaluate(`(() => {
      const local = key => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); };
      const start = local(${JSON.stringify(scenario.start)}).getTime();
      const afterEnd = local(${JSON.stringify(scenario.end)}); afterEnd.setDate(afterEnd.getDate() + 1);
      return [start - 1, start, afterEnd.getTime() - 1, afterEnd.getTime()];
    })()`);
    await snapshot({
      ...fixture,
      calls: timestamps.map((timestamp, i) => ({
        id: `dst-${i}`,
        projectId: "synthetic",
        timestamp,
        model: "Synthetic DST model",
        input: 1,
        output: 2,
        failed: false,
      })),
    });
    assert.equal(
      await evaluate('document.querySelector(".chart-interval").textContent'),
      `Daily intervals · ${scenario.days} days selected`,
      `${scenario.timezone}: inclusive day count survives DST`,
    );
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".stat-number")[2].textContent',
      ),
      "2",
      `${scenario.timezone}: exact local boundary calls included and adjacent calls excluded`,
    );
    await click('[data-action="export"]');
    const exported = await evaluate(
      'window.hostMessages.findLast(message => message.type === "export")',
    );
    assert.equal(
      exported.startDate,
      scenario.start,
      "custom export preserves the displayed start date",
    );
    assert.equal(
      exported.endDate,
      scenario.end,
      "custom export preserves the displayed end date",
    );
    await click('[data-shift="previous"]');
    await click('[data-shift="next"]');
    const shiftedState = await evaluate("window.savedState");
    assert.equal(
      shiftedState.customStartDate,
      scenario.start,
      "range paging round-trips across DST",
    );
    assert.equal(
      shiftedState.customEndDate,
      scenario.end,
      "range paging preserves inclusive end across DST",
    );
    await send("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: stateScript.identifier,
    });
  }
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1408,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await snapshot({
    ...fixture,
    calls: [
      {
        ...fixture.calls[0],
        input: 100,
        output: 20,
        cacheRead: 0,
        nanoAiu: 100_000_000,
      },
    ],
  });
  await evaluate('document.body.className = "vscode-light"');
  assert.equal(
    await evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
    true,
    "light theme has no page overflow",
  );
  await screenshot("1408-light");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(`document.body.className = "vscode-high-contrast";
    for (const [name, value] of Object.entries({ "editor-background": "#000000", "editor-foreground": "#ffffff", "contrastBorder": "#ffffff", "focusBorder": "#ffff00" })) document.documentElement.style.setProperty("--vscode-" + name, value);`);
  await click('[data-focus="calendar-trigger"]');
  assert.equal(
    await evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
    true,
    "high contrast calendar has no page overflow",
  );
  assert.equal(
    await evaluate(
      'getComputedStyle(document.querySelector(".calendar-day.range-edge")).outlineStyle',
    ),
    "solid",
    "selected calendar dates remain visible in high contrast",
  );
  await screenshot("390-high-contrast-calendar");
  assert.deepEqual(
    browserErrors,
    [],
    "dashboard smoke produces no uncaught browser errors",
  );
  assert.deepEqual(
    policyViolations,
    [],
    "dashboard runs under its strict local-asset CSP",
  );
  console.log(
    "Dashboard navigation, responsive layouts, calendar keyboard/mouse and DST behavior, pagination, unknown usage, strict CSP and escaping, live announcements, focus preservation, and loading/empty/error states passed.",
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
