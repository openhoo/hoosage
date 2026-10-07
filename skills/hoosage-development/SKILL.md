---
name: hoosage-development
description: Develop and verify Hoosage's VS Code extension and JetBrains plugin, including local telemetry ingestion, project attribution, usage accounting, dashboard behavior, privacy, and packaged artifacts.
---

# Hoosage development

Read root `AGENTS.md` and `CONTRIBUTING.md`. Use Node 22+ and npm for VS Code;
the standalone JetBrains build uses JDK 21 and its Gradle wrapper. Current source,
package scripts, and CI take precedence over this guide.

## Find the implementation

| Surface | Source |
| --- | --- |
| VS Code activation, commands, settings | `src/extension.ts`, `package.json` |
| Authenticated local OTLP collection | `src/core/collector.ts`, `routing.ts`, `environment.ts` |
| Span parsing and file ingestion | `src/core/parser.ts`, `tailer.ts`, `cli.ts`, `chat-history-import.ts` |
| Workspace identity, discovery, caches | `src/core/project-index.ts`, `path-identity.ts`, `project-metadata.ts`, `workspace-discovery.ts` |
| Usage aggregation and estimates | `src/core/analytics.ts`, `pricing.ts`, `types.ts` |
| Webview, demo, layout | `src/webview/`, `media/app.css` |
| JetBrains plugin | `jetbrains/src/main/kotlin/ai/openhoo/hoosage/` |

## Build and verify

From the repository root:

```bash
npm ci
npm run check
npm run package
```

`check` runs TypeScript, unit tests, an extension lifecycle regression, the production build, and dashboard browser tests (including calendar, responsive layout, focus and accessibility). `package`
produces `hoosage.vsix`; do both before shipping, as `AGENTS.md` requires.
Use `npm run preview` for labelled sample-data visual work. It does not prove
the extension host or real Copilot delivery.

For activation, collector, settings, or packaging changes:

```bash
npm run test:extension
```

The isolated VS Code harness uses a separate profile and synthetic telemetry,
with recovery/mismatch/missing-history cases. `VSCODE_EXECUTABLE` and
`COPILOT_EXTENSION_PATH` can select existing installations. No account or
billable request is needed for these tests. They do not prove real Copilot spans.

For JetBrains changes, from `jetbrains/`:

```bash
./gradlew test buildPlugin verifyPluginStructure
```

Verify the ZIP in `jetbrains/build/distributions`; the VSIX does not include the
standalone plugin. Preserve the root MIT license and third-party notices.

## Contracts to preserve

- Attribute Chat spans through registered session IDs and workspace URI hashes,
  never the active editor or folder display name. Do not merge host/profile,
  clone, worktree, multi-root, or WSL identities by name. Preserve POSIX path case, legacy project IDs, and both local attribution hash sets; exclude both hash sets from exports.
- Count completed chat spans once; exclude agent totals/logs/cumulative metrics.
  CLI cumulative checkpoints need reliable increments and event deduplication across cached restarts. Late transcript metadata must keep multi-call input unknown and retain hashed identity aliases outside exported calls.
- Missing usage stays unknown, not zero. Cache reads/writes are input subsets.
  Reported per-request cost and estimated cost remain distinguishable; never add
  session totals again to the same per-request costs or claim invoice coverage.
- Imported transcripts and live spans lack shared request IDs; preserve the
  live-capture cutoff that prevents double counting and bounded background reads.
- Persist/export only allowlisted usage metadata. Never persist prompts,
  responses, code, tool arguments, credentials, collector URLs, or repository URLs.
- Keep collector loopback binding, token authentication, origin rejection,
  bounded bodies, setting restoration, and foreign endpoint/profile rejection.
- Preserve local webview assets/CSP, labelled previews, empty/error/indexing
  states, keyboard calendar controls, and narrow/high-contrast layouts.

Document user-visible changes in README and applicable JetBrains guidance.
Check manifest command/settings declarations alongside extension implementation.
Documentation skills need installation/link verification; the root shipping
checks still apply. Do not use a developer's actual usage history as a fixture.
