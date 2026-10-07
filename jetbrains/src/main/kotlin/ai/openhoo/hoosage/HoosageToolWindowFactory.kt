package ai.openhoo.hoosage

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.EDT
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.Font
import java.awt.GridLayout
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import javax.swing.BorderFactory
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JFileChooser
import javax.swing.JLabel
import javax.swing.JOptionPane
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTable
import javax.swing.JTextArea
import javax.swing.SwingConstants
import javax.swing.UIManager
import javax.swing.table.DefaultTableCellRenderer
import javax.swing.table.DefaultTableModel
import javax.swing.table.TableRowSorter

class HoosageToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val view = UsageView(project)
        val content = ContentFactory.getInstance().createContent(view.component, "", false)
        content.setDisposer(view)
        toolWindow.contentManager.addContent(content)
        view.start()
    }
}

private class UsageView(private val project: Project) : Disposable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val scanner = UsageScanner()
    private val refreshLock = Mutex()
    private val projectPath: Path? = project.basePath?.let { Paths.get(it) }
    private val heading = JLabel("hoosage.")
    private val status = note("Reading local Copilot usage…")
    private val preview = JButton("Preview sample")
    private val refresh = JButton("Refresh")
    private val export = JButton("Export CSV")
    private val days = JComboBox(arrayOf("7 days", "14 days", "30 days"))
    private val cards = JPanel(GridLayout(3, 1, 0, 8))
    private val models = table(arrayOf("Model", "Requests", "Tokens", "USD"))
    private val sessions = table(arrayOf("Completed", "Model", "Requests", "Tokens", "USD"))
    private var latest = ScanResult(emptyList(), 0, "Reading local Copilot usage…")
    private var demo = false
    val component = JPanel(BorderLayout())

    init {
        heading.font = heading.font.deriveFont(Font.BOLD, 19f)
        val header = JPanel(BorderLayout(0, 8)).apply {
            border = JBUI.Borders.empty(16, 16, 12, 16)
            add(heading, BorderLayout.NORTH)
            add(JLabel().apply {
                putClientProperty("html.disable", true)
                text = "Copilot usage · ${project.name}"
            }, BorderLayout.CENTER)
            add(JPanel(GridLayout(2, 2, 8, 8)).apply {
                add(days); add(refresh); add(export); add(preview)
            }, BorderLayout.SOUTH)
        }
        val body = JPanel().apply {
            layout = javax.swing.BoxLayout(this, javax.swing.BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(4, 16, 16, 16)
            cards.maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(230))
            add(cards)
            add(section("Models", models))
            add(section("Completed sessions", sessions))
            add(note("Reported USD is a usage value, not a bill. Unknown costs stay unknown.").apply {
                border = JBUI.Borders.emptyTop(12)
            })
            add(note("Local only · no prompts, responses, code or tool arguments are stored.").apply {
                border = JBUI.Borders.emptyTop(4)
            })
        }
        component.add(header, BorderLayout.NORTH)
        component.add(JScrollPane(body).apply { border = BorderFactory.createEmptyBorder() }, BorderLayout.CENTER)
        component.add(status.apply { border = JBUI.Borders.empty(8, 16) }, BorderLayout.SOUTH)
        days.accessibleContext.accessibleName = "Usage date range"
        days.toolTipText = "Filter usage by completed session date"
        days.selectedIndex = 2
        days.addActionListener { render() }
        refresh.addActionListener { requestRefresh() }
        preview.addActionListener {
            demo = !demo
            preview.text = if (demo) "Exit preview" else "Preview sample"
            render()
        }
        export.addActionListener { exportSelected() }
        render()
    }

    fun start() {
        scope.launch {
            while (isActive) {
                scanAndRender()
                delay(10_000)
            }
        }
    }

    private fun requestRefresh() { scope.launch { scanAndRender() } }

    private suspend fun scanAndRender() {
        // Coalesce manual and periodic refreshes instead of queuing scans and
        // allowing an older result to replace the newest one on the EDT.
        if (!refreshLock.tryLock()) return
        try {
            withContext(Dispatchers.EDT) { refresh.isEnabled = false }
            val path = projectPath
            val result = try {
                if (path == null) ScanResult(emptyList(), 0, "Open a local project to see usage.")
                else withContext(Dispatchers.IO) { scanner.scan(path) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                ScanResult(emptyList(), 1, "Could not read local Copilot usage. Refresh to try again.")
            }
            withContext(Dispatchers.EDT) { latest = result; render() }
        } finally {
            refreshLock.unlock()
            if (scope.isActive) withContext(Dispatchers.EDT) { refresh.isEnabled = true }
        }
    }

    private fun selected(): List<UsageEntry> {
        val all = if (demo) sampleEntries() else latest.entries
        val lookback = when (days.selectedIndex) { 0 -> 6L; 1 -> 13L; else -> 29L }
        val start = java.time.LocalDate.now().minusDays(lookback)
            .atStartOfDay(ZoneId.systemDefault()).toInstant()
        return all.filter { !it.timestamp.isBefore(start) && !it.timestamp.isAfter(Instant.now()) }
    }

    private fun render() {
        val entries = selected()
        cards.removeAll()
        cards.add(card("Model requests", countLabel(entries.map { it.requests })))
        cards.add(card("Observed tokens", countLabel(entries.map { tokens(it) })))
        cards.add(card("Reported USD", costLabel(entries)))
        val byModel = entries.groupBy { it.model }.toList().sortedByDescending { (_, calls) ->
            calls.fold(BigInteger.ZERO) { sum, call -> sum + BigInteger.valueOf(tokens(call) ?: 0) }
        }
        update(models, byModel.map { (model, calls) ->
            arrayOf(model, countLabel(calls.map { it.requests }), countLabel(calls.map { tokens(it) }), costLabel(calls))
        })
        val date = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm", Locale.getDefault()).withZone(ZoneId.systemDefault())
        update(sessions, entries.take(100).map {
            arrayOf(date.format(it.timestamp), it.model, it.requests?.toString() ?: "—",
                tokens(it)?.toString() ?: "—", it.nanoAiu?.let { value -> usd(BigInteger.valueOf(value)) } ?: "—")
        })
        status.text = when {
            demo -> "Preview · sample data. Nothing in this view is exported."
            latest.skipped > 0 -> "${latest.status} ${latest.skipped} record(s) skipped or truncated."
            entries.isEmpty() && latest.entries.isNotEmpty() -> "No completed sessions in the selected date range."
            else -> latest.status
        }
        export.isEnabled = !demo && entries.isNotEmpty()
        cards.revalidate(); cards.repaint()
    }

    private fun exportSelected() {
        if (demo) return
        val entries = selected()
        if (entries.isEmpty()) return
        val chooser = JFileChooser().apply { selectedFile = java.io.File("hoosage-jetbrains.csv") }
        if (chooser.showSaveDialog(component) != JFileChooser.APPROVE_OPTION) return
        val destination = chooser.selectedFile.toPath()
        if (Files.exists(destination) && JOptionPane.showConfirmDialog(component,
                "Replace the existing CSV file?", "Export CSV", JOptionPane.YES_NO_OPTION,
                JOptionPane.WARNING_MESSAGE) != JOptionPane.YES_OPTION) return
        scope.launch {
            val result = try {
                withContext(Dispatchers.IO) { Files.writeString(destination, exportCsv(entries)) }
                Result.success(Unit)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                Result.failure<Unit>(error)
            }
            withContext(Dispatchers.EDT) {
                status.text = if (result.isSuccess) "Exported ${entries.size} usage records."
                    else "Could not write CSV: ${result.exceptionOrNull()?.javaClass?.simpleName}."
            }
        }
    }

    override fun dispose() { scope.cancel() }
}

