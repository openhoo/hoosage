# hoosage for JetBrains IDEs

This is the standalone JetBrains IDE plugin for hoosage. It opens a **hoosage** tool window in a local project and reads completed GitHub Copilot sessions from `~/.copilot/session-state` (or `$COPILOT_HOME/session-state`). It requires a JetBrains IDE based on the 2025.2 platform or newer and the GitHub Copilot plugin to write local session-state files.

The plugin reads sessions marked `client_name: copilot-intellij` and includes only sessions whose recorded working directory matches the open IDE project's normalized base path. It shows model requests, observed tokens, reported nano-AIU converted to USD, model breakdown and completed sessions. Updates appear after the Copilot session writes a `session.shutdown` event; the tool window refreshes every ten seconds. Missing request, token or cost values remain unknown. A `+` on totals means that some entries have unknown values. A labelled preview is available without Copilot data. The date range control is labelled for screen readers; overlapping refresh requests are combined. CSV exports ask before replacing an existing file. Usage columns sort numerically, and completion dates include the year.

The plugin keeps its usage model in memory and never writes prompts, responses, code, tool arguments or repository URLs. CSV export contains only date, model, request and token counts, and reported usage value. It does not claim to show GitHub billing, premium requests, inline completions or usage from other hosts. No account or network service is used by hoosage. Project titles and model names render as plain text, so embedded HTML cannot load external content.

## Install

Download `hoosage-jetbrains-*.zip` from the [GitHub Releases](https://github.com/openhoo/hoosage/releases) page. In the IDE, choose **Settings → Plugins → Install Plugin from Disk**, select the ZIP, and restart the IDE. Open a project and select the **hoosage** tool window.

## Build from source

Use JDK 21:

```sh
cd jetbrains
./gradlew test buildPlugin verifyPluginStructure
```

The ZIP is written to `build/distributions/`. The Gradle build downloads the IntelliJ Platform SDK; the installed plugin does not need Gradle or Node.js.

The standalone VS Code extension is built from the repository root. Its telemetry setup and history are separate from this plugin.
