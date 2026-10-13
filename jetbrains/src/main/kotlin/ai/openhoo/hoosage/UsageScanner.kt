package ai.openhoo.hoosage

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.attribute.FileTime
import java.time.Instant

/** The complete in-memory and CSV allowlist. Event bodies and raw paths never leave scan(). */
data class UsageEntry(
    val timestamp: Instant,
    val model: String,
    val sessionId: String,
    val requests: Long?,
    val input: Long?,
    val output: Long?,
    val cacheRead: Long?,
    val cacheWrite: Long?,
    val nanoAiu: Long?,
)

data class ScanResult(val entries: List<UsageEntry>, val skipped: Int, val status: String)

private data class Counters(
    val requests: Long?, val input: Long?, val output: Long?,
    val cacheRead: Long?, val cacheWrite: Long?, val nanoAiu: Long?,
)

class UsageScanner(private val root: Path = defaultRoot()) {
    private data class Cached(
        val bytes: Long, val modified: FileTime, val cwd: String?, val projectKey: String,
        val entries: List<UsageEntry>, val skipped: Int,
    )
    private val cache = HashMap<Path, Cached>()

    companion object {
        private const val MAX_FILE_BYTES = 32L * 1024 * 1024
        private const val MAX_TOTAL_BYTES = 128L * 1024 * 1024
        private const val MAX_LINE_CHARS = 2 * 1024 * 1024
        private const val MAX_SESSIONS = 10_000L
        private const val MAX_ENTRIES = 100_000

        fun defaultRoot(): Path {
            val home = System.getenv("COPILOT_HOME")?.takeIf { it.isNotBlank() }
                ?: Paths.get(System.getProperty("user.home"), ".copilot").toString()
            return Paths.get(home, "session-state")
        }
    }

