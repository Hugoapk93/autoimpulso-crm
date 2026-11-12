package com.termux.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.net.Uri;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.widget.Toolbar;

import com.termux.R;
import com.termux.shared.logger.Logger;
import com.termux.shared.shell.TermuxSession;
import com.termux.shared.termux.TermuxConstants;
import com.termux.terminal.TerminalSession;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;

/**
 * Launcher activity of the Autoimpulso CRM fork.
 *
 * It shows the CRM panel (served by the Node.js bot on http://127.0.0.1:3000,
 * or on a free port if 3000 is busy — the bot writes its real port to
 * ~/crm-bot/.port) in a WebView. Behind it, the regular Termux environment keeps running the bot in a
 * TermuxSession named "crm-bot" (or "crm-setup" during the first-run install).
 *
 * The terminal is never hidden away: the "Terminal" menu entry opens the original
 * {@link TermuxActivity}, which is the place to diagnose the bot if it fails.
 */
public class CrmActivity extends Activity implements ServiceConnection {

    private static final String LOG_TAG = "CrmActivity";

    /** Bot home inside Termux: /data/data/com.termux/files/home/crm-bot */
    private static final String CRM_BOT_DIR = TermuxConstants.TERMUX_HOME_DIR_PATH + "/crm-bot";
    private static final String BOT_SESSION_NAME = "crm-bot";
    private static final String SETUP_SESSION_NAME = "crm-setup";
    /** Preferred port (first try) and the file where the bot writes its real port. */
    private static final int DEFAULT_PORT = 3000;
    private static final String PORT_FILE = CRM_BOT_DIR + "/.port";
    /** Progress file written by setup-crm.sh: one line "0-100|step text". */
    private static final String SETUP_PROGRESS_FILE = TermuxConstants.TERMUX_HOME_DIR_PATH + "/.crm-setup.progress";
    /** Token file and prefs for the "show token" dialog. */
    private static final String ENV_FILE = CRM_BOT_DIR + "/.env";
    private static final String TOKEN_PREFS = "crm_token";
    private static final String TOKEN_SHOWN_KEY = "token_shown";

    private static final int POLL_INTERVAL_MS = 1000;
    /** Time allowed for the bot to answer when it only needs to be started. */
    private static final int START_TIMEOUT_MS = 240_000;
    /** Time allowed on first run (downloads Node.js + npm install need internet). */
    private static final int SETUP_TIMEOUT_MS = 10 * 60_000;

    private WebView mWebView;
    private View mLoadingView;
    private View mErrorView;
    private TextView mLoadingText;
    private TextView mErrorText;
    private ProgressBar mSetupProgress;
    private TextView mSetupPercent;
    private int mLastSetupProgress = -1;
    private String mLastSetupStep = null;

    private TermuxService mTermuxService;
    private boolean mBound = false;
    private boolean mResumed = false;
    private boolean mBootstrapDone = false;
    private volatile boolean mDestroyed = false;
    private volatile boolean mServerUp = false;
    private volatile boolean mSetupRunning = false;
    private Thread mPollThread;
    private Thread mProgressThread;

    /** File picker (upload) y guardado con SAF (download) del crm.db. */
    private static final int REQUEST_FILE_CHOOSER = 1001;
    private static final int REQUEST_CREATE_CRMDB = 1002;
    private static final int REQUEST_CREATE_XLSX = 1003;
    private ValueCallback<Uri[]> mFilePathCallback;
    private byte[] mPendingDownload;

    // Progress updater on the UI thread itself: it reads ~/.crm-setup.progress
    // every 500 ms and re-posts itself until the server is up. It exists
    // because the background progress thread alone did not move the bar while
    // the app sat in the foreground — the bar only advanced after coming back
    // from the Terminal (onResume). Driving the read from the main thread
    // removes that dependency; the background thread stays as a second reader.
    private final Handler mMainHandler = new Handler(Looper.getMainLooper());
    private final Runnable mProgressUpdater = new Runnable() {
        @Override
        public void run() {
            if (mDestroyed || mServerUp) return;
            readSetupProgress();
            mMainHandler.postDelayed(this, 500);
        }
    };

