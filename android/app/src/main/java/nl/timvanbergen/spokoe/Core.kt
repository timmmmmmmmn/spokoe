package nl.timvanbergen.spokoe

import android.content.Context
import org.json.JSONObject

/**
 * De Rust-kern (librespot + geluidslaag), dezelfde als in de Mac-app. Berichten gaan erin met
 * [post]; gebeurtenissen komen eruit via [next], dat in een eigen thread steeds wordt aangeroepen.
 */
object Core {
    init { System.loadLibrary("spokoe_core") }

    @JvmStatic private external fun start(dir: String)
    @JvmStatic external fun post(json: String)
    @JvmStatic private external fun next(): String

    private val listeners = mutableListOf<(JSONObject, String) -> Unit>()
    @Volatile private var started = false

    /** Eén keer per proces: kern starten en gebeurtenissen doorgeven aan wie luistert. */
    @Synchronized
    fun ensure(context: Context) {
        if (started) return
        started = true
        start(context.applicationContext.filesDir.absolutePath)
        Thread({
            while (true) {
                val text = next()
                if (text.isEmpty()) continue
                val msg = try { JSONObject(text) } catch (_: Exception) { continue }
                synchronized(listeners) { listeners.toList() }.forEach { it(msg, text) }
            }
        }, "spokoe-events").apply { isDaemon = true }.start()
    }

    fun listen(l: (JSONObject, String) -> Unit) = synchronized(listeners) { listeners += l }
    fun unlisten(l: (JSONObject, String) -> Unit) = synchronized(listeners) { listeners -= l }

    fun cmd(name: String, extra: Map<String, Any> = emptyMap()) =
        post(JSONObject(extra).put("cmd", name).toString())
}