    @Synchronized fun scan(projectPath: Path): ScanResult {
        if (!Files.isDirectory(root)) {
            cache.clear()
            return ScanResult(emptyList(), 0, "No Copilot session-state directory found.")
        }
        val projectKey = pathKey(projectPath)
        val entries = ArrayList<UsageEntry>()
        var skipped = 0
        var includedBytes = 0L
        try {
            Files.list(root).use { paths ->
                val sessions = paths.filter { Files.isDirectory(it, NOFOLLOW_LINKS) }.limit(MAX_SESSIONS + 1)
                    .toList().sortedByDescending { session ->
                        runCatching { Files.getLastModifiedTime(session.resolve("events.jsonl"), NOFOLLOW_LINKS).toMillis() }
                            .getOrDefault(0L)
                    }
                if (sessions.size > MAX_SESSIONS) skipped++
                cache.keys.retainAll(sessions)
                sessions.take(MAX_SESSIONS.toInt()).forEach sessionLoop@{ session ->
                    if (entries.size >= MAX_ENTRIES) { skipped++; return@sessionLoop }
                    val workspace = session.resolve("workspace.yaml")
                    val metadata = try {
                        if (!Files.isRegularFile(workspace, NOFOLLOW_LINKS) || Files.size(workspace) > 64 * 1024) null
                        else parseWorkspace(Files.readString(workspace))
                    } catch (_: Exception) { null }
                    if (metadata == null && Files.exists(workspace, NOFOLLOW_LINKS)) skipped++
                    // Other Copilot CLI clients use the same tree. Their usage is not
                    // attributed to the JetBrains plugin or to this IDE project.
                    if (metadata?.first != "copilot-intellij") return@sessionLoop
                    val events = session.resolve("events.jsonl")
                    try {
                        if (!Files.isRegularFile(events, NOFOLLOW_LINKS) || Files.size(events) > MAX_FILE_BYTES) {
                            skipped++
                            return@sessionLoop
                        }
                        val bytes = Files.size(events)
                        if (includedBytes + bytes > MAX_TOTAL_BYTES) { skipped++; return@sessionLoop }
                        includedBytes += bytes
                        val modified = Files.getLastModifiedTime(events, NOFOLLOW_LINKS)
                        val prior = cache[session]
                        if (prior != null && prior.bytes == bytes && prior.modified == modified &&
                            prior.cwd == metadata.second && prior.projectKey == projectKey) {
                            val room = MAX_ENTRIES - entries.size
                            entries.addAll(prior.entries.take(room))
                            if (prior.entries.size > room) skipped++
                            skipped += prior.skipped
                            return@sessionLoop
                        }
                        val sessionEntries = ArrayList<UsageEntry>()
                        var sessionSkipped = 0
                        var cwd = metadata.second
                        var sawContext = false
                        var sawShutdown = false
                        var mixedCwd = false
                        val baselines = HashMap<String, Counters>()
                        val seen = HashSet<String>()
                        var ordinal = 0
                        Files.newBufferedReader(events).useLines { lines ->
                            lines.forEach lineLoop@{ line ->
                                ordinal++
                                if (line.length > MAX_LINE_CHARS) { sessionSkipped++; return@lineLoop }
                                val event = try { JsonParser.parseString(line).asJsonObject }
                                    catch (_: Exception) { sessionSkipped++; return@lineLoop }
                                val data = event.obj("data")
                                when (event.string("type")) {
                                    "session.start", "session.resume" -> {
                                        val context = data?.obj("context")
                                        if (context?.has("cwd") == true) {
                                            val next = context.string("cwd")
                                            val nextKey = next?.let(::pathKeyOrNull)
                                            if (nextKey == null || (nextKey != cwd?.let(::pathKeyOrNull) &&
                                                (sawContext || sawShutdown))) mixedCwd = true
                                            cwd = next
                                            sawContext = true
                                        }
                                    }
                                    "session.shutdown" -> {
                                        val timestamp = try {
                                            Instant.parse(event.string("timestamp"))
                                        } catch (_: Exception) { null }
                                        if (timestamp == null || timestamp.isAfter(Instant.now().plusSeconds(86_400))) {
                                            sessionSkipped++
                                            return@lineLoop
                                        }
                                        val metrics = data?.obj("modelMetrics") ?: return@lineLoop
                                        val ambiguous = mixedCwd
                                        for ((model, raw) in metrics.entrySet()) {
                                            if (model.isBlank() || !raw.isJsonObject) continue
                                            val current = counters(raw.asJsonObject).validCacheSubsets()
                                            if (current == Counters(null, null, null, null, null, null)) continue
                                            val key = "${event.eventId() ?: ordinal}:$model"
                                            if (!seen.add(key)) continue
                                            var previous = baselines[model]
                                            // Copilot can restart model counters on compaction/resume.
                                            // A cost decrease alone does not establish a new run.
                                            if (decreased(current.requests, previous?.requests) ||
                                                (decreased(current.input, previous?.input) &&
                                                    decreased(current.output, previous?.output))) previous = null
                                            val delta = Counters(
                                                difference(current.requests, previous?.requests, previous != null),
                                                difference(current.input, previous?.input, previous != null),
                                                difference(current.output, previous?.output, previous != null),
                                                difference(current.cacheRead, previous?.cacheRead, previous != null),
                                                difference(current.cacheWrite, previous?.cacheWrite, previous != null),
                                                difference(current.nanoAiu, previous?.nanoAiu, previous != null),
                                            ).validCacheSubsets()
                                            baselines[model] = Counters(
                                                retainCount(current.requests, previous?.requests),
                                                retainCount(current.input, previous?.input),
                                                retainCount(current.output, previous?.output),
                                                retainCount(current.cacheRead, previous?.cacheRead),
                                                retainCount(current.cacheWrite, previous?.cacheWrite),
                                                // A missing cost breaks coverage; do not later turn its
                                                // cumulative value into a measured interval cost.
                                                current.nanoAiu?.let { retainCount(it, previous?.nanoAiu) },
                                            )
                                            if (ambiguous || cwd?.let { pathKeyOrNull(it) } != projectKey) continue
                                            if (!hasUsage(delta)) continue
                                            if (entries.size + sessionEntries.size >= MAX_ENTRIES) {
                                                sessionSkipped++
                                                continue
                                            }
                                            sessionEntries.add(UsageEntry(timestamp, model, session.fileName.toString(),
                                                delta.requests, delta.input, delta.output,
                                                delta.cacheRead, delta.cacheWrite, delta.nanoAiu))
                                        }
                                        if (ambiguous) sessionSkipped++
                                        mixedCwd = false
                                        sawShutdown = true
                                    }
                                }
                            }
                        }
                        entries.addAll(sessionEntries)
                        skipped += sessionSkipped
                        cache[session] = Cached(bytes, modified, metadata.second, projectKey,
                            sessionEntries, sessionSkipped)
                    } catch (_: Exception) { skipped++ }
                }
            }
        } catch (_: Exception) {
            return ScanResult(entries, skipped + 1, "Could not read Copilot session-state.")
        }
        return ScanResult(entries.sortedByDescending { it.timestamp }, skipped,
            if (entries.isEmpty()) "No completed JetBrains Copilot sessions for this project yet."
            else "Usage updates after a Copilot session ends.")
    }
}