private fun table(columns: Array<String>): JTable = JTable(object : DefaultTableModel(columns, 0) {
    override fun isCellEditable(row: Int, column: Int) = false
}).apply {
    rowSorter = TableRowSorter(model).apply {
        for (column in columns.indices) {
            if (columns[column] in setOf("Requests", "Tokens", "USD")) {
                setComparator(column, Comparator<Any> { left, right ->
                    compareUsageValues(left.toString(), right.toString())
                })
            }
        }
    }
    setDefaultRenderer(Any::class.java, plainTextCellRenderer())
    fillsViewportHeight = true
    rowHeight = JBUI.scale(28)
    autoResizeMode = JTable.AUTO_RESIZE_OFF
    setShowGrid(false)
    intercellSpacing = Dimension(8, 0)
    for (column in columns.indices) {
        columnModel.getColumn(column).preferredWidth = when (columns[column]) {
            "Model" -> JBUI.scale(150)
            "Completed" -> JBUI.scale(155)
            else -> JBUI.scale(90)
        }
    }
    accessibleContext.accessibleName = columns.joinToString(" / ")
}

/** Local metadata is plain text; Swing HTML must not load external images. */
internal fun plainTextCellRenderer(): DefaultTableCellRenderer = DefaultTableCellRenderer().apply {
    putClientProperty("html.disable", true)
}

/** Compare formatted totals numerically, including unknown and partial values. */
internal fun compareUsageValues(left: String, right: String): Int {
    fun number(value: String): BigDecimal? = value.trim().removePrefix("<")
        .removePrefix("$").removeSuffix("+").replace(",", "").toBigDecimalOrNull()
    val a = number(left)
    val b = number(right)
    return when {
        a == null && b == null -> 0
        a == null -> 1
        b == null -> -1
        else -> a.compareTo(b)
    }
}

