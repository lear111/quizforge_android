package cloud.treenewbee.quizforge.android;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Matrix;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.AtomicFile;
import android.view.View;
import android.view.ViewGroup;
import android.view.Gravity;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.exifinterface.media.ExifInterface;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Offline tablet host. Only the bundled main document can call the native API. */
public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String HOME = ORIGIN + "/assets/web/index.html";
    private static final int IMPORT_REQUEST = 701;
    private static final int IMAGE_REQUEST = 702;
    private static final int EXPORT_REQUEST = 703;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    private final ExecutorService modelNetwork = Executors.newSingleThreadExecutor();
    private LinearLayout container;
    private WebView browser;
    private TextView loadingHint;
    private BankRepository repository;
    private RuleRuntime rules;
    private AppDocumentStore documents;
    private HubImportClient hubClient;
    private AiGateway ai;
    private AnswerAreaRenderer answerAreaRenderer;
    private CancellationSignal hubCancellation;
    private AlertDialog hubDialog;
    private Exception initializationError;
    private Exception aiInitializationError;
    private PendingReply importReply;
    private PendingReply exportReply;
    private JSONObject exportArguments;
    private String exportFilename;
    private volatile boolean storageMaintenance;
    private volatile long storageGeneration;
    private volatile boolean modelRequestBusy;
    private ValueCallback<Uri[]> imageReply;
    private Uri cameraImage;
    private boolean destroyed;
    private boolean launchIntentConsumed;
    private String backTicket;
    private FrameLayout fullscreenOverlay;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private WebView fullscreenBrowser;
    private int previousSystemUi;
    private int previousFullscreenFlag;
    private int previousVisibleBars;
    private int previousBarsBehavior;
    private int previousBrowserVisibility;
    private int previousContainerVisibility;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.WHITE);
        getWindow().setNavigationBarColor(Color.WHITE);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setBackgroundColor(Color.WHITE);
        container.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets contentInsets = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                view.setPadding(contentInsets.left, contentInsets.top, contentInsets.right, contentInsets.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(container);
        hubClient = new HubImportClient(getApplicationContext());
        answerAreaRenderer = new AnswerAreaRenderer(getApplicationContext());
        work.execute(() -> {
            try {
                rules = new RuleRuntime(getApplicationContext());
                repository = new BankRepository(getApplicationContext());
                documents = new AppDocumentStore(getApplicationContext());
                repository.setImportValidator((extension, questions) -> rules.run(extension,
                        new JSONObject().put("op", "validateBank").put("questions", questions)));
                try { ai = new AiGateway(getApplicationContext(), (bankId, assetId) -> repository.getResource(bankId, assetId)); }
                catch (Exception exception) { aiInitializationError = exception; }
            } catch (Exception exception) { initializationError = exception; }
        });
        openBrowser();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void openBrowser() {
        if (destroyed) return;
        hideFullscreen();
        container.removeAllViews();
        loadingHint = new TextView(this);
        loadingHint.setText("正在打开本地题库…");
        loadingHint.setTextSize(16);
        loadingHint.setTextColor(Color.rgb(86, 102, 118));
        loadingHint.setGravity(Gravity.CENTER);
        int loadingPadding = Math.round(18 * getResources().getDisplayMetrics().density);
        loadingHint.setPadding(loadingPadding, loadingPadding, loadingPadding, loadingPadding);
        container.addView(loadingHint, new LinearLayout.LayoutParams(-1, -2));
        browser = new WebView(this);
        browser.setBackgroundColor(Color.WHITE);
        browser.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        WebSettings settings = browser.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING))
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK))
            WebSettingsCompat.setForceDark(settings, WebSettingsCompat.FORCE_DARK_OFF);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        WebViewAssetLoader.AssetsPathHandler packagedAssets = new WebViewAssetLoader.AssetsPathHandler(this);
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", path -> path.startsWith("web/")
                        ? packagedAssets.handle(path) : bundledWebAsset("assets/" + path))
                .addPathHandler("/", this::bundledWebAsset).build();
        browser.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!trustedAsset(request.getUrl())) return refused(403, "Forbidden");
                WebResourceResponse result = assets.shouldInterceptRequest(request.getUrl());
                return result == null ? refused(404, "Not Found") : result;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !trustedAsset(request.getUrl());
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (view == browser && HOME.equals(url)) hideLoadingHint();
                if (view == browser && !launchIntentConsumed && HOME.equals(url)) {
                    launchIntentConsumed = true;
                    Uri uri = getIntent() == null ? null : getIntent().getData();
                    if (uri != null) incomingUri(uri);
                }
            }
            @Override public void onPageCommitVisible(WebView view, String url) {
                if (view == browser && trustedAsset(Uri.parse(url))) hideLoadingHint();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && !destroyed) showBrowserFailure("应用页面加载失败。已保存的题库和练习记录仍在本机。", false);
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                hideFullscreen();
                if (view == browser) browser = null;
                container.removeView(view); view.destroy();
                if (!destroyed) showBrowserFailure("显示进程已停止。重新打开后会恢复已经确认保存的答案和笔迹。", true);
                return true;
            }
        });
        browser.setWebChromeClient(new WebChromeClient() {
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                showFullscreen(view, callback);
            }
            @Override public void onHideCustomView() { hideFullscreen(); }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> reply, FileChooserParams parameters) {
                chooseImage(reply, parameters.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                return true;
            }
        });
        container.addView(browser, new LinearLayout.LayoutParams(-1, 0, 1f));
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(browser, "qfNative", Collections.singleton(ORIGIN),
                    (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                        if (!isMainFrame || !trustedOrigin(sourceOrigin) || view != browser || destroyed) return;
                        receive(message, replyProxy);
                    });
            browser.loadUrl(HOME);
        } else {
            showBrowserFailure("当前系统 WebView 不支持安全的本地接口，请更新 Android System WebView 后重新打开。", true);
        }
    }

    private void hideLoadingHint() {
        if (loadingHint != null) { container.removeView(loadingHint); loadingHint = null; }
    }

    /** Host the real HTML Fullscreen API, keeping the existing WebView alive. */
    private void showFullscreen(View content, WebChromeClient.CustomViewCallback callback) {
        if (destroyed || browser == null || fullscreenOverlay != null || content.getParent() != null) {
            callback.onCustomViewHidden();
            return;
        }
        View decor = getWindow().getDecorView();
        previousSystemUi = decor.getSystemUiVisibility();
        previousFullscreenFlag = getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_FULLSCREEN;
        previousBrowserVisibility = browser.getVisibility();
        previousContainerVisibility = container.getVisibility();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsets insets = decor.getRootWindowInsets();
            previousVisibleBars = 0;
            for (int type : new int[]{WindowInsets.Type.statusBars(), WindowInsets.Type.navigationBars(), WindowInsets.Type.captionBar()})
                if (insets == null || insets.isVisible(type)) previousVisibleBars |= type;
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) previousBarsBehavior = controller.getSystemBarsBehavior();
        }
        fullscreenBrowser = browser;
        fullscreenCallback = callback;
        fullscreenOverlay = new FrameLayout(this);
        fullscreenOverlay.setBackgroundColor(Color.WHITE);
        fullscreenOverlay.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                // System bars may be revealed transiently. Keep the document
                // immersive, while the IME/cutout/caption still protect input.
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.ime()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.captionBar());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        fullscreenOverlay.addView(content, new FrameLayout.LayoutParams(-1, -1));
        ((ViewGroup) decor).addView(fullscreenOverlay, new ViewGroup.LayoutParams(-1, -1));
        browser.setVisibility(View.INVISIBLE);
        container.setVisibility(View.INVISIBLE);
        applyFullscreenBars();
        fullscreenOverlay.requestApplyInsets();
    }

    private void applyFullscreenBars() {
        if (fullscreenOverlay == null) return;
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsets.Type.systemBars());
            }
        } else getWindow().getDecorView().setSystemUiVisibility(previousSystemUi
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    private void hideFullscreen() {
        if (fullscreenOverlay == null) return;
        FrameLayout overlay = fullscreenOverlay;
        WebChromeClient.CustomViewCallback callback = fullscreenCallback;
        WebView owner = fullscreenBrowser;
        // Clear ownership first: the callback can synchronously reenter onHide.
        fullscreenOverlay = null; fullscreenCallback = null; fullscreenBrowser = null;
        if (overlay.getParent() instanceof ViewGroup) ((ViewGroup) overlay.getParent()).removeView(overlay);
        overlay.removeAllViews();
        if (owner != null) owner.setVisibility(previousBrowserVisibility);
        container.setVisibility(previousContainerVisibility);
        getWindow().setFlags(previousFullscreenFlag, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().getDecorView().setSystemUiVisibility(previousSystemUi);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsBehavior(previousBarsBehavior);
                controller.show(previousVisibleBars);
                controller.hide(WindowInsets.Type.systemBars() & ~previousVisibleBars);
            }
        }
        container.requestApplyInsets();
        if (callback != null) try { callback.onCustomViewHidden(); } catch (RuntimeException ignored) { }
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyFullscreenBars();
    }

    private static boolean trustedOrigin(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost())
                && uri.getPort() == -1 && uri.getUserInfo() == null;
    }
    private static boolean trustedAsset(Uri uri) {
        return trustedOrigin(uri) && uri.getPath() != null && !uri.getPath().startsWith("/api/");
    }
    /** Serve the Web project's unchanged absolute static URLs from APK assets. */
    private WebResourceResponse bundledWebAsset(String path) {
        if (path == null || path.isEmpty() || path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0)
            return refused(404, "Not Found");
        for (String part : path.split("/")) if (part.equals(".") || part.equals("..")) return refused(403, "Forbidden");
        String asset = path.equals("app.js") ? "web/android-app.js"
                : path.startsWith("shared/answer-area/") || path.startsWith("shared/ink/")
                    || path.startsWith("shared/richtext/") ? "web/vendor/" + path : "web/vendor/web/" + path;
        String lower = path.toLowerCase(Locale.ROOT);
        String mime = lower.endsWith(".js") ? "application/javascript" : lower.endsWith(".css") ? "text/css"
                : lower.endsWith(".svg") ? "image/svg+xml" : lower.endsWith(".png") ? "image/png"
                : lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg" : lower.endsWith(".webp") ? "image/webp"
                : lower.endsWith(".ico") ? "image/x-icon" : lower.endsWith(".woff2") ? "font/woff2"
                : lower.endsWith(".json") || lower.endsWith(".webmanifest") ? "application/json"
                : lower.endsWith(".html") ? "text/html" : "application/octet-stream";
        try {
            return new WebResourceResponse(mime, "UTF-8", 200, "OK",
                    Collections.singletonMap("Cache-Control", "no-store"), getAssets().open(asset));
        } catch (java.io.IOException exception) { return refused(404, "Not Found"); }
    }
    private static WebResourceResponse refused(int status, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", status, reason,
                Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(new byte[0]));
    }

    private void receive(WebMessageCompat message, JavaScriptReplyProxy proxy) {
        PendingReply reply = null;
        try {
            String source = message.getData();
            if (source == null || source.length() > 40 * 1024 * 1024) throw new StorageException("REQUEST_TOO_LARGE", "本地操作数据超过大小上限");
            JSONObject envelope = new JSONObject(source);
            String id = envelope.getString("id"), method = envelope.getString("method");
            if (!id.matches("[A-Za-z0-9_.:-]{1,96}") || method.length() > 64) throw new StorageException("INVALID_REQUEST", "本地请求格式无效");
            JSONObject args = envelope.optJSONObject("args");
            if (args == null) args = new JSONObject();
            reply = new PendingReply(id, proxy);
            if (storageMaintenance) { reply.failure(new StorageException("STORAGE_MAINTENANCE", "正在恢复本地备份，请稍候")); return; }
            if (method.equals("system.finish")) {
                if (backTicket != null && backTicket.equals(args.optString("ticket"))) { backTicket = null; finish(); }
                return;
            }
            if (method.equals("system.backFailed")) {
                if (backTicket != null && backTicket.equals(args.optString("ticket"))) {
                    backTicket = null; toast("仍有内容未确认保存，请留在当前页面重试");
                }
                return;
            }
            if (method.equals("import.pick")) { chooseImport(reply); return; }
            if (method.equals("library.export")) { chooseExport(args, reply); return; }
            if (method.equals("hub.open")) { openHub(reply); return; }
            PendingReply response = reply;
            JSONObject arguments = args;
            if (method.equals("settings.ai.test") || method.equals("ai.request")) {
                if (modelRequestBusy) { response.failure(new StorageException("AI_BUSY", "模型正在处理上一项请求，请等待完成后重试")); return; }
                modelRequestBusy = true;
                // Preserve storage responsiveness while the configured model is
                // processing. Credentials never pass through a WebView fetch.
                long generation = storageGeneration;
                work.execute(() -> {
                    final AiGateway owner = ai;
                    if (generation != storageGeneration || storageMaintenance) { modelRequestBusy = false;response.failure(new StorageException("AI_INTERRUPTED", "本地数据正在恢复，旧 AI 请求已停止")); return; }
                    modelNetwork.execute(() -> {
                    try {
                        if (initializationError != null) throw initializationError;
                        if (owner == null) throw new StorageException("AI_UNAVAILABLE", "AI 服务尚未就绪");
                        if (generation != storageGeneration || storageMaintenance) throw new StorageException("AI_INTERRUPTED", "本地数据已恢复，旧 AI 请求已停止");
                        response.success(method.equals("settings.ai.test") ? owner.testConnection() : owner.generate(arguments));
                    } catch (Exception exception) { response.failure(exception); }
                    finally { modelRequestBusy = false; }
                });});
                return;
            }
            work.execute(() -> {
                try { response.success(dispatch(method, arguments)); }
                catch (Exception exception) { response.failure(exception); }
            });
        } catch (Exception exception) { if (reply != null) reply.failure(exception); }
    }

    private Object dispatch(String method, JSONObject args) throws Exception {
        if (method.equals("system.info")) {
            JSONObject info = rules == null ? new JSONObject().put("sandboxSupported", false) : rules.information();
            PackageInfo webView = WebViewCompat.getCurrentWebViewPackage(getApplicationContext());
            return info.put("webViewVersion", webView == null ? "unknown" : webView.versionName)
                    .put("androidVersion", Build.VERSION.RELEASE).put("androidApi", Build.VERSION.SDK_INT)
                    .put("offline", true).put("extensionApi", new JSONObject().put("major", 1).put("minor", 5));
        }
        if (initializationError != null) throw initializationError;
        if (repository == null || rules == null) throw new StorageException("STORAGE_UNAVAILABLE", "本地存储尚未就绪，请重新打开应用");
        switch (method) {
            case "answerArea.begin": return answerAreaRenderer.begin(args);
            case "answerArea.image": return answerAreaRenderer.addImage(args);
            case "answerArea.render": return answerAreaRenderer.render(args);
            case "answerArea.discard": return answerAreaRenderer.discard(args);
            case "library.list": ensureDemo(); return repository.listBanks();
            case "library.catalog": ensureDemo(); return repository.libraryCatalog();
            case "library.change": return repository.changeLibrary(args);
            case "library.trash": return repository.listTrash();
            case "library.restore": return repository.restoreTrash(args.getString("trashId"));
            case "library.readBank": return repository.readBank(args.getString("bankId"));
            case "library.readExtension": return repository.readExtension(args.getString("bankId"), args.getString("path"));
            case "editor.read": return repository.readEditor(args.getString("bankId"), args.getString("questionId"));
            case "editor.save": return repository.editQuestion(args.getString("bankId"), args.getString("questionId"), editorArguments(args));
            case "editorDraft.read":
            case "editor.draft.read": return repository.readEditorDraft(args.getString("bankId"), args.getString("questionId"));
            case "editorDraft.write":
            case "editor.draft.put": return repository.putEditorDraft(args.getString("bankId"), args.getString("questionId"), editorArguments(args));
            case "editorDraft.delete":
            case "editor.draft.delete": return repository.deleteEditorDraft(args.getString("bankId"), args.getString("questionId"));
            case "state.read": { JSONObject value = repository.readState(args.getString("bankId")); return value == null ? JSONObject.NULL : value; }
            case "state.write": return repository.writeState(args.getString("bankId"), args.getJSONObject("state"), args.getLong("expectedRevision"));
            case "resource.put": return args.optBoolean("editing", false)
                    ? repository.putEditorResource(args.getString("bankId"), args.getString("mime"), args.getString("data"))
                    : repository.putResource(args.getString("bankId"), args.getString("mime"), args.getString("data"));
            case "resource.get": return repository.getResource(args.getString("bankId"), args.getString("id"));
            case "rules.run": return rules.run(repository.readExtension(args.getString("bankId"), args.getString("path")), args.getJSONObject("request"));
            case "rules.evaluate": return rules.run(args.getJSONObject("extension"), args.getJSONObject("request"));
            case "documents.read": { JSONObject value = documents.read(args.getString("namespace"), args.getString("key")); return value == null ? JSONObject.NULL : value; }
            case "documents.write": return documents.write(args.getString("namespace"), args.getString("key"), args.getJSONObject("value"), args.getLong("expectedRevision"));
            case "documents.list": return documents.list(args.getString("namespace"));
            case "system.time": return System.currentTimeMillis();
            case "settings.ai.get":
                if (ai == null) throw new StorageException("AI_UNAVAILABLE", "AI 设置暂时无法读取，本地刷题仍可使用");
                return ai.status();
            case "settings.ai.update":
                if (ai == null) throw new StorageException("AI_UNAVAILABLE", "AI 设置暂时无法保存，本地刷题仍可使用");
                return ai.update(args.getJSONObject("profile"));
            case "hub.account": return new JSONObject().put("mode", "browser").put("connected", false)
                    .put("hubUrl", HubImportClient.LIBRARY_URL);
            default: throw new StorageException("ACTION_UNAVAILABLE", "当前离线版本未提供此操作");
        }
    }

    private static JSONObject editorArguments(JSONObject args) throws JSONException {
        JSONObject request = new JSONObject(args.toString());request.remove("bankId");request.remove("questionId");return request;
    }

    private void ensureDemo() throws Exception {
        File marker = new File(getFilesDir(), "initial-demo.json");
        AtomicFile atomic = new AtomicFile(marker);
        if (marker.exists() || new File(marker.getPath() + ".bak").exists()) {
            try (InputStream input = atomic.openRead()) {
                ByteArrayOutputStream collected = new ByteArrayOutputStream(); byte[] block = new byte[1024]; int read;
                while ((read = input.read(block)) != -1) {
                    if (collected.size() + read > 4096) throw new StorageException("STORAGE_CORRUPT", "首次初始化记录异常，已保留原文件");
                    collected.write(block, 0, read);
                }
                byte[] bytes = collected.toByteArray();
                if (new JSONObject(new String(bytes, StandardCharsets.UTF_8)).optInt("schemaVersion", 0) != 1)
                    throw new StorageException("STORAGE_CORRUPT", "首次初始化记录异常，已保留原文件");
            }
            return;
        }
        String status = "skipped";
        if (repository.listBanks().length() == 0) {
            try (InputStream input = getAssets().open("demo.qbank")) { repository.importPackage(input, "基础题型体验.qbank"); }
            status = "installed";
        }
        byte[] bytes = new JSONObject().put("schemaVersion", 1).put("status", status).toString().getBytes(StandardCharsets.UTF_8);
        FileOutputStream output = null;
        try { output = atomic.startWrite(); output.write(bytes); output.getFD().sync(); atomic.finishWrite(output); }
        catch (Exception exception) { if (output != null) atomic.failWrite(output); throw exception; }
    }

    private void chooseImport(PendingReply reply) {
        if (exportReply != null) { reply.failure(new StorageException("IMPORT_BUSY", "请先完成当前导出")); return; }
        if (importReply != null) { reply.failure(new StorageException("IMPORT_BUSY", "请先完成当前题库文件选择")); return; }
        importReply = reply;
        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        try { startActivityForResult(picker, IMPORT_REQUEST); }
        catch (ActivityNotFoundException exception) { importReply = null; reply.failure(new StorageException("PICKER_UNAVAILABLE", "系统没有可用的文件选择器")); }
    }

    private void chooseExport(JSONObject args, PendingReply reply) {
        if (importReply != null) { reply.failure(new StorageException("EXPORT_BUSY", "请先完成当前导入")); return; }
        if (exportReply != null) { reply.failure(new StorageException("EXPORT_BUSY", "请先完成当前导出")); return; }
        exportReply = reply;
        exportArguments = args;
        work.execute(() -> {
            try {
                if (initializationError != null) throw initializationError;
                exportFilename = repository.exportName(args.optString("bankId", null), args.optString("group", null));
                main.post(() -> {
                    if (destroyed) return;
                    Intent picker = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                            .setType("application/vnd.quizforge.qbank").putExtra(Intent.EXTRA_TITLE, exportFilename);
                    try { startActivityForResult(picker, EXPORT_REQUEST); }
                    catch (ActivityNotFoundException exception) { failExport(new StorageException("PICKER_UNAVAILABLE", "系统没有可用的文件保存位置选择器")); }
                });
            } catch (Exception exception) { main.post(() -> failExport(exception)); }
        });
    }

    private void failExport(Exception exception) {
        PendingReply reply = exportReply; exportReply = null; exportArguments = null; exportFilename = null;
        if (reply != null) reply.failure(exception);
    }

    private void openHub(PendingReply reply) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(HubImportClient.LIBRARY_URL))
                    .addCategory(Intent.CATEGORY_BROWSABLE));
            reply.success(new JSONObject().put("opened", true));
        } catch (ActivityNotFoundException exception) { reply.failure(new StorageException("BROWSER_UNAVAILABLE", "请先安装浏览器，再打开题库广场")); }
        catch (Exception exception) { reply.failure(exception); }
    }

    private void incomingUri(Uri uri) {
        if ("quizforge".equals(uri.getScheme())) beginHubImport(uri.toString());
        else importUri(uri, null);
    }

    private void beginHubImport(String link) {
        final HubImportClient.ImportRequest request;
        try { request = HubImportClient.parse(link); }
        catch (Exception exception) { showNativeNotice(publicMessage(exception)); return; }
        if (hubCancellation != null) { toast("正在导入题库，请稍候"); return; }
        CancellationSignal cancellation = new CancellationSignal(); hubCancellation = cancellation;
        long generation = storageGeneration;
        hubDialog = new AlertDialog.Builder(this).setTitle("从题库广场导入")
                .setMessage("正在获取题库信息…").setNegativeButton("取消", (dialog, which) -> cancellation.cancel()).create();
        hubDialog.setOnCancelListener(dialog -> cancellation.cancel());hubDialog.show();
        // Catalog reads/import commits stay on the storage queue; network I/O
        // has its own executor so saving the open question remains responsive.
        work.execute(() -> {
            try {
                if (initializationError != null) throw initializationError;
                JSONObject prior = documents.read("hub-import", request.packId + "_" + request.revision);
                if (prior != null) {
                    JSONArray ids = prior.optJSONArray("banks"); JSONArray existing = repository.listBanks();
                    for (int i = 0; ids != null && i < ids.length(); i++) for (int j = 0; j < existing.length(); j++) {
                        JSONObject bank = existing.getJSONObject(j);
                        if (ids.getString(i).equals(bank.getString("id"))) {
                            main.post(() -> { finishHubImport(); announceImported(bank); }); return;
                        }
                    }
                }
                downloads.execute(() -> downloadHub(request, cancellation, generation));
            } catch (Exception exception) { main.post(() -> { finishHubImport(); showNativeNotice(publicMessage(exception)); }); }
        });
    }

    private void downloadHub(HubImportClient.ImportRequest request, CancellationSignal cancellation, long generation) {
        try {
            HubImportClient.DownloadedPackage downloaded = hubClient.download(request, cancellation,
                    (stage, received, total, name) -> main.post(() -> {
                        if (hubDialog == null || destroyed) return;
                        if (stage.equals("manifest")) hubDialog.setMessage("正在获取题库信息…");
                        else if (stage.equals("verified")) hubDialog.setMessage("下载已校验，正在检查题库与题型…");
                        else hubDialog.setMessage("正在下载「" + name + "」\n" + (total > 0 ? received * 100 / total + "%" : received / 1024 + " KiB"));
                    }));
            try { work.execute(() -> {
                try (HubImportClient.DownloadedPackage archive = downloaded) {
                    cancellation.throwIfCanceled();
                    if (storageMaintenance || generation != storageGeneration) throw new StorageException("IMPORT_INTERRUPTED", "本地数据已恢复，请重新点击题库下载入口");
                    main.post(() -> { if (hubDialog != null) { hubDialog.setCancelable(false); hubDialog.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(false); } });
                    JSONObject result;
                    try (InputStream input = archive.openStream()) { result = repository.importPackage(input, null); }
                    JSONArray banks = result.getJSONArray("banks"), ids = new JSONArray();
                    for (int i = 0; i < banks.length(); i++) ids.put(banks.getJSONObject(i).getString("id"));
                    String key = request.packId + "_" + request.revision;
                    JSONObject old = documents.read("hub-import", key);
                    documents.write("hub-import", key, new JSONObject().put("packId", request.packId).put("hubRevision", request.revision)
                            .put("sha256", archive.sha256).put("banks", ids), old == null ? 0 : old.getLong("revision"));
                    main.post(() -> { finishHubImport(); if (banks.length() > 0) announceImported(banks.optJSONObject(0)); else showNativeNotice("题库包已导入，请查看我的题库。"); });
                } catch (Exception exception) { main.post(() -> { finishHubImport(); showNativeNotice(publicMessage(exception)); }); }
            }); } catch (RejectedExecutionException exception) { downloaded.close(); throw exception; }
        } catch (Exception exception) { main.post(() -> { finishHubImport(); showNativeNotice(cancellation.isCanceled() ? "已取消下载，本地题库和作答已保留。" : publicMessage(exception)); }); }
    }

    private void finishHubImport() {
        hubCancellation = null;
        if (hubDialog != null) { hubDialog.dismiss(); hubDialog = null; }
    }

    private void announceImported(JSONObject bank) {
        if (bank == null || browser == null || destroyed) return;
        browser.evaluateJavascript("window.quizforgeAndroidImported=" + bank.toString()
                + ";document.dispatchEvent(new Event('quizforge-android-imported'));", null);
    }

    private void showNativeNotice(String message) {
        toast(message);
        if (browser != null && !destroyed) browser.evaluateJavascript("window.quizforgeAndroidNotice=" + JSONObject.quote(message)
                + ";document.dispatchEvent(new Event('quizforge-android-notice'));", null);
    }

    private String displayName(Uri uri) throws Exception {
        if (uri == null || !"content".equals(uri.getScheme())) throw new StorageException("INVALID_FILE", "请从系统文件选择器打开本地 .qbank 文件");
        String result = null;
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) result = cursor.getString(0);
        }
        if (result == null || result.length() > 255 || !result.toLowerCase(Locale.ROOT).endsWith(".qbank"))
            throw new StorageException("INVALID_FILE", "请选择文件名以 .qbank 结尾的 QuizForge 题库包");
        return result;
    }

    private void importUri(Uri uri, PendingReply reply) {
        long generation = storageGeneration;
        try {
            work.execute(() -> {
                try {
                    if (initializationError != null) throw initializationError;
                    if (storageMaintenance || generation != storageGeneration) throw new StorageException("IMPORT_INTERRUPTED", "本地数据已恢复，请重新选择要导入的题库");
                    if (repository == null) throw new StorageException("STORAGE_UNAVAILABLE", "本地存储尚未就绪");
                    String filename = displayName(uri);
                    JSONObject result;
                    try (InputStream input = getContentResolver().openInputStream(uri)) { result = repository.importPackage(input, filename); }
                    if (reply != null) reply.success(result);
                    else main.post(() -> { toast("题库已导入本机"); refreshLibrary(); });
                } catch (Exception exception) {
                    if (reply != null) reply.failure(exception);
                    else main.post(() -> toast(publicMessage(exception)));
                }
            });
        } catch (RejectedExecutionException exception) { if (reply != null) reply.failure(new StorageException("PAGE_CLOSED", "应用页面已关闭")); }
    }

    private void chooseImage(ValueCallback<Uri[]> reply, boolean multiple) {
        if (imageReply != null) imageReply.onReceiveValue(null);
        imageReply = reply;
        Intent gallery = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        Intent chooser = Intent.createChooser(gallery, "添加作答图片");
        try {
            cameraImage = ImageFileProvider.createCapture(this);
            Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, cameraImage)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            camera.setClipData(ClipData.newRawUri("QuizForge拍照", cameraImage));
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{camera});
        } catch (Exception ignored) { cameraImage = null; }
        try { startActivityForResult(chooser, IMAGE_REQUEST); }
        catch (ActivityNotFoundException exception) { imageReply = null; reply.onReceiveValue(null); toast("系统没有可用的图片选择器"); }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == IMPORT_REQUEST) {
            PendingReply reply = importReply; importReply = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                if (reply != null) try { reply.success(new JSONObject().put("cancelled", true).put("banks", new JSONArray())); } catch (JSONException ignored) { }
            } else importUri(data.getData(), reply);
        } else if (requestCode == EXPORT_REQUEST) {
            PendingReply reply = exportReply; JSONObject args = exportArguments; String filename = exportFilename;
            exportReply = null; exportArguments = null; exportFilename = null;
            if (reply == null || args == null) return;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                try { reply.success(new JSONObject().put("cancelled", true)); } catch (JSONException ignored) { }
                return;
            }
            Uri destination = data.getData();
            work.execute(() -> {
                try {
                    if (!"content".equals(destination.getScheme())) throw new StorageException("INVALID_FILE", "请选择系统提供的保存位置");
                    try (OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
                        if (output == null) throw new StorageException("EXPORT_FAILED", "无法写入所选位置，请重新选择");
                        repository.exportPackage(args.optString("bankId", null), args.optString("group", null), output);
                        output.flush();
                    }
                    reply.success(new JSONObject().put("exported", true).put("filename", filename));
                } catch (Exception exception) { reply.failure(exception); }
            });
        } else if (requestCode == IMAGE_REQUEST) {
            ValueCallback<Uri[]> reply = imageReply; imageReply = null;
            Uri capture = cameraImage; cameraImage = null;
            if (capture != null) revokeUriPermission(capture, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            if (reply == null) return;
            if (resultCode != RESULT_OK) { reply.onReceiveValue(null); return; }
            ArrayList<Uri> chosen = new ArrayList<>();
            if (data != null && data.getClipData() != null) {
                ClipData clip = data.getClipData();
                for (int i = 0; i < Math.min(clip.getItemCount(), 8); i++) if ("content".equals(clip.getItemAt(i).getUri().getScheme())) chosen.add(clip.getItemAt(i).getUri());
            } else if (data != null && data.getData() != null && "content".equals(data.getData().getScheme())) chosen.add(data.getData());
            if (!chosen.isEmpty()) { reply.onReceiveValue(chosen.toArray(new Uri[0])); return; }
            if (capture == null) { reply.onReceiveValue(null); return; }
            work.execute(() -> {
                try { normalizeCapture(capture); main.post(() -> reply.onReceiveValue(new Uri[]{capture})); }
                catch (Exception exception) { main.post(() -> { reply.onReceiveValue(null); toast("拍照图片未能读取，请重新拍照或从相册选择"); }); }
            });
        }
    }

    private void normalizeCapture(Uri uri) throws Exception {
        File file = ImageFileProvider.captureFile(this, uri);
        if (file.length() <= 0 || file.length() > 20L * 1024 * 1024) throw new StorageException("IMAGE_SIZE_LIMIT", "请选择不超过 20 MiB 的图片");
        BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getPath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || (long) bounds.outWidth * bounds.outHeight > 40000000) throw new StorageException("IMAGE_SIZE_LIMIT", "图片分辨率过大，请缩小后重试");
        BitmapFactory.Options options = new BitmapFactory.Options(); options.inSampleSize = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / options.inSampleSize > 5120) options.inSampleSize *= 2;
        Bitmap image = BitmapFactory.decodeFile(file.getPath(), options);
        if (image == null) throw new Exception("Invalid camera image");
        // Cameras commonly encode sensor rotation in EXIF. Apply it before the
        // bounded copy is re-encoded so a photographed answer stays upright.
        int orientation = ExifInterface.ORIENTATION_NORMAL;
        try { orientation = new ExifInterface(file.getPath()).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL); }
        catch (Exception ignored) { }
        Matrix transform = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: transform.setScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_180: transform.setRotate(180); break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL: transform.setScale(1, -1); break;
            case ExifInterface.ORIENTATION_TRANSPOSE: transform.setRotate(90); transform.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_90: transform.setRotate(90); break;
            case ExifInterface.ORIENTATION_TRANSVERSE: transform.setRotate(270); transform.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_270: transform.setRotate(270); break;
        }
        if (!transform.isIdentity()) {
            Bitmap upright = Bitmap.createBitmap(image, 0, 0, image.getWidth(), image.getHeight(), transform, true);
            if (upright != image) { image.recycle(); image = upright; }
        }
        if (Math.max(image.getWidth(), image.getHeight()) > 2560) {
            double ratio = 2560.0 / Math.max(image.getWidth(), image.getHeight());
            Bitmap resized = Bitmap.createScaledBitmap(image, Math.max(1, (int) Math.round(image.getWidth() * ratio)), Math.max(1, (int) Math.round(image.getHeight() * ratio)), true);
            if (resized != image) { image.recycle(); image = resized; }
        }
        AtomicFile target = new AtomicFile(file); FileOutputStream output = null;
        try {
            output = target.startWrite();
            if (!image.compress(Bitmap.CompressFormat.JPEG, 88, output)) throw new Exception("Camera image encoding failed");
            output.getFD().sync(); target.finishWrite(output);
        } catch (Exception exception) { if (output != null) target.failWrite(output); throw exception; }
        finally { image.recycle(); }
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent);
        if (intent.getData() != null) incomingUri(intent.getData());
    }

    private void refreshLibrary() {
        if (browser != null && !destroyed) browser.evaluateJavascript("window.quizforgeApp?.refreshLibrary?.()", null);
    }

    @Override protected void onPause() {
        if (browser != null && !destroyed) browser.evaluateJavascript("window.quizforgeApp?.flush?.().catch(()=>{})", null);
        super.onPause();
    }

    @Override public void onBackPressed() {
        if (fullscreenOverlay != null) { hideFullscreen(); return; }
        if (browser == null) { finish(); return; }
        if (backTicket != null) { toast("正在确认保存，请稍候"); return; }
        String ticket = UUID.randomUUID().toString(); backTicket = ticket;
        String args = "{ticket:" + JSONObject.quote(ticket) + "}";
        String script = "(()=>{const done=(method)=>qfNative.postMessage(JSON.stringify({id:'native-back',method,args:" + args + "}));"
                + "Promise.resolve().then(()=>window.quizforgeApp?.flush?.()).then(()=>done('system.finish'),()=>done('system.backFailed'));})()";
        browser.evaluateJavascript(script, null);
        main.postDelayed(() -> { if (ticket.equals(backTicket)) { backTicket = null; toast("保存尚未确认，请保留当前页面后重试返回"); } }, 20000);
    }

    private void showBrowserFailure(String message, boolean retry) {
        if (destroyed) return;
        hideFullscreen();
        if (browser != null) { WebView old = browser; browser = null; container.removeView(old); old.destroy(); }
        loadingHint = null;
        container.removeAllViews();
        TextView text = new TextView(this); text.setText(message); text.setTextSize(18); text.setPadding(28, 40, 28, 28);
        container.addView(text, new LinearLayout.LayoutParams(-1, -2));
        if (retry) { Button button = new Button(this); button.setText("重新打开"); button.setOnClickListener(view -> openBrowser()); container.addView(button); }
    }

    private void toast(String message) { if (!destroyed) Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
    private static String publicMessage(Exception exception) {
        return exception instanceof StorageException ? exception.getMessage() : exception instanceof JSONException ? "本地请求格式无效" : "本地操作未完成，原有数据已保留，请重试";
    }

    private final class PendingReply {
        final String id; final JavaScriptReplyProxy proxy;
        PendingReply(String id, JavaScriptReplyProxy proxy) { this.id = id; this.proxy = proxy; }
        void success(Object data) { send(true, data, null); }
        void failure(Exception exception) {
            try { send(false, null, new JSONObject().put("code", exception instanceof StorageException ? ((StorageException) exception).code : exception instanceof JSONException ? "INVALID_REQUEST" : "LOCAL_OPERATION_FAILED")
                    .put("message", publicMessage(exception))); } catch (JSONException ignored) { }
        }
        void send(boolean ok, Object data, JSONObject error) {
            try {
                JSONObject response = new JSONObject().put("id", id).put("ok", ok);
                if (ok) response.put("data", data == null ? JSONObject.NULL : data); else response.put("error", error);
                String encoded = response.toString();
                main.post(() -> {
                    if (!destroyed && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                        try { proxy.postMessage(encoded); } catch (RuntimeException ignored) { }
                    }
                });
            } catch (JSONException ignored) { }
        }
    }

    @Override protected void onDestroy() {
        destroyed = true;
        if (hubCancellation != null) hubCancellation.cancel();
        finishHubImport();downloads.shutdown();
        if (ai != null) ai.close();modelNetwork.shutdown();
        if (answerAreaRenderer != null) answerAreaRenderer.destroy();
        hideFullscreen();
        if (imageReply != null) { imageReply.onReceiveValue(null); imageReply = null; }
        if (browser != null) { container.removeView(browser); browser.destroy(); browser = null; }
        work.execute(() -> { if (rules != null) rules.close(); });
        work.shutdown(); // Already accepted durable writes finish before executor shutdown.
        super.onDestroy();
    }
}
