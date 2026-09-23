import {
  byModel,
  daily,
  filterCalls,
  groupSessions,
  localDateKey,
  periodEnd,
  shiftLocalDate,
  totals,
} from "../core/analytics";
import {
  costs,
  costLabel,
  costDescription,
  PRICING_DATE,
  PRICING_SOURCE,
} from "../core/pricing";
import type { Snapshot, Totals, UsageCall } from "../core/types";
import { demoSnapshot } from "./demo";

declare const acquireVsCodeApi:
  | undefined
  | (() => {
      postMessage(message: unknown): void;
      getState(): unknown;
      setState(state: unknown): void;
    });
const api =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
const root = document.getElementById("app")!;
const saved = (api?.getState() ?? {}) as Record<string, unknown>;
let page = ["overview", "projects", "activity", "about"].includes(
  String(saved.page),
)
  ? String(saved.page)
  : "overview";
let days = [7, 14, 30].includes(Number(saved.days)) ? Number(saved.days) : 14;
let endDate =
  typeof saved.endDate === "string" &&
  periodEnd(Date.now(), saved.endDate) !== undefined
    ? saved.endDate
    : undefined;
let projectId = typeof saved.projectId === "string" ? saved.projectId : "all";
let demo = false;
let real: Snapshot | undefined;
let data: Snapshot | undefined;
let expandedSession: string | undefined;
let visibleSessions = 100;
let toast = "";
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const number = (n: number) =>
  new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(n);
const count = (n: number, label: string) =>
  `${number(n)} ${label}${n === 1 ? "" : "s"}`;
const measuredCalls = (t: Totals) =>
  t.missingRequests ? (t.calls ? `${number(t.calls)}+` : "—") : number(t.calls);
const callCount = (t: Totals) =>
  t.missingRequests
    ? `${t.calls ? `${count(t.calls, "call")} + ` : ""}${count(t.missingRequests, "entry")} with unknown call count`
    : count(t.calls, "call");
const compact = (n: number) =>
  new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
const knownTokenLabel = (
  calls: UsageCall[],
  value: number,
  part: "input" | "output" | "cacheRead" | "total",
) =>
  calls.length &&
  calls.every((call) =>
    part === "total"
      ? call.input === undefined && call.output === undefined
      : call[part] === undefined,
  )
    ? "—"
    : compact(value);
const h = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const paths: Record<string, string> = {
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  projects:
    "M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  about: "M12 16v-4 M12 8h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  download: "M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5",
  refresh:
    "M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-2l2 2 M4 17l2 2a7 7 0 0 0 12-2",
  bolt: "M13 2 4 14h7l-1 8 10-13h-7l1-7Z",
  chevron: "m9 5 7 7-7 7",
  calendar: "M8 2v4 M16 2v4 M3 9h18 M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
  expand: "M15 3h6v6 M21 3l-7 7 M9 21H3v-6 M3 21l7-7",
};
const icon = (name: string) =>
  `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name] ?? paths.overview}"/></svg>`;
const mark = `<svg class="owl" aria-hidden="true" viewBox="0 0 40 40" fill="none"><path d="M7 9 14 13a14 14 0 0 1 12 0l7-4v14a13 13 0 0 1-26 0Z" stroke="currentColor" stroke-width="2.3" stroke-linejoin="round"/><circle cx="14" cy="22" r="4" stroke="currentColor" stroke-width="2"/><circle cx="26" cy="22" r="4" stroke="currentColor" stroke-width="2"/><path d="m17 29 3 3 3-3" stroke="currentColor" stroke-width="2"/></svg>`;

function save() {
  api?.setState({ page, days, endDate, projectId });
}
function send(type: string, extra: Record<string, unknown> = {}) {
  api?.postMessage({ type, ...extra });
}
function announce(message: string) {
  toast = message;
  render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast = "";
    render();
  }, 3500);
}
function selectedCalls() {
  return data
    ? filterCalls(
        data.calls,
        page === "projects" ? "all" : projectId,
        days,
        periodEnd(data.updatedAt, endDate) ?? data.updatedAt,
      )
    : [];
}
function action(label: string, command: string, primary = false) {
  return `<button class="${primary ? "primary" : "button"}" data-action="${command}">${label}${icon("arrow")}</button>`;
}