    private void startProgressUpdater() {
        mMainHandler.removeCallbacks(mProgressUpdater);
        mMainHandler.post(mProgressUpdater);
    }

    private void stopProgressUpdater() {
        mMainHandler.removeCallbacks(mProgressUpdater);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_crm);

        Toolbar toolbar = findViewById(R.id.crm_toolbar);
        toolbar.setTitle(R.string.application_name);
        toolbar.setTitleTextColor(0xFFFFFFFF);
        setActionBar(toolbar);

        mWebView = findViewById(R.id.crm_webview);
        mLoadingView = findViewById(R.id.crm_loading);
        mErrorView = findViewById(R.id.crm_error);
        mLoadingText = findViewById(R.id.crm_loading_text);
        mErrorText = findViewById(R.id.crm_error_text);
        mSetupProgress = findViewById(R.id.crm_setup_progress);
        mSetupPercent = findViewById(R.id.crm_setup_percent);

        WebSettings settings = mWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        // The panel is served over plain http on loopback and loads https CDN assets.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        mWebView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String host = request.getUrl().getHost();
                if ("127.0.0.1".equals(host) || "localhost".equals(host)) {
                    // Same panel, stay inside the WebView.
                    return false;
                }
                // Any external link goes to the browser.
                startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                return true;
            }
        });

        // Puente para el panel: el token viene directo del .env (el panel no
        // tiene que pedirlo) y la descarga del crm.db deja elegir la carpeta.
        mWebView.addJavascriptInterface(new CrmBridge(), "Android");
        // Sin esto, <input type="file"> no abre el selector en el WebView.
        mWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (mFilePathCallback != null) mFilePathCallback.onReceiveValue(null);
                mFilePathCallback = filePathCallback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                startActivityForResult(Intent.createChooser(intent, getString(R.string.crm_choose_file)), REQUEST_FILE_CHOOSER);
                return true;
            }
        });

        Button retryButton = findViewById(R.id.crm_retry_button);
        retryButton.setOnClickListener(v -> retry());
        Button terminalButton = findViewById(R.id.crm_terminal_button);
        terminalButton.setOnClickListener(v -> openTerminal());

        showLoading(R.string.crm_loading_connecting);

        // Start the TermuxService so it keeps running even if this activity goes away,
        // then bind to it to manage the bot session.
        Intent serviceIntent = new Intent(this, TermuxService.class);
        startService(serviceIntent);
        mBound = bindService(serviceIntent, this, Context.BIND_AUTO_CREATE);
        if (!mBound) {
            Logger.logError(LOG_TAG, "bindService() failed");
            showError(getString(R.string.crm_error_service));
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        mResumed = true;
        maybeStartBot();
        // Coming back from the terminal (or any pause) refreshes the bar at once
        // and restarts the progress readers if they died while the app was away.
        // Only while we are still waiting for the server (poll thread alive).
        if (!mServerUp && mPollThread != null && mPollThread.isAlive()) {
            readSetupProgress();
            startProgressThread();
            startProgressUpdater();
        }
    }

    @Override
    protected void onPause() {
        mResumed = false;
        super.onPause();
    }

    /** Puente JavaScript para el panel (window.Android). */
    private class CrmBridge {
        /** Token del .env, para que el panel no tenga que pedirlo. */
        @JavascriptInterface
        public String getApiToken() {
            String t = readApiToken();
            return t == null ? "" : t;
        }

        /** Descarga el crm.db y abre el selector para elegir dónde guardarlo. */
        @JavascriptInterface
        public void downloadCrmDb() {
            downloadFileViaSaf("/api/backup/download", "crm.db", REQUEST_CREATE_CRMDB);
        }

        /** Descarga los contactos en Excel y abre el selector para elegir dónde guardarlo. */
        @JavascriptInterface
        public void downloadContactsExcel() {
            downloadFileViaSaf("/api/contacts/export", "contactos.xlsx", REQUEST_CREATE_XLSX);
        }

        /** Baja un archivo del backend (con el token) y abre el selector SAF. */
        private void downloadFileViaSaf(String endpoint, String filename, int requestCode) {
            new Thread(() -> {
                try {
                    String token = readApiToken();
                    if (token == null) {
                        runOnUiThread(() -> Toast.makeText(CrmActivity.this, R.string.crm_token_missing, Toast.LENGTH_SHORT).show());
                        return;
                    }
                    URL url = new URL(getServerUrl() + endpoint);
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestProperty("x-api-token", token);
                    conn.setConnectTimeout(10000);
                    conn.setReadTimeout(30000);
                    if (conn.getResponseCode() != HttpURLConnection.HTTP_OK) {
                        runOnUiThread(() -> Toast.makeText(CrmActivity.this, R.string.crm_download_failed, Toast.LENGTH_SHORT).show());
                        return;
                    }
                    ByteArrayOutputStream baos = new ByteArrayOutputStream();
                    try (InputStream in = conn.getInputStream()) {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = in.read(buf)) != -1) baos.write(buf, 0, n);
                    }
                    mPendingDownload = baos.toByteArray();
                    runOnUiThread(() -> {
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType("application/octet-stream");
                        intent.putExtra(Intent.EXTRA_TITLE, filename);
                        startActivityForResult(intent, requestCode);
                    });
                } catch (Exception e) {
                    Logger.logError(LOG_TAG, "downloadFileViaSaf failed: " + e.getMessage());
                    runOnUiThread(() -> Toast.makeText(CrmActivity.this, R.string.crm_download_failed, Toast.LENGTH_SHORT).show());
                }
            }).start();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_FILE_CHOOSER) {
            if (mFilePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
            mFilePathCallback.onReceiveValue(results);
            mFilePathCallback = null;
            return;
        }
        if (requestCode == REQUEST_CREATE_CRMDB || requestCode == REQUEST_CREATE_XLSX) {
            if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null || mPendingDownload == null) {
                mPendingDownload = null;
                return;
            }
            try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                if (out == null) throw new IOException("openOutputStream null");
                out.write(mPendingDownload);
                Toast.makeText(this, R.string.crm_download_saved, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Logger.logError(LOG_TAG, "save crm.db failed: " + e.getMessage());
                Toast.makeText(this, R.string.crm_download_failed, Toast.LENGTH_SHORT).show();
            }
            mPendingDownload = null;
        }
    }

    @Override
    protected void onDestroy() {
        mDestroyed = true;
        if (mPollThread != null) mPollThread.interrupt();
        if (mProgressThread != null) mProgressThread.interrupt();
        stopProgressUpdater();
        if (mBound) {
            try {
                unbindService(this);
            } catch (IllegalArgumentException e) {
                Logger.logError(LOG_TAG, "unbindService failed: " + e.getMessage());
            }
            mBound = false;
        }
        mTermuxService = null;
        super.onDestroy();
        // NOTE: the TermuxService is intentionally NOT stopped here: the bot must keep
        // running in the background after the user leaves the app.
    }

    @Override
    public void onServiceConnected(ComponentName componentName, IBinder service) {
        Logger.logDebug(LOG_TAG, "onServiceConnected");
        mTermuxService = ((TermuxService.LocalBinder) service).service;
        maybeStartBot();
    }

    /**
     * Start the bot once the service is bound AND the activity is visible: the
     * bootstrap installer shows a progress dialog, which needs a window token
     * (same guard as TermuxActivity's mIsVisible).
     */
    private void maybeStartBot() {
        if (!mResumed || mTermuxService == null || mBootstrapDone) return;
        if (isFinishing() || isDestroyed()) return;
        mBootstrapDone = true;

        // Installs the bootstrap on first run (shows its own progress dialog) and
        // calls back immediately if it is already installed.
        TermuxInstaller.setupBootstrapIfNeeded(CrmActivity.this, this::ensureBotRunning);
    }

    @Override
    public void onServiceDisconnected(ComponentName name) {
        Logger.logDebug(LOG_TAG, "onServiceDisconnected");
        mTermuxService = null;
        mBootstrapDone = false; // Next connection must redo the bot check.
        if (!mDestroyed) showError(getString(R.string.crm_error_service));
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.crm_menu, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        int id = item.getItemId();
        if (id == R.id.crm_menu_terminal) {
            openTerminal();
            return true;
        } else if (id == R.id.crm_menu_reload) {
            retry();
            return true;
        } else if (id == R.id.crm_menu_restart_bot) {
            restartBot();
            return true;
        } else if (id == R.id.crm_menu_token) {
            String token = readApiToken();
            if (token != null) {
                showTokenDialog(token);
            } else {
                Toast.makeText(this, R.string.crm_token_missing, Toast.LENGTH_SHORT).show();
            }
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    /** Make sure the bot is running, then wait for it to answer. */
    private void ensureBotRunning() {
        if (mDestroyed || mTermuxService == null) return;

        File botDir = new File(CRM_BOT_DIR);
        File marker = new File(botDir, ".installed");

        if (!marker.exists()) {
            setLoadingText(R.string.crm_first_install);
            if (!copyBotAssets()) {
                showError(getString(R.string.crm_error_copy));
                return;
            }
            mSetupRunning = true;
            showSetupProgress();
            startBotSession(SETUP_SESSION_NAME, CRM_BOT_DIR + "/setup-crm.sh");
        } else if (findBotSession() == null) {
            setLoadingText(R.string.crm_starting_bot);
            startBotSession(BOT_SESSION_NAME, CRM_BOT_DIR + "/start-crm.sh");
        } else {
            setLoadingText(R.string.crm_loading_connecting);
        }

        startPolling();
        startProgressThread();
        startProgressUpdater();
    }

    /** Retry from the error view: re-check the server and restart the bot if needed. */
    private void retry() {
        mServerUp = false;
        mBootstrapDone = false; // Next service connection must redo the bot check.
        mErrorView.setVisibility(View.GONE);
        showLoading(R.string.crm_loading_connecting);
        if (mTermuxService == null) {
            Intent serviceIntent = new Intent(this, TermuxService.class);
            startService(serviceIntent);
            mBound = bindService(serviceIntent, this, Context.BIND_AUTO_CREATE);
            return;
        }
        ensureBotRunning();
    }

    /** Kill the bot session (if any) and start it again. */
    private void restartBot() {
        mServerUp = false;
        TermuxSession botSession = findBotSession();
        if (botSession != null && mTermuxService != null) {
            mTermuxService.removeTermuxSession(botSession.getTerminalSession());
        }
        showLoading(R.string.crm_starting_bot);
        if (mTermuxService != null) {
            // Forced: removeTermuxSession only asks the session to finish; it leaves
            // the service list asynchronously, so the existence check would find the
            // dying session and refuse to start a new one.
            startBotSession(BOT_SESSION_NAME, CRM_BOT_DIR + "/start-crm.sh", true);
            startPolling();
        }
    }

    private void openTerminal() {
        startActivity(new Intent(this, TermuxActivity.class));
    }

    /** Find the running bot session ("crm-bot" or "crm-setup" during first install). */
    private TermuxSession findBotSession() {
        if (mTermuxService == null) return null;
        // getTermuxSessions() returns the live list; snapshot it: a session can exit
        // (and remove itself) on another thread while we iterate.
        List<TermuxSession> sessions = new ArrayList<>(mTermuxService.getTermuxSessions());
        for (TermuxSession session : sessions) {
            if (session == null) continue;
            TerminalSession terminalSession = session.getTerminalSession();
            if (terminalSession == null) continue;
            String name = terminalSession.mSessionName;
            if (BOT_SESSION_NAME.equals(name) || SETUP_SESSION_NAME.equals(name)) return session;
        }
        return null;
    }

    /** Start the bot (or its first-run setup) in a background terminal session. */
    private void startBotSession(String sessionName, String scriptPath) {
        startBotSession(sessionName, scriptPath, false);
    }

    private void startBotSession(String sessionName, String scriptPath, boolean force) {
        if (mTermuxService == null) return;
        if (!force && findBotSession() != null) return;
        File script = new File(scriptPath);
        if (!script.exists()) {
            Logger.logError(LOG_TAG, "Bot script not found: " + scriptPath);
            showError(getString(R.string.crm_error_copy));
            return;
        }
        if (!script.canExecute()) script.setExecutable(true);
        // Drop a stale .port so the poll never talks to the previous bot's port.
        // (Skipped above when a bot session is already running.)
        new File(PORT_FILE).delete();
        TermuxSession session = mTermuxService.createTermuxSession(scriptPath, null, null, CRM_BOT_DIR, false, sessionName);
        // Start the process NOW: creating a session does not start it. The shell
        // is only forked when something sets the terminal size (updateSize ->
        // initializeEmulator -> JNI.createSubprocess), and that normally happens
        // when a terminal view attaches to the session. Without this call the
        // session exists but nothing runs until the user opens the Terminal —
        // that is why the setup (and its progress bar) only advanced after
        // opening the Terminal. 80x24 is the standard headless size; opening
        // the Terminal later just resizes it (updateSize handles that case).
        if (session != null && session.getTerminalSession() != null) {
            session.getTerminalSession().updateSize(80, 24, 0, 0);
        }
    }

    /** Port the bot is really listening on (.port), or the preferred 3000 if not written yet (old bot). */
    private int readBotPort() {
        try (BufferedReader reader = new BufferedReader(new FileReader(PORT_FILE))) {
            String line = reader.readLine();
            if (line != null) {
                int port = Integer.parseInt(line.trim());
                if (port > 0 && port < 65536) return port;
            }
        } catch (IOException | NumberFormatException e) {
            // Not written yet (bot still starting) or old bot without .port.
        }
        return DEFAULT_PORT;
    }

    private String getServerUrl() {
        return "http://127.0.0.1:" + readBotPort();
    }

    /** Is anything listening on the bot's port? A raw TCP connect: no HTTP, no proxy, no DNS. */
    private boolean isServerUp() {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", readBotPort()), 1000);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /** Dedicated progress reader: it only reads ~/.crm-setup.progress and posts it to the bar.
     *  It runs on its own thread on purpose — the server check must never be able to stall the bar.
     *  setup-crm.sh writes progress during the first install, and start-crm.sh only when it has
     *  to repair something (broken Node, missing git/deps/.env). */
    private void startProgressThread() {
        if (mProgressThread != null && mProgressThread.isAlive()) return;
        mProgressThread = new Thread(() -> {
            while (!mDestroyed && !mServerUp) {
                readSetupProgress();
                try {
                    Thread.sleep(500);
                } catch (InterruptedException e) {
                    break;
                }
            }
        }, "crm-progress");
        mProgressThread.start();
    }

    private void stopProgressThread() {
        if (mProgressThread != null) mProgressThread.interrupt();
    }

    /** Poll the bot's port until something answers, then show the panel (or the error on timeout). */
    private void startPolling() {
        if (mPollThread != null && mPollThread.isAlive()) return;
        mPollThread = new Thread(() -> {
            long deadline = System.currentTimeMillis() + (mSetupRunning ? SETUP_TIMEOUT_MS : START_TIMEOUT_MS);
            while (!mDestroyed && !mServerUp) {
                if (isServerUp()) {
                    mServerUp = true;
                    break;
                }
                if (System.currentTimeMillis() > deadline) break;
                try {
                    Thread.sleep(POLL_INTERVAL_MS);
                } catch (InterruptedException e) {
                    break;
                }
            }
            // The server answered (panel) or we gave up (error): the bar is done.
            stopProgressThread();
            stopProgressUpdater();
            if (mDestroyed) return;
            runOnUiThread(() -> {
                if (mServerUp) {
                    showPanel();
                } else {
                    showError(getString(R.string.crm_error_server_down));
                }
            });
        }, "crm-poll");
        mPollThread.start();
    }

    private void showPanel() {
        mLoadingView.setVisibility(View.GONE);
        mErrorView.setVisibility(View.GONE);
        mWebView.setVisibility(View.VISIBLE);
        if (mWebView.getUrl() == null) {
            mWebView.loadUrl(getServerUrl() + "/");
        } else {
            mWebView.reload();
        }
        // First time a new token is seen, show it with a copy button so the
        // user can paste it when the panel asks for it.
        maybeShowTokenDialog();
    }

    private void showLoading(int textResId) {
        mErrorView.setVisibility(View.GONE);
        mWebView.setVisibility(View.GONE);
        mLoadingView.setVisibility(View.VISIBLE);
        // The bar only belongs to the first-run setup; other waits show text only.
        if (mSetupProgress != null) mSetupProgress.setVisibility(View.GONE);
        if (mSetupPercent != null) mSetupPercent.setVisibility(View.GONE);
        setLoadingText(textResId);
    }

    /** Show the determinate progress bar for the first-run setup (0%). */
    private void showSetupProgress() {
        mLastSetupProgress = -1;
        mLastSetupStep = null;
        if (mSetupProgress != null) {
            mSetupProgress.setProgress(0);
            // Animated stripes until the first real value arrives: a dead 0%
            // looks like a frozen install, and the script needs a few seconds
            // to spawn and write its first progress line.
            mSetupProgress.setIndeterminate(true);
            mSetupProgress.setVisibility(View.VISIBLE);
        }
        if (mSetupPercent != null) {
            mSetupPercent.setText("0%");
            mSetupPercent.setVisibility(View.VISIBLE);
        }
    }

    /**
     * Read the progress file written by setup-crm.sh ("0-100|step text") and
     * update the bar, the percentage and the step text. A missing or malformed
     * file just keeps the previous values: the script writes it a few seconds
     * after starting, and the server poll is what decides when setup is done.
     */
    private void readSetupProgress() {
        String line;
        try (BufferedReader reader = new BufferedReader(new FileReader(SETUP_PROGRESS_FILE))) {
            line = reader.readLine();
        } catch (IOException e) {
            return;
        }
        if (line == null) return;
        int sep = line.indexOf('|');
        if (sep < 0) return;
        int percent;
        try {
            percent = Integer.parseInt(line.substring(0, sep).trim());
        } catch (NumberFormatException e) {
            return;
        }
        String step = line.substring(sep + 1).trim();
        if (percent == mLastSetupProgress && step.equals(mLastSetupStep)) return;
        mLastSetupProgress = percent;
        mLastSetupStep = step;
        final int pct = Math.max(0, Math.min(100, percent));
        runOnUiThread(() -> {
            if (mSetupProgress != null) {
                // A repair during a normal start shows the bar too.
                if (mSetupProgress.getVisibility() != View.VISIBLE && pct < 100) {
                    mSetupProgress.setVisibility(View.VISIBLE);
                    if (mSetupPercent != null) mSetupPercent.setVisibility(View.VISIBLE);
                }
                // First real value: stop the animated stripes, show the number.
                if (mSetupProgress.isIndeterminate()) mSetupProgress.setIndeterminate(false);
                mSetupProgress.setProgress(pct);
            }
            if (mSetupPercent != null) mSetupPercent.setText(pct + "%");
            if (mLoadingText != null && !step.isEmpty()) mLoadingText.setText(step);
        });
    }

    /** Read API_TOKEN from ~/crm-bot/.env (null if missing or empty). */
    private String readApiToken() {
        try (BufferedReader reader = new BufferedReader(new FileReader(ENV_FILE))) {
            String line;
            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (line.startsWith("API_TOKEN=")) {
                    String token = line.substring("API_TOKEN=".length()).trim();
                    return token.isEmpty() ? null : token;
                }
            }
        } catch (IOException e) {
            return null;
        }
        return null;
    }

    /**
     * Show the panel token in a dialog with a copy button, the first time a
     * new token is seen (fresh install, self-heal that created a new .env, or
     * a restored .env with another token). The menu entry "Token del panel"
     * shows it again on demand.
     */
    private void maybeShowTokenDialog() {
        String token = readApiToken();
        if (token == null) return;
        SharedPreferences prefs = getSharedPreferences(TOKEN_PREFS, MODE_PRIVATE);
        if (token.equals(prefs.getString(TOKEN_SHOWN_KEY, ""))) return;
        prefs.edit().putString(TOKEN_SHOWN_KEY, token).apply();
        showTokenDialog(token);
    }

    private void showTokenDialog(String token) {
        View dialogView = LayoutInflater.from(this).inflate(R.layout.dialog_token, null);
        TextView tokenView = dialogView.findViewById(R.id.crm_token_value);
        tokenView.setText(token);
        ImageButton copyButton = dialogView.findViewById(R.id.crm_token_copy);
        copyButton.setOnClickListener(v -> {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard != null) {
                clipboard.setPrimaryClip(ClipData.newPlainText("API Token", token));
                Toast.makeText(CrmActivity.this, R.string.crm_token_copied, Toast.LENGTH_SHORT).show();
            }
        });
        new AlertDialog.Builder(this)
                .setTitle(R.string.crm_token_title)
                .setView(dialogView)
                .setNegativeButton(R.string.crm_token_close, null)
                .show();
    }

    private void setLoadingText(int textResId) {
        if (mLoadingText != null) mLoadingText.setText(textResId);
    }

    private void showError(String message) {
        mLoadingView.setVisibility(View.GONE);
        mWebView.setVisibility(View.GONE);
        mErrorText.setText(message);
        mErrorView.setVisibility(View.VISIBLE);
    }

    /**
     * Copy the bot from assets/crm-bot to $HOME/crm-bot.
     * Files that already exist are NOT overwritten: if Hugo migrated his own bot
     * (with its data/ and .env), the fork keeps his files and only adds the missing
     * ones (setup-crm.sh, start-crm.sh, …).
     */
    private boolean copyBotAssets() {
        try {
            File botDir = new File(CRM_BOT_DIR);
            if (!botDir.exists() && !botDir.mkdirs()) return false;
            copyAssetPath("crm-bot", botDir);
            for (String script : new String[]{"setup-crm.sh", "start-crm.sh"}) {
                File scriptFile = new File(botDir, script);
                if (scriptFile.exists()) scriptFile.setExecutable(true);
            }
            return true;
        } catch (IOException e) {
            Logger.logError(LOG_TAG, "copyBotAssets failed: " + e.getMessage());
            return false;
        }
    }

    private void copyAssetPath(String assetPath, File dest) throws IOException {
        AssetManager assets = getAssets();
        String[] list = assets.list(assetPath);
        if (list != null && list.length > 0) {
            if (!dest.exists()) dest.mkdirs();
            for (String name : list) {
                copyAssetPath(assetPath + "/" + name, new File(dest, name));
            }
        } else {
            if (dest.exists()) return; // Never overwrite the user's bot files.
            try (InputStream in = assets.open(assetPath);
                 OutputStream out = new FileOutputStream(dest)) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            }
        }
    }
}
