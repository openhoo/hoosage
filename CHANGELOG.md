# Changelog

## 0.6.0 (2026-09-22)

### Features

- track JetBrains Copilot usage from session-state files (55ec15f)

## 0.5.1 (2026-09-22)

### Bug Fixes

- keep id-less CLI shutdowns distinct and reject array events (b7f09e5)

## 0.5.0 (2026-09-22)

### Features

- track Copilot CLI usage from session-state files (dd1c7e4)

## 0.4.0 (2026-09-22)

### Features

- adopt OpenHoo governance toolchain and automated releases (9c1332d)

### Bug Fixes

- mark generated collector token as non-secret for hooray scan (53ed189)

### Other Changes

- Build hoosage Copilot usage extension (23cdc44)

## 0.3.0 — 2026-09-22

- Support current Copilot application-scoped telemetry settings through a shared local receiver and immutable window-to-project routing.
- Fix setup readback and accept Copilot SDK environment mirrors while rejecting conflicting destinations or content capture.
- Verify real Copilot Pro usage in two separate projects with GPT-5.6 Luna and GPT-5 mini.
- Move the public repository and release builds to GitHub.

## 0.2.0 — 2026-09-22

- USD usage value from Copilot-reported credits, with clearly marked token-price estimates when missing.
- Cost breakdowns by project, model and session, plus status bar and CSV export.
- Cache-read/write accounting, long-context prices and explicit partial coverage.
- Graphite and blue theme, simplified heading controls and removal of the header/footer copy.

## 0.1.0 — 2026-09-22

- Project-scoped Copilot Chat usage via a private local OTLP collector.
- Dashboard, sidebar, status bar, project comparison and session activity.
- Token/model breakdowns, 7/14/30-day filtering and CSV export.
- Explicit sample preview, privacy allowlist, duplicate suppression and incomplete-data reporting.
- Dark, light, high-contrast, keyboard and narrow-layout support.