function render() {
  if (!data) return;
  if (endDate && periodEnd(data.updatedAt, endDate) === undefined)
    endDate = undefined;
  const today = localDateKey(data.updatedAt);
  const selectedDate = endDate ?? today;
  const focus = document.activeElement as HTMLElement | null;
  const focusKey = focus?.dataset.focus;
  const scroll = window.scrollY;
  if (projectId !== "all" && !data.projects.some((p) => p.id === projectId))
    projectId = "all";
  const calls = selectedCalls();
  const nameCounts = new Map<string, number>();
  for (const project of data.projects) {
    if (project.kind === "cli" || project.kind === "jetbrains" || project.kind === "chat") continue;
    const name = project.name.toLocaleLowerCase();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const duplicateNames = [...nameCounts.values()].some((count) => count > 1);
  root.removeAttribute("aria-busy");
  root.innerHTML = `
    <aside class="rail"><a class="brand" href="#overview" data-page="overview" aria-label="hoosage overview">${mark}<span>hoosage<span class="brand-dot">.</span></span></a>
    <nav aria-label="Main navigation">${[
      ["overview", "Overview"],
      ["projects", "Projects"],
      ["activity", "Activity"],
    ]
      .map(
        ([key, label]) =>
          `<button data-focus="nav-${key}" data-page="${key}" class="nav-item ${page === key ? "selected" : ""}" ${page === key ? 'aria-current="page"' : ""}>${icon(key!)}${label}${key === "projects" ? `<span class="nav-count">${data!.projects.length}</span>` : ""}</button>`,
      )
      .join("")}</nav>
    </aside>
    <div class="workspace">
    <main>${demo ? `<div class="demo-banner"><span><strong>Preview</strong> · Sample data</span><button data-action="exitDemo">Exit preview ${icon("arrow")}</button></div>` : ""}
    <div class="page-heading"><div><h1>${{ overview: "Copilot usage", projects: "Projects", activity: "Activity", about: "Usage details" }[page]}</h1></div><div class="heading-actions"><button class="icon-button expand-button" data-action="open" title="Open full dashboard" aria-label="Open full dashboard">${icon("expand")}</button><button class="icon-button" data-action="refresh" data-focus="refresh" title="Refresh usage" aria-label="Refresh usage">${icon("refresh")}</button></div></div>
    ${page !== "about" ? `<div class="toolbar">${page === "projects" ? '<span class="toolbar-title">All projects</span>' : `<label class="project-picker">${icon("projects")}<span class="sr-only">Project</span><select id="project" data-focus="project" aria-label="Project"><option value="all">All projects</option>${data.projects.map((p) => `<option value="${h(p.id)}" ${projectId === p.id ? "selected" : ""}>${h(p.name)}</option>`).join("")}</select></label>`}<div class="toolbar-right"><div class="range" role="group" aria-label="Period length">${[7, 14, 30].map((d) => `<button data-focus="days-${d}" data-days="${d}" aria-pressed="${days === d}">${d} days</button>`).join("")}</div><div class="date-nav" role="group" aria-label="Browse calendar history"><button class="date-step" data-shift="previous" data-focus="previous" aria-label="Previous ${days} days" title="Previous ${days} days">‹</button><label class="date-end">${icon("calendar")}<span>Ending</span><input type="date" id="end-date" data-focus="end-date" aria-label="Period end date" value="${h(selectedDate)}" max="${h(today)}"></label><button class="date-step" data-shift="next" data-focus="next" aria-label="Next ${days} days" title="Next ${days} days" ${selectedDate >= today ? "disabled" : ""}>›</button></div><button class="button export" data-action="export" data-focus="export">${icon("download")}Export</button></div></div>` : ""}
    ${data.errors.map((error) => `<div class="notice" role="status">${icon("about")}${h(error)}</div>`).join("")}
    ${!demo && duplicateNames && page !== "about" ? `<div class="notice" role="status">${icon("about")}Projects with the same name may be separate Windows, WSL, container, clone or worktree locations. Their usage stays separate by workspace identity; Hoosage never merges them by name.</div>` : ""}
    ${!demo && data.indexing && page !== "about" ? `<section class="onboarding" aria-busy="true">${icon("activity")}<h2>Indexing saved usage…</h2><p>Reading hoosage's saved project records and local sessions. Totals will appear when the scan is complete.</p></section>` : page === "about" ? about() : page === "projects" ? projects(calls) : page === "activity" ? activity(calls) : overview(calls)}

    </main></div><div class="toast" role="status" aria-live="polite">${h(toast)}</div>`;
  if (focusKey)
    root
      .querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusKey)}"]`)
      ?.focus({ preventScroll: true });
  window.scrollTo({ top: scroll });
}

