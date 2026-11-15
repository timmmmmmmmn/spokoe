package nl.timvanbergen.spokoe

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

/**
 * Spokoe op Android: dezelfde interface als op de Mac (uit de app zelf, geen internet nodig om
 * hem te tonen) in een WebView, met de Rust-kern die afspeelt en een dienst voor de achtergrond.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private var ready = false

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val pickFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data))
        fileCallback = null
    }

    // Opslaan (CSV): eerst vraagt Android waar, dan schrijven we.
    private var pendingSave: String? = null
    private val saveFile = registerForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { uri ->
        val text = pendingSave ?: return@registerForActivityResult
        pendingSave = null
        if (uri != null) contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray()) }
        toast(if (uri != null) "Opgeslagen" else "Niet opgeslagen")
    }

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    private val listener: (JSONObject, String) -> Unit = { msg, text -> runOnUiThread { onEvent(msg, text) } }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        @Suppress("DEPRECATION")
        window.statusBarColor = Color.TRANSPARENT
        @Suppress("DEPRECATION")
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) window.isNavigationBarContrastEnforced = false
        // De volumeknoppen regelen de muziek.
        volumeControlStream = AudioManager.STREAM_MUSIC

        // Via adb (met de telefoon aan je computer) de pagina kunnen inspecteren.
        WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this)
        web.setBackgroundColor(getColor(R.color.page_bg))
        web.overScrollMode = View.OVER_SCROLL_NEVER
        setContentView(web)
        WindowCompat.getInsetsController(window, web).isAppearanceLightStatusBars = false

        ViewCompat.setOnApplyWindowInsetsListener(web) { view, insets ->
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val d = resources.displayMetrics.density
            view.setPadding(0, 0, 0, ime.bottom)
            pushInsets(sys.top / d, if (ime.bottom > 0) 0f else sys.bottom / d)
            WindowInsetsCompat.CONSUMED
        }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
        }
        web.addJavascriptInterface(Bridge(), "SpokoeAndroid")
        web.webViewClient = object : WebViewClient() {
            // Links naar buiten (Spotify, songteksten) in de browser.
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                openOutside(req.url.toString())
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                pickFile.launch(params.createIntent())
                return true
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Eerst de pagina laten sluiten wat open staat; anders naar de achtergrond (de muziek speelt door).
                web.evaluateJavascript("window.spokoeBack ? spokoeBack() : false") { handled ->
                    if (handled != "true") moveTaskToBack(true)
                }
            }
        })

        Core.ensure(this)
        Core.listen(listener)
        loadPage()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        Updater.checkQuietly(this)
    }

    override fun onResume() {
        super.onResume()
        Updater.resume(this)
    }

    override fun onDestroy() {
        Core.unlisten(listener)
        super.onDestroy()
    }

    /** De pagina uit de app zelf, met een dun laagje zodat hij "Android" weet en ons berichten stuurt. */
    private fun loadPage() {
        val read = { name: String -> assets.open(name).bufferedReader().use { it.readText() } }
        val shim = """
            window.webkit = { messageHandlers: { spokoe: { postMessage: s => SpokoeAndroid.post(s) } } };
            document.documentElement.classList.add('mobile', 'android');
        """.trimIndent()
        val html = read("index.html")
            .replace("/*CSS*/", read("app.css"))
            .replace("<script>//JS</script>", "<script>$shim</script><script>${read("app.js")}</script>")
        web.loadDataWithBaseURL("https://spokoe.app/", html, "text/html", "utf-8", null)
    }

    private var insets = 0f to 0f
    private fun pushInsets(top: Float, bottom: Float) {
        insets = top to bottom
        web.evaluateJavascript("document.documentElement.style.setProperty('--safe-top','${top}px');document.documentElement.style.setProperty('--safe-bottom','${bottom}px')", null)
    }

    private fun onEvent(msg: JSONObject, text: String) {
        when (msg.optString("type")) {
            // Inloggen: de pagina van Spotify in de browser; daarna komt de browser vanzelf terug.
            "openUrl" -> openOutside(msg.optString("url"))
            "loggedIn" -> startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
            "play" -> if (msg.optBoolean("playing")) startPlayback()
        }
        web.evaluateJavascript("window.spokoe&&spokoe.recv($text)", null)
    }

    private fun startPlayback() {
        val i = Intent(this, PlaybackService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
    }

    private fun openOutside(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) { toast("Kan de link niet openen") }
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()

    /** Berichten van de pagina: de meeste gaan naar de kern, een paar doet de app zelf. */
    inner class Bridge {
        @JavascriptInterface
        fun post(text: String) {
            val msg = try { JSONObject(text) } catch (_: Exception) { return }
            when (msg.optString("cmd")) {
                "ready" -> runOnUiThread { ready = true; pushInsets(insets.first, insets.second) }
                "open" -> runOnUiThread { openOutside(msg.optString("url")) }
                "copy" -> runOnUiThread {
                    getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Spokoe", msg.optString("text")))
                }
                "saveFile" -> runOnUiThread { pendingSave = msg.optString("text"); saveFile.launch(msg.optString("name")) }
                "checkUpdate" -> runOnUiThread { Updater.check(this@MainActivity, manual = true) }
                "theme" -> runOnUiThread {
                    val light = !msg.optBoolean("dark", true)
                    WindowCompat.getInsetsController(window, web).apply { isAppearanceLightStatusBars = light; isAppearanceLightNavigationBars = light }
                }
                "mini", "openLog", "show" -> Unit
                "play", "resume", "toggle" -> { runOnUiThread { startPlayback() }; Core.post(text) }
                else -> Core.post(text)
            }
            if (msg.optString("cmd") == "ready") Core.post(text)
        }
    }
}
