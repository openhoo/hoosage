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

    @Test fun `CSV publishing preserves existing files unless replacement was approved`() {
        val root = Files.createTempDirectory("hoosage-jb-export-")
        try {
            val destination = root.resolve("usage.csv")
            Files.writeString(destination, "previous export")
            val record = UsageEntry(Instant.parse("2026-09-23T10:00:00Z"), "gpt-5", "secret", 1, 2, 3, null, null, 1)
            try {
                writeCsv(destination, listOf(record), false)
                org.junit.Assert.fail("An existing file must not be replaced without approval")
            } catch (_: java.nio.file.FileAlreadyExistsException) { }
            assertEquals("previous export", Files.readString(destination))
            writeCsv(destination, listOf(record), true)
            assertEquals(exportCsv(listOf(record)), Files.readString(destination))
            Files.list(root).use { assertEquals(listOf(destination), it.toList()) }
        } finally { root.toFile().deleteRecursively() }
    }

    @Test fun `failed CSV publishing removes its staging file and preserves the destination`() {
        val root = Files.createTempDirectory("hoosage-jb-export-")
        try {
            val destination = Files.createDirectory(root.resolve("existing.csv"))
            val keep = destination.resolve("keep.txt")
            Files.writeString(keep, "original")
            try {
                writeCsv(destination, emptyList(), true)
                org.junit.Assert.fail("A nonempty directory cannot be replaced with an export")
            } catch (_: java.nio.file.FileSystemException) { }
            assertEquals("original", Files.readString(keep))
            Files.list(root).use { assertEquals(listOf(destination), it.toList()) }
        } finally { root.toFile().deleteRecursively() }
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

    @Test fun `missing cumulative token fields retain the last known baseline`() {
        withSession(listOf(
            shutdown("one", 100, 20, 1, 100),
            shutdown("missing", 150, 30, 2, 150).replace("\"inputTokens\":150,", ""),
            shutdown("three", 180, 40, 3, 180),
        )) { result ->
            assertEquals(listOf(80L, 100L), result.entries.mapNotNull { it.input }.sorted())
            assertEquals(1, result.entries.count { it.input == null })
        }
    }

    @Test fun `falling cost counter does not inflate later reported usage`() {
        withSession(listOf(
            shutdown("one", 100, 20, 1, 500),
            shutdown("two", 150, 30, 2, 100),
            shutdown("three", 180, 40, 3, 600),
        )) { result ->
            assertEquals(listOf(100L, 500L), result.entries.mapNotNull { it.nanoAiu }.sorted())
            assertEquals(1, result.entries.count { it.nanoAiu == null })
        }
    }

    @Test fun `a model-counter restart counts the first new-run snapshot in full`() {
        withSession(listOf(
            shutdown("one", 100, 20, 3, 500),
            shutdown("reset", 30, 5, 1, 100),
            shutdown("after", 60, 10, 2, 200),
        )) { result ->
            assertEquals(listOf(30L, 30L, 100L), result.entries.mapNotNull { it.input }.sorted())
            assertEquals(listOf(1L, 1L, 3L), result.entries.mapNotNull { it.requests }.sorted())
            assertEquals(listOf(100L, 100L, 500L), result.entries.mapNotNull { it.nanoAiu }.sorted())
        }
    }

    @Test fun `explicit invalid resume paths cannot retain previous project attribution`() {
        for (cwd in listOf(".", "", "null")) {
            val root = Files.createTempDirectory("hoosage-jb-")
            try {
                val project = Files.createDirectory(root.resolve("project"))
                val state = Files.createDirectory(root.resolve("state"))
                val raw = if (cwd == "null") "null" else com.google.gson.Gson().toJson(cwd)
                session(state, "jetbrains", "copilot-intellij", project, listOf(
                    shutdown("one", 100, 20, 1, 100),
                    """{"type":"session.resume","data":{"context":{"cwd":$raw}}}""",
                    shutdown("invalid", 150, 30, 2, 150),
                    """{"type":"session.resume","data":{"context":{"cwd":"$project"}}}""",
                    shutdown("restored", 180, 40, 3, 180),
                    shutdown("after", 200, 50, 4, 200),
                ))
                val result = UsageScanner(state).scan(project)
                assertEquals("cwd=$cwd", listOf(20L, 100L), result.entries.mapNotNull { it.input }.sorted())
                assertEquals(2, result.skipped)
            } finally { root.toFile().deleteRecursively() }
        }
    }

    @Test fun `alternate YAML key syntax and multiple documents cannot hide duplicate attribution`() {
        val root = Files.createTempDirectory("hoosage-jb-")
        try {
            val project = Files.createDirectory(root.resolve("project"))
            val state = Files.createDirectory(root.resolve("state"))
            session(state, "jetbrains", "copilot-intellij", project, listOf(shutdown("one", 100, 20, 1, 0)))
            val scanner = UsageScanner(state)
            for (suffix in listOf("client_name : copilot-cli", "'client_name': copilot-cli", "\"client_name\": copilot-cli", "\"client\\u005fname\": copilot-cli", "---\nclient_name: copilot-cli", "cwd : /other")) {
                Files.writeString(state.resolve("jetbrains/workspace.yaml"),
                    "client_name: copilot-intellij\ncwd: $project\n$suffix\n")
                val result = scanner.scan(project)
                assertTrue("suffix=$suffix", result.entries.isEmpty())
                assertEquals(1, result.skipped)
            }
        } finally { root.toFile().deleteRecursively() }
    }

    @Test fun `replayed numeric event ids cannot roll back cumulative baselines`() {
        withSession(listOf(
            shutdown("one", 100, 20, 1, 100).replace("\"id\":\"one\"", "\"id\":1"),
            shutdown("two", 150, 30, 2, 150).replace("\"id\":\"two\"", "\"id\":2"),
            shutdown("one", 100, 20, 1, 100).replace("\"id\":\"one\"", "\"id\":1"),
            shutdown("one", 100, 20, 1, 100).replace("\"id\":\"one\"", "\"id\":1.0"),
            shutdown("one", 100, 20, 1, 100).replace("\"id\":\"one\"", "\"id\":1e0"),
            shutdown("three", 180, 40, 3, 180).replace("\"id\":\"three\"", "\"id\":3"),
        )) { result ->
            assertEquals(listOf(30L, 50L, 100L), result.entries.mapNotNull { it.input }.sorted())
            assertEquals(3, result.entries.size)
        }
    }

    @Test fun `session-level costs are not added to model reported costs or exported as extra records`() {
        withSession(listOf(
            shutdown("one", 100, 20, 1, 100),
            shutdown("two", 150, 30, 2, 150).replace("\"modelMetrics\":", "\"totalNanoAiu\":999999,\"modelMetrics\":"),
            """{"id":"session-only","type":"session.shutdown","timestamp":"2025-09-23T10:00:00Z","data":{"totalNanoAiu":1234567}}""",
        )) { result ->
            assertEquals(2, result.entries.size)
            assertEquals(150L, result.entries.sumOf { it.nanoAiu ?: 0L })
            assertFalse(exportCsv(result.entries).contains("0.00000999999"))
        }
    }

    @Test fun `invalid count values stay unknown and literal zero remains measured zero`() {
        withSession(listOf(shutdown("one", 100, 20, 1, 0)
            .replace("\"inputTokens\":100", "\"inputTokens\":100.5")
            .replace("\"outputTokens\":20", "\"outputTokens\":-1")
            .replace("\"count\":1", "\"count\":\"1\""))) { result ->
            assertTrue(result.entries.isEmpty())
        }
        withSession(listOf(shutdown("one", 100, 0, 1, 0))) { result ->
            val entry = result.entries.single()
            assertEquals(0L, entry.output)
            assertEquals(0L, entry.nanoAiu)
        }
    }

    @Test fun `cache counts larger than the measured input subset stay unknown`() {
        withSession(listOf(shutdown("one", 100, 20, 1, 100)
            .replace("\"inputTokens\":100", "\"inputTokens\":100,\"cacheReadTokens\":200,\"cacheWriteTokens\":50"))) { result ->
            val entry = result.entries.single()
            assertEquals(null, entry.cacheRead)
            assertEquals(50L, entry.cacheWrite)
        }
        withSession(listOf(shutdown("one", 100, 20, 1, 100)
            .replace("\"inputTokens\":100", "\"inputTokens\":100,\"cacheReadTokens\":60,\"cacheWriteTokens\":70"))) { result ->
            val entry = result.entries.single()
            assertEquals(null, entry.cacheRead)
            assertEquals(null, entry.cacheWrite)
        }
    }

    @Test fun `individually valid cumulative cache checkpoints cannot emit impossible interval subsets`() {
        withSession(listOf(
            shutdown("one", 100, 20, 1, 100)
                .replace("\"inputTokens\":100", "\"inputTokens\":100,\"cacheReadTokens\":50"),
            shutdown("two", 130, 30, 2, 150)
                .replace("\"inputTokens\":130", "\"inputTokens\":130,\"cacheReadTokens\":90"),
        )) { result ->
            val increment = result.entries.single { it.input == 30L }
            assertEquals(null, increment.cacheRead)
            assertEquals(50L, result.entries.single { it.input == 100L }.cacheRead)
        }
    }

    @Test fun `oversized counters stay unknown and maximum supported cache subsets are bounded`() {
        withSession(listOf(shutdown("one", 100, 20, 1, 100)
            .replace("\"inputTokens\":100", "\"inputTokens\":${Long.MAX_VALUE},\"cacheReadTokens\":${Long.MAX_VALUE},\"cacheWriteTokens\":${Long.MAX_VALUE}"))) { result ->
            val entry = result.entries.single()
            assertEquals(null, entry.input)
            assertEquals(null, entry.cacheRead)
            assertEquals(null, entry.cacheWrite)
        }
        withSession(listOf(shutdown("one", 100, 20, 1, 100)
            .replace("\"inputTokens\":100", "\"inputTokens\":9007199254740991,\"cacheReadTokens\":9007199254740991,\"cacheWriteTokens\":9007199254740991"))) { result ->
            val entry = result.entries.single()
            assertEquals(9_007_199_254_740_991L, entry.input)
            assertEquals(null, entry.cacheRead)
            assertEquals(null, entry.cacheWrite)
        }
    }

    @Test fun `POSIX path case and symlinked sessions cannot merge unrelated usage`() {
        val root = Files.createTempDirectory("hoosage-jb-")
        try {
            val state = Files.createDirectory(root.resolve("state"))
            val project = root.resolve("Project")
            session(state, "lowercase", "copilot-intellij", root.resolve("project"),
                listOf(shutdown("wrong-case", 100, 20, 1, 100)))
            val outside = Files.createDirectory(root.resolve("outside"))
            session(outside, "linked", "copilot-intellij", project, listOf(shutdown("linked", 100, 20, 1, 100)))
            Files.createSymbolicLink(state.resolve("linked"), outside.resolve("linked"))
            assertTrue(UsageScanner(state).scan(project).entries.isEmpty())
            session(state, "correct", "copilot-intellij", project, listOf(shutdown("correct", 40, 5, 1, 40)))
            val scanner = UsageScanner(state)
            assertEquals(40L, scanner.scan(project).entries.single().input)
            Files.delete(state.resolve("correct/events.jsonl"))
            Files.createSymbolicLink(state.resolve("correct/events.jsonl"), outside.resolve("linked/events.jsonl"))
            val result = scanner.scan(project)
            assertTrue(result.entries.isEmpty())
            assertEquals(1, result.skipped)
        } finally { root.toFile().deleteRecursively() }
    }

    @Test fun `bounded files and malformed lines report skipped usage without exporting private data`() {
        val root = Files.createTempDirectory("hoosage-jb-")
        try {
            val project = root.resolve("project")
            val state = Files.createDirectory(root.resolve("state"))
            session(state, "malformed", "copilot-intellij", project,
                listOf("not json SECRET_PROMPT", shutdown("good", 40, 5, 1, 40)))
            session(state, "oversize", "copilot-intellij", project, emptyList())
            Files.newByteChannel(state.resolve("oversize/events.jsonl"), java.nio.file.StandardOpenOption.WRITE).use {
                it.position(32L * 1024 * 1024)
                it.write(java.nio.ByteBuffer.wrap(byteArrayOf(0)))
            }
            val result = UsageScanner(state).scan(project)
            assertEquals(1, result.entries.size)
            assertEquals(2, result.skipped)
            val csv = exportCsv(result.entries)
            assertFalse(csv.contains("SECRET_PROMPT"))
            assertFalse(csv.contains(project.toString()))
            assertFalse(csv.contains("malformed"))
        } finally { root.toFile().deleteRecursively() }
    }

    private fun withSession(events: List<String>, verify: (ScanResult) -> Unit) {
        val root = Files.createTempDirectory("hoosage-jb-")
        try {
            val project = Files.createDirectory(root.resolve("project"))
            val state = Files.createDirectory(root.resolve("state"))
            session(state, "jetbrains", "copilot-intellij", project, events)
            verify(UsageScanner(state).scan(project))
        } finally { root.toFile().deleteRecursively() }
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