function overview(calls: UsageCall[]) {
  if (!data) return "";
  const t = totals(calls);
  const price = costs(calls);
  const allEmpty = data.calls.length === 0;
  const setupAction =
    data.status === "reload"
      ? action("Reload window", "reload", true)
      : data.canStopTracking
        ? action("Stop tracking", "disable", true)
        : data.status === "waiting"
          ? action("Refresh usage", "refresh", true)
          : action("Enable Chat tracking once", "enable", true);
  if (allEmpty)
    return `<section class="onboarding">${icon("activity")}<h2>${data.status === "waiting" ? "No usage yet" : data.status === "reload" ? "Reload required" : data.status === "blocked" ? "Tracking unavailable" : "Tracking is off"}</h2><p>${h(data.statusDetail)}</p><div class="onboarding-actions">${setupAction}<button class="button" data-action="diagnose">Diagnose tracking</button><button class="button" data-action="demo">Preview ${icon("arrow")}</button></div></section><div class="coverage-note"><span>Tracking starts after setup and reload. <button class="text-button" data-page="about">Usage details ${icon("arrow")}</button></span></div>`;
  return `<section class="stats" aria-label="Usage summary">
    <article class="stat featured cost-stat"><div class="stat-label">Usage cost <span class="currency-tag">USD</span></div><div class="stat-number" title="${h(costDescription(price))}">${h(costLabel(price))}</div><div class="stat-foot">${price.unpricedCalls ? count(price.unpricedCalls, "unpriced entry") : price.estimatedCalls ? "Includes estimates" : price.reportedCalls ? "Reported by Copilot" : "No cost data"}</div></article>
    <article class="stat"><div class="stat-label">Tokens ${icon("bolt")}</div><div class="stat-number">${knownTokenLabel(calls, t.tokens, "total")}</div><div class="stat-foot">${t.missingUsage ? `${count(t.missingUsage, "entry")} missing token data` : "Input + output"}</div></article>
    <article class="stat"><div class="stat-label">Model calls ${icon("activity")}</div><div class="stat-number" title="${h(callCount(t))}">${measuredCalls(t)}</div><div class="stat-foot">${count(t.sessions, "session")}${t.missingRequests ? " · Partial count" : ""}</div></article>
    <article class="stat"><div class="stat-label">Input tokens ${icon("download")}</div><div class="stat-number">${knownTokenLabel(calls, t.input, "input")}</div><div class="stat-foot">${knownTokenLabel(calls, t.cacheRead, "cacheRead")} cached${calls.some((c) => c.cacheRead === undefined) ? " · partial" : ""}</div></article>
    <article class="stat"><div class="stat-label">Output tokens ${icon("arrow")}</div><div class="stat-number">${knownTokenLabel(calls, t.output, "output")}</div><div class="stat-foot">${calls.some((c) => c.durationMs !== undefined) ? `${(t.avgDurationMs / 1000).toFixed(1)}s avg. timed call` : "No timing data"}</div></article>
  </section>
  <div class="charts"><section class="card chart-card"><div class="card-heading"><h2>Tokens by day</h2><div class="legend"><span><i class="input-color"></i>Input</span><span><i class="output-color"></i>Output</span></div></div>${chart(calls)}</section><section class="card models-card"><div class="card-heading"><h2>Models</h2><span class="small-tag">Observed share</span></div>${modelMix(calls)}</section></div>
  ${projects(calls, true)}
  <div class="coverage-note"><span>${price.estimatedCalls ? "≈ Estimated cost · " : ""}${price.unpricedCalls ? "+ Excludes unpriced usage · " : ""}<button class="text-button" data-page="about">Usage details ${icon("arrow")}</button></span></div>`;
}

