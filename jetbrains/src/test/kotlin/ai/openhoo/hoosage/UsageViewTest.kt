package ai.openhoo.hoosage

import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.LightPlatformTestCase
import com.intellij.testFramework.PlatformTestUtil
import java.awt.Component
import java.awt.Container
import java.awt.image.BufferedImage
import java.nio.file.Files
import java.time.Instant
import javax.imageio.ImageIO
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JTable
import javax.swing.JLabel
import javax.swing.JTextArea

/** Drives the production Swing view against an isolated IDE fixture and synthetic session state. */
class UsageViewTest : LightPlatformTestCase() {
    fun testNativeUsagePreviewFilteringRefreshAndDisposal() {
        val root = Files.createTempDirectory("hoosage-jb-ui-")
        val projectPath = PlatformTestUtil.getOrCreateProjectBaseDir(project).toNioPath()
        val session = Files.createDirectory(root.resolve("synthetic"))
        Files.writeString(session.resolve("workspace.yaml"), "client_name: copilot-intellij\ncwd: $projectPath\n")
        val now = Instant.now()
        fun event(id: String, timestamp: Instant, requests: Int, input: Int): String =
            """{"id":"$id","type":"session.shutdown","timestamp":"$timestamp","data":{"modelMetrics":{"gpt-5":{"requests":{"count":$requests},"usage":{"inputTokens":$input,"outputTokens":20}}}}}"""
        Files.writeString(session.resolve("events.jsonl"),
            event("old", now.minusSeconds(10 * 86_400), 1, 100) + "\n" + event("recent", now.minusSeconds(60), 2, 150) + "\n")
        val view = UsageView(project, UsageScanner(root))
        try {
            val widgets = descendants(view.component)
            val preview = widgets.filterIsInstance<JButton>().single { it.text == "Preview sample" }
            val refresh = widgets.filterIsInstance<JButton>().single { it.text == "Refresh" }
            val export = widgets.filterIsInstance<JButton>().single { it.text == "Export CSV" }
            val days = widgets.filterIsInstance<JComboBox<*>>().single()
            val sessions = widgets.filterIsInstance<JTable>().single { it.columnCount == 5 }
            val models = widgets.filterIsInstance<JTable>().single { it.columnCount == 4 }
            val status = widgets.filterIsInstance<JTextArea>().first { it.text.contains("Reading local") }
            assertEquals("Usage date range", days.accessibleContext.accessibleName)
            assertFalse(export.isEnabled)
            view.start()
            PlatformTestUtil.waitWithEventsDispatching("Usage scan did not reach the Swing view",
                { sessions.rowCount == 2 && refresh.isEnabled }, 10)
            assertEquals("2", models.getValueAt(0, 1))
            assertEquals("—", models.getValueAt(0, 3))
            assertTrue(export.isEnabled)
            days.selectedIndex = 0
            assertEquals(1, sessions.rowCount)
            assertEquals("1", models.getValueAt(0, 1))
            preview.doClick()
            assertEquals("Exit preview", preview.text)
            assertTrue(status.text.startsWith("Preview · sample data"))
            assertFalse(export.isEnabled)
            assertEquals(3, sessions.rowCount)
            preview.doClick()
            assertEquals(1, sessions.rowCount)
            assertTrue(export.isEnabled)
            Files.writeString(session.resolve("events.jsonl"), "\n" + event("new", now.minusSeconds(30), 3, 190) + "\n",
                java.nio.file.StandardOpenOption.APPEND)
            refresh.doClick()
            assertFalse("Old results must not export during a pending refresh", export.isEnabled)
            assertTrue(export.accessibleContext.accessibleDescription.contains("refreshed"))
            PlatformTestUtil.waitWithEventsDispatching("Manual refresh did not update usage",
                { sessions.rowCount == 2 && refresh.isEnabled }, 10)
            assertTrue(status.text.contains("record(s) skipped"))
            assertFalse("Skipped source records must not produce an apparently complete export", export.isEnabled)
            assertTrue(export.accessibleContext.accessibleDescription.contains("unreadable"))
            assertEquals("2", models.getValueAt(0, 1))
            Files.writeString(session.resolve("events.jsonl"), Files.readString(session.resolve("events.jsonl")).replace("\n\n", "\n"))
            refresh.doClick()
            PlatformTestUtil.waitWithEventsDispatching("Export did not recover after source repair", { export.isEnabled && refresh.isEnabled }, 10)
            val expectedRows = sessions.rowCount
            Disposer.dispose(view)
            Files.writeString(session.resolve("events.jsonl"), event("after-disposal", now.minusSeconds(10), 4, 220) + "\n",
                java.nio.file.StandardOpenOption.APPEND)
            refresh.doClick()
            PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
            assertEquals(expectedRows, sessions.rowCount)
            java.nio.file.Paths.get("build/reports/ui-smoke/usage.png").let { file ->
                Files.createDirectories(file.parent)
                view.component.setSize(440, 800)
                view.component.addNotify()
                repeat(3) { layout(view.component) }
                val modelSection = models.parent.parent.parent
                val cards = descendants(view.component).filterIsInstance<JLabel>()
                    .single { it.text == "Model requests" }.parent.parent
                assertEquals("Cards and tables should share the left margin", cards.x, modelSection.x)
                assertTrue("The table must use the body width", modelSection.width >= 380)
                assertTrue("Status must not collapse the scrollable body", modelSection.parent.parent.height > 0)
                Files.writeString(file.resolveSibling("layout.txt"), descendants(view.component).joinToString("\n") {
                    "${it.javaClass.simpleName}: bounds=${it.bounds}; preferred=${it.preferredSize}"
                })
                val image = BufferedImage(440, 800, BufferedImage.TYPE_INT_ARGB)
                val graphics = image.createGraphics()
                try { view.component.printAll(graphics) } finally { graphics.dispose() }
                ImageIO.write(image, "png", file.toFile())
                view.component.removeNotify()
            }
        } finally {
            Disposer.dispose(view)
            root.toFile().deleteRecursively()
        }
    }

    private fun descendants(component: Component): List<Component> = listOf(component) +
        (component as? Container)?.components.orEmpty().flatMap(::descendants)

    private fun layout(component: Component) {
        (component as? Container)?.let { container ->
            container.doLayout()
            container.components.forEach(::layout)
        }
    }
}
