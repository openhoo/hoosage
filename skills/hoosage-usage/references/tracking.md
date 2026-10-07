# Collection, hosts, and troubleshooting

## Local VS Code

Hoosage setup enables `github.copilot.chat.otel.enabled`, selects `otlp-http`,
sets `otlpEndpoint` to its authenticated loopback collector, clears `outfile`,
and sets `captureContent` false. Do not manually copy the token/endpoint between
profiles or machines. Telemetry-off preferences and enterprise/environment
overrides can prevent upstream delivery; diagnostics report these conflicts.
Never bypass organization policy just to make the dashboard update.

Workspace URI hashes and registered extension-host session IDs select projects;
the active editor does not. Same-named folders/clones/worktrees and case-distinct POSIX folders remain distinct. Reopen older workspace groups to upgrade local case-preserving attribution hashes; unmigrated ambiguous groups stay unassigned.
Multi-root workspaces are a Workspace group; open roots separately when separate
attribution is needed. Missing source files/history are not measured zeros.

Local stored usage is profile/host-specific and outside repositories. Startup
indexes usage and imports allowlisted metadata from surviving VS Code transcripts.
Later scans can fill in metadata that completed after the first import. Hashed request/message aliases deduplicate late identifiers; multi-call input remains unknown. It cannot recover deleted transcripts or manufacture historical token counts.
Imported entries after the first day of live capture are excluded from totals
to avoid double counting. Diagnostics show indexing and collection states
without exposing raw storage paths, collector tokens, or message content.

## CLI, WSL, and remote hosts

Copilot CLI/JetBrains source sessions live under `~/.copilot/session-state` or
`$COPILOT_HOME/session-state`. Usage is grouped by recorded working directory;
missing/ambiguous directories retain an unassigned source group. VS Code polls
these sources every five seconds. The standalone JetBrains plugin instead
requires exact project-path matching and completed sessions.

On Windows, optional WSL CLI reading only inspects running distributions; it
does not start stopped ones. `hoosage.readWslCliSessions` controls that behavior.
This is distinct from receiving real Chat telemetry in a WSL window.

For WSL/Dev Container windows, install Hoosage in the remote workspace host and
reload. Then prove a real Chat entry is saved there. Collector reachability alone
does not establish supported upstream delivery. Profiles/hosts never share
endpoints or migrate history automatically.

**Configure Shared Project Sync** is an opt-in exchange of allowlisted usage
metadata through a physical folder reachable by both hosts, outside repositories,
with the same group ID. Use each host's own absolute path syntax. It cannot
recover spans never received. **Disable Shared Project Sync** stops future
exchange on that host; previously shared records remain until explicitly removed.

## Troubleshooting order

| Observation | Check |
| --- | --- |
| Empty page | Real vs demo, selected dates/project, indexing state |
| Collector mismatch/unreachable | Diagnose correct host/profile, competing listener, saved settings |
| Real Chat request absent | Completed span, telemetry policy, exporter environment, remote delivery |
| CLI totals late | Checkpoint/shutdown state and source directory, not Chat collector |
| Incorrect apparent project | Full workspace identity/source group, multi-root or different clone |
| Costs missing | Unknown model/tokens, coverage/exclusion label, reported vs estimate source |

Read only redacted diagnostic metadata by default. Raw history includes private
content upstream and is not needed to prove routine collector configuration.