function chart(calls: UsageCall[]) {
  const end = periodEnd(data!.updatedAt, endDate) ?? data!.updatedAt;
  const points = daily(calls, days, end);
  const maximum = Math.max(...points.map((p) => p.tokens), 1);
  const maxLabel = compact(maximum);
  const bars = points
    .map((p, i) => {
      const x = 52 + i * (650 / days);
      const width = Math.max(3, 650 / days - 9);
      const input = (p.input / maximum) * 154;
      const output = (p.output / maximum) * 154;
      return `<g class="chart-bar" tabindex="0" role="img" aria-label="${new Date(p.date).toLocaleDateString("en", { month: "short", day: "numeric" })}: ${number(p.input)} input, ${number(p.output)} output tokens${p.missingUsage ? "; incomplete token data" : ""}"><title>${new Date(p.date).toLocaleDateString("en")} · ${number(p.tokens)} observed tokens · ${callCount(p)}</title><rect x="${x}" y="${182 - input}" width="${width}" height="${input}" rx="2" class="bar-input"/><rect x="${x}" y="${182 - input - output}" width="${width}" height="${output}" rx="2" class="bar-output"/>${i === 0 || i === days - 1 || i % Math.ceil(days / 5) === 0 ? `<text x="${x + width / 2}" y="209" text-anchor="middle">${new Date(p.date).toLocaleDateString("en", { month: "short", day: "numeric" })}</text>` : ""}</g>`;
    })
    .join("");
  return `<div class="chart-wrap"><svg class="chart" viewBox="0 0 720 220" role="img" aria-label="Daily input and output token usage for ${days} days ending ${h(localDateKey(end))}"><text x="0" y="31">${maxLabel}</text><text x="0" y="108">${compact(maximum / 2)}</text><text x="20" y="186">0</text><path d="M48 28H710 M48 105H710 M48 182H710" class="gridline"/>${bars}</svg></div>${!calls.length ? '<p class="chart-empty">No calls in this period.</p>' : ""}`;
}

function modelMix(calls: UsageCall[]) {
  const models = byModel(calls);
  const total = totals(calls).tokens;
  if (!models.length)
    return `<div class="mini-empty">${icon("bolt")}No model usage in this period.</div>`;
  return `<div class="model-list">${models
    .slice(0, 4)
    .map((m, i) => {
      const modelCalls = calls.filter((c) => c.model === m.model);
      const price = costs(modelCalls);
      return `<div class="model"><div class="model-top"><span class="model-avatar tone-${i}">${h(m.model.slice(0, 1).toUpperCase())}</span><strong title="${h(m.model)}">${h(m.model)}</strong><span>${total ? `${Math.round((m.tokens / total) * 100)}%` : "—"}</span></div><progress class="model-progress tone-${i}" max="${total || 1}" value="${m.tokens}" aria-label="${h(m.model)} share of observed tokens"></progress><div class="model-meta"><span>${callCount(m)} · ${knownTokenLabel(modelCalls, m.tokens, "total")} observed tokens</span><strong class="model-cost" title="${h(costDescription(price))}">${h(costLabel(price))}</strong></div></div>`;
    })
    .join(
      "",
    )}</div>${models.length > 4 ? `<p class="muted">+ ${models.length - 4} more models · see Activity</p>` : ""}`;
}

