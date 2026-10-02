---
name: hoosage-usage
description: Install and use Hoosage for local Copilot usage tracking in VS Code or JetBrains, diagnose missing collection and project attribution, interpret costs and coverage, and export a selected usage period.
---

# Use Hoosage

Determine the editor, profile, trusted workspace, host arrangement, and whether
tracking is already enabled. Installing this skill supplies guidance, not the
editor extension. Hoosage requires no cloud account/backend of its own.

## VS Code setup

1. Obtain `hoosage.vsix` from `openhoo/hoosage` GitHub Releases or CI artifacts.
   Run **Extensions: Install from VSIX…**, then open a trusted folder workspace.
   The supported minimum is VS Code 1.119 with Copilot OTel settings available.
2. Run **hoosage: Open Dashboard**. Use **Enable Chat tracking once** only when
   setup is intended: it changes this profile's user-level Copilot exporter
   settings for all trusted projects, disables content capture, and directs spans
   to an authenticated loopback collector. Existing windows need a reload.
3. Use a normal Copilot Chat request and verify that measured Chat entries increase
   in the intended project after the completed span is exported. A labelled
   preview or reachable collector does not prove real collection.
4. Select the project and period, then **Export Usage** when an export is requested.
   CSV uses the same selection; unknown values remain empty.

Use **hoosage: Diagnose Tracking** for failures before editing settings/storage.
The diagnostic intentionally omits raw endpoint/token/history content. Read
[tracking.md](references/tracking.md) for hosts, local history, and troubleshooting.
Never paste the collector URL token or raw Chat transcripts into diagnostics.

## JetBrains setup

Install `hoosage-jetbrains-*.zip` using **Settings → Plugins → Install Plugin from
Disk**, restart, and open the **hoosage** tool window. The standalone plugin
requires platform 2025.2+ and local GitHub Copilot session-state files. It reads
completed `copilot-intellij` sessions whose working directory exactly matches
the open project's base path, and refreshes every ten seconds. VS Code collector
setup/history is separate; do not configure its OTel endpoint for this plugin.

## Interpret measurements

- Observed model calls/tokens are not an invoice, remaining allowance, premium
  requests, inline completions, or all usage on other hosts/cloud agents.
- Missing values are unknown. `—` means unavailable, `≈` estimated cost, and `+`
  a subtotal that excludes unpriced usage. Cache usage is not added twice.
- Reported usage value and fallback model-price estimates have different sources;
  retain those labels and estimate-table dates in exports/comparisons.
- Chat usage is assigned to call start. CLI cost can appear at usage checkpoints;
  token/request summaries appear after shutdown. Do not infer a lost live call
  merely from an unfinished CLI session.

For missing data check period/project selection and indexing first, then
diagnose the correct window/profile/host. Preserve existing history; do not
delete it or replace unknown values with zero to make a dashboard appear complete.
Stop collection through **hoosage: Stop Tracking** when requested; shared-project
sync is a separate explicit setup with separate cleanup behavior.
