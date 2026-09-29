package com.example.javdownloader

import android.Manifest
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.webkit.*
import android.widget.*
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.floatingactionbutton.FloatingActionButton
import com.google.android.material.textfield.TextInputLayout
import java.net.URLDecoder
import java.util.regex.Pattern

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var progressBar: ProgressBar
    private lateinit var errorContainer: View
    private lateinit var errorDetailText: TextView
    private lateinit var btnRetry: Button
    private lateinit var btnChangeServer: Button
    private lateinit var fabSettings: FloatingActionButton
    private lateinit var prefs: SharedPreferences

    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingSharedUrl: String? = null

    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (fileChooserCallback == null) return@registerForActivityResult
        val results = if (result.resultCode == RESULT_OK && result.data != null) {
            val dataString = result.data?.dataString
            val clipData = result.data?.clipData
            when {
                clipData != null -> {
                    val count = clipData.itemCount
                    Array(count) { i -> clipData.getItemAt(i).uri }
                }
                dataString != null -> arrayOf(Uri.parse(dataString))
                else -> null
            }
        } else {
            null
        }
        fileChooserCallback?.onReceiveValue(results)
        fileChooserCallback = null
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ -> }

    companion object {
        private const val PREFS_NAME = "jav_downloader_prefs"
        private const val KEY_SERVER_URL = "server_url"
        const val DEFAULT_CLOUD_URL = "https://uniloader.dpdns.org"
        const val DEFAULT_LAN_URL = "http://192.168.0.10:3050"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        initViews()
        setupWebView()
        setupListeners()
        handleIncomingIntent(intent)
        requestNotificationPermission()

        val serverUrl = getCurrentServerUrl()
        webView.loadUrl(serverUrl)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    private fun getCurrentServerUrl(): String {
        return prefs.getString(KEY_SERVER_URL, DEFAULT_CLOUD_URL) ?: DEFAULT_CLOUD_URL
    }

    private fun setServerUrl(url: String) {
        val cleanUrl = url.trim().trimEnd('/')
        prefs.edit().putString(KEY_SERVER_URL, cleanUrl).apply()
        webView.loadUrl(cleanUrl)
    }

    private fun initViews() {
        webView = findViewById(R.id.webView)
        swipeRefresh = findViewById(R.id.swipeRefresh)
        progressBar = findViewById(R.id.progressBar)
        errorContainer = findViewById(R.id.errorContainer)
        errorDetailText = findViewById(R.id.errorDetailText)
        btnRetry = findViewById(R.id.btnRetry)
        btnChangeServer = findViewById(R.id.btnChangeServer)
        fabSettings = findViewById(R.id.fabSettings)

        swipeRefresh.setColorSchemeColors(0xFF6366F1.toInt())
        swipeRefresh.setProgressBackgroundColorSchemeColor(0xFF1E2230.toInt())
    }

    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        val userAgent = settings.userAgentString
        settings.userAgentString = "$userAgent JAVDownloaderApp/1.0"

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                progressBar.visibility = View.VISIBLE
                errorContainer.visibility = View.GONE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                progressBar.visibility = View.GONE
                swipeRefresh.isRefreshing = false
                errorContainer.visibility = View.GONE
                webView.visibility = View.VISIBLE

                pendingSharedUrl?.let { sharedUrl ->
                    injectSharedUrl(sharedUrl)
                    pendingSharedUrl = null
                }
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    progressBar.visibility = View.GONE
                    swipeRefresh.isRefreshing = false
                    webView.visibility = View.GONE
                    errorContainer.visibility = View.VISIBLE
                    errorDetailText.text = "Failed to connect to ${getCurrentServerUrl()}\n(${error?.description ?: "Connection refused"})"
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false
                val currentServer = getCurrentServerUrl()

                if (url.startsWith(currentServer) || url.startsWith("/") || url.contains("uniloader.dpdns.org") || url.contains("nazuna.dpdns.org") || url.contains("192.168.")) {
                    return false
                }

                return try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    startActivity(intent)
                    true
                } catch (e: Exception) {
                    false
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                super.onProgressChanged(view, newProgress)
                progressBar.progress = newProgress
                if (newProgress >= 100) {
                    progressBar.visibility = View.GONE
                } else {
                    progressBar.visibility = View.VISIBLE
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@MainActivity.fileChooserCallback?.onReceiveValue(null)
                this@MainActivity.fileChooserCallback = filePathCallback

                val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "*/*"
                    addCategory(Intent.CATEGORY_OPENABLE)
                }

                try {
                    filePickerLauncher.launch(intent)
                } catch (e: Exception) {
                    this@MainActivity.fileChooserCallback = null
                    return false
                }
                return true
            }
        }

        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            handleDownload(url, userAgent, contentDisposition, mimeType)
        }
    }

    private fun setupListeners() {
        swipeRefresh.setOnRefreshListener {
            webView.reload()
        }

        btnRetry.setOnClickListener {
            errorContainer.visibility = View.GONE
            webView.visibility = View.VISIBLE
            webView.loadUrl(getCurrentServerUrl())
        }

        btnChangeServer.setOnClickListener {
            showServerSettingsDialog()
        }

        fabSettings.setOnClickListener {
            showServerSettingsDialog()
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    private fun handleDownload(url: String, userAgent: String, contentDisposition: String, mimeType: String) {
        try {
            var filename = URLUtil.guessFileName(url, contentDisposition, mimeType)
            if (contentDisposition.contains("filename=")) {
                val match = Regex("filename=['\"]?([^'\";]+)['\"]?").find(contentDisposition)
                if (match != null) {
                    filename = URLDecoder.decode(match.groupValues[1], "UTF-8")
                }
            }

            val request = DownloadManager.Request(Uri.parse(url)).apply {
                setMimeType(mimeType)
                addRequestHeader("User-Agent", userAgent)
                val cookie = CookieManager.getInstance().getCookie(url)
                if (cookie != null) {
                    addRequestHeader("Cookie", cookie)
                }
                setDescription("Downloading file from JAV-Downloader...")
                setTitle(filename)
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
            }

            val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            dm.enqueue(request)
            Toast.makeText(this, "Downloading: $filename", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Download failed: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent == null) return
        if (intent.action == Intent.ACTION_SEND && intent.type == "text/plain") {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
            val matcher = Pattern.compile("https?://[^\\s]+").matcher(text)
            if (matcher.find()) {
                val extractedUrl = matcher.group()
                pendingSharedUrl = extractedUrl
                if (webView.url != null) {
                    injectSharedUrl(extractedUrl)
                    pendingSharedUrl = null
                }
                Toast.makeText(this, "Received Link: $extractedUrl", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun injectSharedUrl(targetUrl: String) {
        val escaped = targetUrl.replace("'", "\\'")
        val js = """
            (function() {
                var input = document.getElementById('urlInput') || document.querySelector('input[type=text]');
                if (input) {
                    input.value = '$escaped';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    var form = document.querySelector('form');
                    var btn = document.getElementById('downloadBtn') || document.querySelector('button[type=submit]');
                    if (btn) { btn.click(); }
                }
            })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    private fun showServerSettingsDialog() {
        val dialogView = layoutInflater.inflate(R.layout.dialog_server_settings, null)
        val rgServerOptions = dialogView.findViewById<RadioGroup>(R.id.rgServerOptions)
        val rbCloud = dialogView.findViewById<RadioButton>(R.id.rbCloud)
        val rbLan = dialogView.findViewById<RadioButton>(R.id.rbLan)
        val rbCustom = dialogView.findViewById<RadioButton>(R.id.rbCustom)
        val tilCustomUrl = dialogView.findViewById<TextInputLayout>(R.id.tilCustomUrl)
        val etCustomUrl = dialogView.findViewById<EditText>(R.id.etCustomUrl)

        val currentUrl = getCurrentServerUrl()
        when (currentUrl) {
            DEFAULT_CLOUD_URL -> rbCloud.isChecked = true
            DEFAULT_LAN_URL -> rbLan.isChecked = true
            else -> {
                rbCustom.isChecked = true
                tilCustomUrl.visibility = View.VISIBLE
                etCustomUrl.setText(currentUrl)
            }
        }

        rgServerOptions.setOnCheckedChangeListener { _, checkedId ->
            if (checkedId == R.id.rbCustom) {
                tilCustomUrl.visibility = View.VISIBLE
            } else {
                tilCustomUrl.visibility = View.GONE
            }
        }

        MaterialAlertDialogBuilder(this, com.google.android.material.R.style.ThemeOverlay_MaterialComponents_Dialog_Alert)
            .setTitle("Server Configuration")
            .setView(dialogView)
            .setPositiveButton("Save & Connect") { _, _ ->
                val newUrl = when (rgServerOptions.checkedRadioButtonId) {
                    R.id.rbCloud -> DEFAULT_CLOUD_URL
                    R.id.rbLan -> DEFAULT_LAN_URL
                    R.id.rbCustom -> {
                        val input = etCustomUrl.text.toString().trim()
                        if (input.isNotEmpty()) input else DEFAULT_CLOUD_URL
                    }
                    else -> DEFAULT_CLOUD_URL
                }
                setServerUrl(newUrl)
                Toast.makeText(this, "Connecting to: $newUrl", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }
}
