package ai.openhoo.hoosage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

class UsageScannerTest {
    @Test fun `only matching JetBrains project is counted and snapshots become deltas`() {
        val root = Files.createTempDirectory("hoosage-jb-")
        try {
            val project = Files.createDirectory(root.resolve("project"))
            val other = Files.createDirectory(root.resolve("other"))
            val state = Files.createDirectory(root.resolve("state"))
            session(state, "jetbrains", "copilot-intellij", project, listOf(
                shutdown("one", 100, 20, 2, 500_000_000),
                shutdown("two", 150, 30, 3, 700_000_000),
                shutdown("two", 150, 30, 3, 700_000_000),
                shutdown("idle", 150, 30, 3, 700_000_000),
            ))
            session(state, "other", "copilot-intellij", other, listOf(shutdown("other", 800, 90, 4, 100)))
            session(state, "cli", "copilot-cli", project, listOf(shutdown("cli", 900, 90, 4, 100)))
            val result = UsageScanner(state).scan(project)
            assertEquals(2, result.entries.size)
            assertEquals(listOf(50L, 100L), result.entries.mapNotNull { it.input }.sorted())
            assertEquals(listOf(200_000_000L, 500_000_000L), result.entries.mapNotNull { it.nanoAiu }.sorted())
            assertEquals(listOf(1L, 2L), result.entries.mapNotNull { it.requests }.sorted())
            assertEquals(0, result.skipped)
            assertFalse(result.entries.toString().contains("SECRET"))
            val cached = UsageScanner(state)
            assertEquals(2, cached.scan(project).entries.size)
            val events = state.resolve("jetbrains/events.jsonl")
            Files.writeString(events, shutdown("three", 170, 35, 4, 800_000_000) + "\n",
                java.nio.file.StandardOpenOption.APPEND)
            assertEquals(3, cached.scan(project).entries.size)
        } finally { root.toFile().deleteRecursively() }
    }

    @Test fun `missing values and falling cumulative cost stay unknown`() {
        val root = Files.createTempDirectory("hoosage-jb-")
        try {
            val project = Files.createDirectory(root.resolve("project"))
            val state = Files.createDirectory(root.resolve("state"))
            session(state, "jetbrains", "copilot-intellij", project, listOf(
                shutdown("one", 100, 20, 1, null),
                shutdown("two", 150, 30, 2, 600),
                shutdown("three", 200, 40, 3, 100),
            ))
            val result = UsageScanner(state).scan(project)
            assertEquals(3, result.entries.size)
            assertTrue(result.entries.all { it.nanoAiu == null })
            assertEquals(listOf(50L, 50L, 100L), result.entries.mapNotNull { it.input }.sorted())
        } finally { root.toFile().deleteRecursively() }
    }

    @Test fun `CSV excludes sensitive event fields and guards spreadsheet cells`() {
        val record = UsageEntry(Instant.parse("2026-09-23T10:00:00Z"), "=danger", "session", 1, 2, 3, null, null, 1)
        val csv = exportCsv(listOf(record))
        assertTrue(csv.contains("'=danger"))
        assertTrue(csv.contains("0.00000000001"))
        assertFalse(csv.contains("session"))
        assertFalse(csv.contains("null"))
    }

    @Test fun `a shutdown interval spanning different project paths is excluded`() {
        val root = Files.createTempDirectory("hoosage-jb-")
        try {
            val project = Files.createDirectory(root.resolve("project"))
            val other = Files.createDirectory(root.resolve("other"))
            val state = Files.createDirectory(root.resolve("state"))
            val events = listOf(
                """{"type":"session.start","data":{"context":{"cwd":"$project"}}}""",
                shutdown("one", 100, 20, 1, 100),
                """{"type":"session.resume","data":{"context":{"cwd":"$other"}}}""",
                """{"type":"session.resume","data":{"context":{"cwd":"$project"}}}""",
                shutdown("mixed", 150, 30, 2, 150),
                shutdown("after", 180, 40, 3, 180),
            )
            session(state, "jetbrains", "copilot-intellij", project, events)
            val result = UsageScanner(state).scan(project)
            assertEquals(listOf(30L, 100L), result.entries.mapNotNull { it.input }.sorted())
            assertEquals(1, result.skipped)
        } finally { root.toFile().deleteRecursively() }
    }

    @Test fun `quoted paths with hashes match exactly and relative paths do not`() {
        val root = Files.createTempDirectory("hoosage-jb-")
        try {
            val project = Files.createDirectory(root.resolve("project # one"))
            val state = Files.createDirectory(root.resolve("state"))
            session(state, "jetbrains", "copilot-intellij", project,
                listOf(shutdown("one", 100, 20, 1, 0)))
            Files.writeString(state.resolve("jetbrains/workspace.yaml"),
                "client_name: 'copilot-intellij'\ncwd: '$project'\n")
            assertEquals(1, UsageScanner(state).scan(project).entries.size)
            Files.writeString(state.resolve("jetbrains/workspace.yaml"),
                "client_name: copilot-intellij\ncwd: .\n")
            assertTrue(UsageScanner(state).scan(project).entries.isEmpty())
        } finally { root.toFile().deleteRecursively() }
    }