private fun update(table: JTable, rows: List<Array<String>>) {
    val model = table.model as DefaultTableModel
    model.rowCount = 0
    rows.forEach { model.addRow(it) }
}

private fun section(title: String, table: JTable): JPanel = JPanel(BorderLayout(0, 8)).apply {
    alignmentX = 0f
    border = JBUI.Borders.emptyTop(18)
    maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(if (title == "Models") 208 else 288))
    add(JLabel(title).apply { font = font.deriveFont(Font.BOLD, 14f) }, BorderLayout.NORTH)
    add(JScrollPane(table).apply { preferredSize = Dimension(320, if (title == "Models") 160 else 240) }, BorderLayout.CENTER)
}

private fun note(text: String): JTextArea = JTextArea(text).apply {
    isEditable = false
    isFocusable = false
    lineWrap = true
    wrapStyleWord = true
    isOpaque = false
    font = UIManager.getFont("Label.font")
}

private fun card(title: String, value: String): JPanel = JPanel(BorderLayout(0, 6)).apply {
    border = BorderFactory.createCompoundBorder(
        BorderFactory.createLineBorder(UIManager.getColor("Separator.foreground") ?: Color.GRAY),
        JBUI.Borders.empty(10))
    add(JLabel(title), BorderLayout.NORTH)
    add(JLabel(value, SwingConstants.LEFT).apply { font = font.deriveFont(Font.BOLD, 18f) }, BorderLayout.CENTER)
}

private fun tokens(entry: UsageEntry): Long? {
    val input = entry.input ?: return null
    val output = entry.output ?: return null
    return try { Math.addExact(input, output) } catch (_: ArithmeticException) { null }
}

private fun countLabel(values: List<Long?>): String {
    if (values.isEmpty() || values.all { it == null }) return "—"
    val sum = values.filterNotNull().fold(BigInteger.ZERO) { total, value -> total + BigInteger.valueOf(value) }
    return "${java.text.NumberFormat.getIntegerInstance(Locale.US).format(sum)}${if (values.any { it == null }) "+" else ""}"
}

private fun exactUsd(nanoAiu: BigInteger): BigDecimal = BigDecimal(nanoAiu).movePointLeft(11)
private fun usd(nanoAiu: BigInteger): String {
    val amount = exactUsd(nanoAiu)
    if (amount > BigDecimal.ZERO && amount < BigDecimal("0.0001")) return "<$0.0001"
    return "$" + amount.setScale(4, RoundingMode.HALF_UP).toPlainString()
}
private fun costLabel(entries: List<UsageEntry>): String {
    if (entries.isEmpty() || entries.all { it.nanoAiu == null }) return "—"
    val value = usd(entries.fold(BigInteger.ZERO) { total, entry ->
        total + BigInteger.valueOf(entry.nanoAiu ?: 0)
    })
    return value + if (entries.any { it.nanoAiu == null }) "+" else ""
}

/** Export only the allowlisted usage fields. Prefix spreadsheet formulas. */
fun exportCsv(entries: List<UsageEntry>): String {
    fun cell(value: String): String {
        val safe = if (value.trimStart().firstOrNull() in listOf('=', '+', '-', '@')) "'$value" else value
        return "\"${safe.replace("\"", "\"\"")}\""
    }
    val header = "timestamp,model,requests,input,output,cache_read,cache_write,reported_usd"
    return buildString {
        appendLine(header)
        entries.forEach { entry ->
            appendLine(listOf(entry.timestamp.toString(), entry.model, entry.requests?.toString().orEmpty(),
                entry.input?.toString().orEmpty(), entry.output?.toString().orEmpty(),
                entry.cacheRead?.toString().orEmpty(), entry.cacheWrite?.toString().orEmpty(),
                entry.nanoAiu?.let { exactUsd(BigInteger.valueOf(it)).stripTrailingZeros().toPlainString() }.orEmpty()
            ).joinToString(",", transform = ::cell))
        }
    }
}

private fun sampleEntries(): List<UsageEntry> {
    val today = Instant.now()
    return listOf(
        UsageEntry(today.minusSeconds(3_600), "Claude Sonnet", "sample-1", 3, 12_480, 2_140, 4_100, 0, 480_000_000),
        UsageEntry(today.minusSeconds(86_400), "GPT-5", "sample-2", 2, 8_320, 980, 1_400, 0, 310_000_000),
        UsageEntry(today.minusSeconds(172_800), "Claude Sonnet", "sample-3", 4, 18_770, 3_420, 6_200, 0, null),
    )
}