function projects(calls: UsageCall[], embedded = false) {
  const rows = data!.projects
    .filter((p) => !embedded || projectId === "all" || p.id === projectId)
    .map((p) => {
      const usage = calls.filter((c) => c.projectId === p.id);
      return { project: p, usage, cost: costs(usage), ...totals(usage) };
    })
    .sort((a, b) => b.tokens - a.tokens);
  const all = totals(calls).tokens;
  return `<section class="card projects-card" aria-label="Project usage">${embedded ? `<div class="card-heading"><h2>Projects</h2><button class="text-button" data-page="projects">All projects ${icon("arrow")}</button></div>` : ""}<div class="table-scroll"><table><thead><tr><th scope="col">Project</th><th scope="col">Model calls</th><th scope="col">Observed tokens</th><th scope="col">Cost (USD)</th><th scope="col" class="share-column">Token share</th><th scope="col"><span class="sr-only">View project</span></th></tr></thead><tbody>${rows.map((row, i) => `<tr><td><button class="project-link" data-project="${h(row.project.id)}"><span class="folder-icon tone-${i % 4}">${icon("projects")}</span><span><strong>${h(row.project.name)}</strong>${row.project.kind === "cli" ? "<small>Unmatched CLI sessions</small>" : row.project.kind === "jetbrains" ? "<small>Unmatched JetBrains sessions</small>" : row.project.kind === "chat" ? "<small>Chats opened without a folder</small>" : row.project.kind === "workspace" ? `<small>Workspace group · ${count(row.project.folderCount, "folder")}</small>` : row.project.id === data!.currentProjectId ? "<small>Current workspace</small>" : !row.usage.length ? "<small>No usage in selected period</small>" : ""}</span></button></td><td title="${row.usage.length ? h(callCount(row)) : "No usage in selected period"}">${row.usage.length ? measuredCalls(row) : "—"}</td><td class="token-cell" title="${row.usage.length ? row.missingUsage ? `${count(row.missingUsage, "entry")} with incomplete token data` : "Observed input and output tokens" : "No usage in selected period"}">${row.usage.length ? knownTokenLabel(row.usage, row.tokens, "total") : "—"}</td><td class="cost-cell" title="${h(costDescription(row.cost))}">${h(costLabel(row.cost))}</td><td class="share-column"><div class="share-cell"><progress max="${all || 1}" value="${row.tokens}" aria-label="${h(row.project.name)} share of observed tokens"></progress><span>${row.usage.length && all ? `${Math.round((row.tokens / all) * 100)}%` : "—"}</span></div></td><td><button class="icon-button" data-project="${h(row.project.id)}" aria-label="View ${h(row.project.name)} usage">${icon("chevron")}</button></td></tr>`).join("")}</tbody></table></div>${!rows.length ? '<div class="mini-empty">No registered projects or attributed local sessions.</div>' : ""}</section>${!embedded && !demo ? '<div class="coverage-note"><span>Projects appear when opened with hoosage, found in this profile’s previously opened local folders, found in VS Code’s stored Chat history, or found in completed local CLI/JetBrains sessions. A new project card does not imply earlier Chat usage.</span></div>' : ""}`;
}