    @Test fun `equivalent normalized paths do not discard valid usage`() {
        val root = Files.createTempDirectory("hoosage-jb-")
        try {
            val project = Files.createDirectory(root.resolve("project"))
            val state = Files.createDirectory(root.resolve("state"))
            session(state, "jetbrains", "copilot-intellij", project, listOf(
                shutdown("one", 100, 20, 1, 100),
                """{"type":"session.resume","data":{"context":{"cwd":"$project/../project"}}}""",
                shutdown("two", 150, 30, 2, 150),
            ))
            val result = UsageScanner(state).scan(project)
            assertEquals(listOf(50L, 100L), result.entries.mapNotNull { it.input }.sorted())
            assertEquals(0, result.skipped)
        } finally { root.toFile().deleteRecursively() }
    }

    @Test fun `escaped YAML paths are decoded and ambiguous client fields are excluded`() {
        val root = Files.createTempDirectory("hoosage-jb-")
        try {
            val project = Files.createDirectory(root.resolve("project's \"one\""))
            val state = Files.createDirectory(root.resolve("state"))
            session(state, "jetbrains", "copilot-intellij", project, listOf(shutdown("one", 100, 20, 1, 0)))
            val workspace = state.resolve("jetbrains/workspace.yaml")
            val scanner = UsageScanner(state)
            val quotedPath = com.google.gson.Gson().toJson(project.toString())
            Files.writeString(workspace, "client_name: copilot-intellij\ncwd: $quotedPath # local path\n")
            assertEquals(1, scanner.scan(project).entries.size)
            val singleQuotedPath = project.toString().replace("'", "''")
            Files.writeString(workspace, "client_name: 'copilot-intellij'\ncwd: '$singleQuotedPath'\n")
            assertEquals(1, scanner.scan(project).entries.size)
            Files.writeString(workspace, "client_name: copilot-cli\nclient_name: copilot-intellij\ncwd: $quotedPath\n")
            assertTrue(scanner.scan(project).entries.isEmpty())
            Files.writeString(workspace, "nested:\n  client_name: copilot-intellij\ncwd: $quotedPath\n")
            assertTrue(scanner.scan(project).entries.isEmpty())
            Files.writeString(workspace, "client_name: 'copilot-intellij'junk\ncwd: $quotedPath\n")
            assertTrue(scanner.scan(project).entries.isEmpty())
        } finally { root.toFile().deleteRecursively() }
    }

    @Test fun `CSV quotes controls and preserves unknown counts`() {
        val record = UsageEntry(Instant.parse("2026-09-23T10:00:00Z"), "  @formula,\"model\"\nnext",
            "secret-session", null, null, null, null, null, null)
        val csv = exportCsv(listOf(record))
        assertTrue(csv.contains("'  @formula,\"\"model\"\"\nnext"))
        assertTrue(csv.endsWith("\"\",\"\",\"\",\"\",\"\",\"\"\n"))
        assertFalse(csv.contains("secret-session"))
    }

    @Test fun `table totals sort numerically instead of by their formatted text`() {
        assertTrue(compareUsageValues("9", "100") < 0)
        assertTrue(compareUsageValues("1,000+", "90") > 0)
        assertTrue(compareUsageValues("$9.0000", "$100.0000") < 0)
        assertTrue(compareUsageValues("<$0.0001", "$0.0002+") < 0)
        assertTrue(compareUsageValues("—", "0") > 0)
        assertEquals(0, compareUsageValues("—", "—"))
    }

    @Test fun `model names render as plain text without creating Swing HTML views`() {
        val renderer = plainTextCellRenderer()
        val label = renderer.getTableCellRendererComponent(javax.swing.JTable(1, 1),
            "<html><b>untrusted model</b></html>", false, false, 0, 0) as javax.swing.JLabel
        assertEquals("<html><b>untrusted model</b></html>", label.text)
        assertEquals(true, label.getClientProperty("html.disable"))
        assertEquals(null, label.getClientProperty(javax.swing.plaf.basic.BasicHTML.propertyKey))
    }

    private fun session(root: Path, id: String, client: String, cwd: Path, events: List<String>) {
        val dir = Files.createDirectory(root.resolve(id))
        Files.writeString(dir.resolve("workspace.yaml"), "client_name: $client\ncwd: $cwd\n")
        Files.writeString(dir.resolve("events.jsonl"), events.joinToString("\n", postfix = "\n"))
    }

    private fun shutdown(id: String, input: Int, output: Int, requests: Int, cost: Long?): String {
        val costField = cost?.let { ",\"totalNanoAiu\":$it" }.orEmpty()
        return """{"id":"$id","type":"session.shutdown","timestamp":"2025-09-23T10:00:00Z","data":{"modelMetrics":{"gpt-5":{"usage":{"inputTokens":$input,"outputTokens":$output},"requests":{"count":$requests}$costField}}},"prompt":"SECRET"}"""
    }
}