private fun parseWorkspace(text: String): Pair<String?, String?>? {
    // Parse only the single-document scalar subset that Copilot writes. Decode
    // top-level keys before checking duplicates, so quoted/escaped keys and
    // whitespace before ':' cannot hide conflicting attribution metadata.
    val fields = HashMap<String, String>()
    val mapping = Regex("""^("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$""")
    for (line in text.removePrefix("\uFEFF").lineSequence()) {
        if (line.isBlank() || line.trimStart().startsWith('#') || line.first().isWhitespace()) continue
        val match = mapping.matchEntire(line) ?: return null
        val key = scalar(match.groupValues[1]) ?: return null
        if (key == "<<") return null
        if (key !in setOf("client_name", "cwd")) continue
        if (fields.containsKey(key)) return null
        fields[key] = scalar(match.groupValues[2].trim()) ?: return null
    }
    return (fields["client_name"] ?: return null) to fields["cwd"]
}

private fun scalar(raw: String): String? {
    val value = when (raw.firstOrNull()) {
        '"' -> {
            // Copilot's quoted path strings use JSON-compatible escaping.
            var end = 1
            var escaped = false
            while (end < raw.length) {
                if (raw[end] == '"' && !escaped) break
                escaped = raw[end] == '\\' && !escaped
                end++
            }
            if (end == raw.length || !scalarSuffix(raw.substring(end + 1))) return null
            try { JsonParser.parseString(raw.substring(0, end + 1)).asString }
            catch (_: Exception) { return null }
        }
        '\'' -> {
            val value = StringBuilder()
            var end = 1
            while (end < raw.length) {
                if (raw[end] == '\'') {
                    if (end + 1 < raw.length && raw[end + 1] == '\'') {
                        value.append('\''); end += 2; continue
                    }
                    break
                }
                value.append(raw[end++])
            }
            if (end == raw.length || !scalarSuffix(raw.substring(end + 1))) return null
            value.toString()
        }
        else -> raw.replace(Regex("\\s+#.*$"), "").trim().takeIf {
            it.firstOrNull() !in listOf('&', '*', '[', '{', '|', '>') &&
                !Regex(":(?:\\s|$)").containsMatchIn(it)
        } ?: return null
    }
    return value.takeIf { it.isNotBlank() }
}

private fun scalarSuffix(suffix: String): Boolean = suffix.isBlank() ||
    (suffix.firstOrNull()?.isWhitespace() == true && suffix.trimStart().startsWith('#'))

private fun JsonObject.obj(key: String): JsonObject? = get(key)?.takeIf { it.isJsonObject }?.asJsonObject
private fun JsonObject.string(key: String): String? = try {
    get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
} catch (_: Exception) { null }
private fun JsonObject.eventId(): String? = string("id")?.takeIf { it.isNotBlank() }
    ?: get("id")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.let {
        runCatching { it.asBigDecimal.stripTrailingZeros().toPlainString() }.getOrNull()
    }
private fun JsonObject.count(key: String): Long? = try {
    get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }
        ?.asJsonPrimitive?.asBigDecimal?.toBigIntegerExact()?.longValueExact()
        ?.takeIf { it in 0..9_007_199_254_740_991L }
} catch (_: Exception) { null }
private fun counters(entry: JsonObject): Counters {
    val usage = entry.obj("usage")
    return Counters(entry.obj("requests")?.count("count"), usage?.count("inputTokens"),
        usage?.count("outputTokens"), usage?.count("cacheReadTokens"),
        usage?.count("cacheWriteTokens"), entry.count("totalNanoAiu"))
}
private fun decreased(current: Long?, previous: Long?): Boolean =
    current != null && previous != null && current < previous
private fun Counters.validCacheSubsets(): Counters {
    val measuredInput = input ?: return this
    val read = cacheRead?.takeIf { it <= measuredInput }
    val write = cacheWrite?.takeIf { it <= measuredInput }
    return if (read != null && write != null && write > measuredInput - read)
        copy(cacheRead = null, cacheWrite = null)
    else copy(cacheRead = read, cacheWrite = write)
}
private fun retainCount(current: Long?, previous: Long?): Long? = when {
    current == null -> previous
    previous == null -> current
    else -> maxOf(current, previous)
}
private fun difference(current: Long?, previous: Long?, hadSnapshot: Boolean): Long? = when {
    current == null -> null
    !hadSnapshot -> current
    previous == null -> null
    current >= previous -> current - previous
    else -> null
}
private fun hasUsage(counters: Counters): Boolean = listOf(
    counters.requests, counters.input, counters.output,
    counters.cacheRead, counters.cacheWrite, counters.nanoAiu,
).any { it != null && it > 0 }
private fun pathKeyOrNull(raw: String): String? = try {
    Paths.get(raw).takeIf { it.isAbsolute }?.let(::pathKey)
} catch (_: Exception) { null }
private fun pathKey(path: Path): String = path.toAbsolutePath().normalize().toString()