function activity(calls: UsageCall[]) {
  const sorted = groupSessions(calls);
  return `<section class="card activity-card"><div class="card-heading"><h2>Sessions & calls</h2><span class="small-tag">${callCount(totals(calls))}</span></div>${
    !calls.length
      ? '<div class="mini-empty">' +
        icon("activity") +
        "No activity in this period.</div>"
      : sorted
          .slice(0, visibleSessions)
          .map(([key, list]) => {
            const t = totals(list);
            const first = list[0]!;
            const p = data!.projects.find((p) => p.id === first.projectId);
            const latest = list.reduce(
              (time, call) => Math.max(time, call.timestamp),
              0,
            );
            return `<div class="session"><button class="session-toggle" data-focus="session-${h(key)}" data-session="${h(key)}" aria-expanded="${expandedSession === key}"><span class="session-icon">${icon("activity")}</span><span class="session-title"><strong>${h(p?.name ?? "Unknown project")}</strong><small>${new Date(latest).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit" })}${first.sessionId ? "" : " · Unlinked call"}${first.source === "cli" ? " · CLI" : first.source === "jetbrains" ? " · JetBrains" : first.source === "chat-history" ? " · Imported" : ""}</small></span><span class="session-count">${callCount(t)}</span><strong class="session-usage">${h(costLabel(costs(list)))}<small>${knownTokenLabel(list, t.tokens, "total")} observed tokens</small></strong>${icon("chevron")}</button>${
              expandedSession === key
                ? `<div class="session-detail">${byModel(list)
                    .map(
                      (m) =>
                        `<div><span>${h(m.model)}</span><span>${callCount(m)} · ${list.filter((c) => c.model === m.model).every((c) => c.input === undefined) ? "—" : number(m.input)} in / ${list.filter((c) => c.model === m.model).every((c) => c.output === undefined) ? "—" : number(m.output)} out · ${h(costLabel(costs(list.filter((c) => c.model === m.model))))}</span></div>`,
                    )
                    .join(
                      "",
                    )}<p>${[t.failed ? count(t.failed, "failed entry") : "", t.missingUsage ? `${count(t.missingUsage, "entry")} missing token data` : "", costDescription(costs(list))].filter(Boolean).map(h).join(" · ")}</p></div>`
                : ""
            }</div>`;
          })
          .join("")
  }${sorted.length > visibleSessions ? `<div class="activity-more"><button class="button" data-action="moreSessions" data-focus="moreSessions">Show next ${Math.min(100, sorted.length - visibleSessions)} sessions</button><span>${Math.min(visibleSessions, sorted.length)} of ${sorted.length} shown</span></div>` : ""}</section>`;
}

function about() {
  return `<div class="about-grid"><section class="card about-card"><h2>Stored data</h2><p>Model names, tokens, costs, timing and session IDs are stored on the extension host. Prompts, responses, code and tool arguments are excluded.</p></section><section class="card about-card"><h2>Projects</h2><p>Trusted VS Code workspaces register when opened with hoosage active; setup is needed only once per profile. Earlier registrations remain visible. Hoosage also scans this profile’s saved records of previously opened local, single-folder workspaces in the background. Those project cards may have no captured usage; this discovery scan does not import past Chat calls by itself. Workspaces, remote folders and deleted folders with stored VS Code Chat history also get a card. Clones and worktrees count separately; multi-root workspaces count as one workspace group when opened.</p><p>Completed local CLI and JetBrains sessions discover projects by their recorded working directory, even if those projects were never opened in VS Code. Ambiguous locations stay unassigned. Windows, WSL and container paths remain separate workspace identities, even when names match.</p></section><section class="card about-card"><h2>Token counts</h2><p>Completed Copilot Chat calls are deduplicated; missing values stay unknown. Cache reads are part of input tokens. Inline completions and usage on other hosts are excluded.</p><p>Copilot CLI session-state entries summarize model requests and appear after a CLI session ends.</p><p>Imported Chat entries summarize one Chat request each. VS Code stores its summed output tokens, model-call count and Copilot-reported credits, but input tokens only when the request made a single model call.</p></section><section class="card about-card"><h2>History</h2><p>Live Chat collection starts after setup and reload. Earlier completed Chat requests that VS Code itself still stores locally are imported, marked “Imported”, kept in hoosage storage, and not double-counted once live collection has started for a project. Chats that VS Code already deleted cannot be recovered. Existing CLI session-state history on this host is read separately. Stopping tracking keeps your history.</p><p>To delete history, stop tracking, reload, then delete hoosage’s project storage.</p></section></div>
  <section class="card pricing-details"><h2>Costs in USD</h2><p>Reported Copilot credits take priority: 1 credit = $0.01. ≈ marks an estimate; + marks a subtotal with unpriced usage.</p><p>Estimates use the <a href="${PRICING_SOURCE}">Copilot price table</a> from ${PRICING_DATE}, including cache rates and long-context tiers. These rates also apply to older calls. Missing cache details are assumed zero. Unknown models, incomplete token counts and CLI aggregates that could cross long-context tiers stay unpriced.</p><p>Usage value excludes subscription fees, allowances, discounts and taxes. It is not your bill.</p><p class="pricing-coverage">${h(costDescription(costs(selectedCalls())))}</p></section>
  <section class="card connection-card"><div><h2>Tracking</h2><p>${demo ? "Preview · Sample data" : h(data!.statusDetail)}</p>${data!.skippedLines ? `<p>${count(data!.skippedLines, "invalid record")} skipped.</p>` : ""}<p>Chat setup applies to all trusted VS Code projects in this profile. Local CLI and JetBrains projects are discovered without setup. Stop tracking before uninstalling to restore the previous Copilot settings.</p></div><div class="connection-actions">${demo ? action("Exit preview", "exitDemo") : data!.status === "reload" ? action("Reload window", "reload", true) : data!.canStopTracking || data!.status === "active" || data!.status === "waiting" ? action("Stop tracking", "disable") : action("Enable Chat tracking once", "enable", true)}<button class="button" data-action="diagnose">Diagnose tracking</button><button class="button" data-action="settings">Settings</button></div></section>`;
}

root.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLElement>(
    "[data-action],[data-page],[data-days],[data-shift],[data-project],[data-session]",
  );
  if (!button) return;
  event.preventDefault();
  if (button.dataset.page) {
    page = button.dataset.page;
    expandedSession = undefined;
    save();
    render();
    window.scrollTo({ top: 0 });
    return;
  }
  if (button.dataset.days) {
    days = Number(button.dataset.days);
    visibleSessions = 100;
    save();
    render();
    return;
  }
  if (button.dataset.shift) {
    const today = localDateKey(data!.updatedAt);
    const shifted = shiftLocalDate(
      endDate ?? today,
      button.dataset.shift === "previous" ? -days : days,
    );
    if (shifted) endDate = shifted >= today ? undefined : shifted;
    visibleSessions = 100;
    save();
    render();
    return;
  }
  if (button.dataset.project) {
    projectId = button.dataset.project;
    page = "overview";
    visibleSessions = 100;
    save();
    render();
    window.scrollTo({ top: 0 });
    return;
  }
  if (button.dataset.session) {
    expandedSession =
      expandedSession === button.dataset.session
        ? undefined
        : button.dataset.session;
    render();
    return;
  }
  const action = button.dataset.action;
  if (action === "moreSessions") {
    visibleSessions += 100;
    render();
    return;
  }
  if (action === "demo") {
    demo = true;
    data = demoSnapshot();
    projectId = "all";
    page = "overview";
    render();
    return;
  }
  if (action === "exitDemo") {
    demo = false;
    data = real;
    projectId = "all";
    render();
    return;
  }
  if (action === "export") {
    if (demo) {
      announce("Exit preview to export usage.");
      return;
    }
    send("export", {
      projectId: page === "projects" ? "all" : projectId,
      days,
      endDate,
      format: "csv",
    });
    return;
  }
  if (action === "refresh") {
    if (demo) {
      announce("Sample data cannot be refreshed.");
      return;
    }
    send("refresh");
    announce("Refreshing…");
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(
      () => announce("No response from VS Code. Reopen the dashboard."),
      10000,
    );
    return;
  }
  if (demo && action !== "open") {
    announce("Exit preview to change settings.");
    return;
  }
  if (action) send(action);
});
root.addEventListener("change", (event) => {
  const select = event.target as HTMLSelectElement;
  if (select.id === "project") {
    projectId = select.value;
    visibleSessions = 100;
    save();
    render();
  }
  if (select.id === "end-date") {
    const today = localDateKey(data!.updatedAt);
    endDate =
      periodEnd(data!.updatedAt, select.value) === undefined ||
      select.value === today
        ? undefined
        : select.value;
    visibleSessions = 100;
    save();
    render();
  }
});
window.addEventListener("message", (event) => {
  if (event.data?.type === "snapshot") {
    clearTimeout(refreshTimer);
    real = event.data.snapshot as Snapshot;
    if (!demo) {
      data = real;
      render();
    }
  }
});
if (api) send("ready");
else {
  real = {
    projects: [],
    calls: [],
    status: "off",
    statusDetail:
      "Enable Copilot Chat tracking once for all projects. Local sessions are indexed automatically.",
    updatedAt: Date.now(),
    skippedLines: 0,
    errors: [],
  };
  demo = true;
  data = demoSnapshot();
  render();
}
