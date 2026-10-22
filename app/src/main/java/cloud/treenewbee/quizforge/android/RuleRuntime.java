package cloud.treenewbee.quizforge.android;

import android.content.Context;

import androidx.javascriptengine.IsolateStartupParameters;
import androidx.javascriptengine.JavaScriptIsolate;
import androidx.javascriptengine.JavaScriptSandbox;

import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Executes one extension operation in a fresh, bounded, bridge-free JS isolate. */
public final class RuleRuntime implements AutoCloseable {
    private static final long DEADLINE_NANOS = TimeUnit.SECONDS.toNanos(8);
    private static final int MAX_INPUT = 8 * 1024 * 1024;
    private static final int MAX_OUTPUT = 2 * 1024 * 1024;
    private final Context context;
    private JavaScriptSandbox sandbox;
    private ListenableFuture<JavaScriptSandbox> pendingConnection;
    private String runtimeSource;

    public RuleRuntime(Context context) { this.context = context.getApplicationContext(); }

    public synchronized JSONObject information() throws Exception {
        JSONObject result = new JSONObject().put("sandboxSupported", false);
        try {
            JavaScriptSandbox service = connected();
            JSONArray features = new JSONArray();
            for (String feature : new String[]{JavaScriptSandbox.JS_FEATURE_ISOLATE_TERMINATION,
                    JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE,
                    JavaScriptSandbox.JS_FEATURE_EVALUATE_WITHOUT_TRANSACTION_LIMIT}) {
                if (service.isFeatureSupported(feature)) features.put(feature);
            }
            return result.put("sandboxSupported", true).put("sandboxFeatures", features);
        } catch (StorageException exception) {
            return result.put("sandboxError", exception.getMessage()).put("sandboxFeatures", new JSONArray());
        }
    }

    public synchronized JSONObject run(JSONObject extension, JSONObject supplied) throws Exception {
        JSONObject request = new JSONObject(supplied.toString());
        JSONObject manifest = extension.getJSONObject("manifest"), requirement = manifest.optJSONObject("requiresApi");
        JSONArray capabilities = requirement == null ? null : requirement.optJSONArray("capabilities");
        int minor = requirement == null ? 0 : requirement.optInt("minMinor", 0);
        request.put("apiVersion", new JSONObject().put("major", 1).put("minor", 5))
                .put("development", false)
                .put("rules", extension.getString("rules"))
                .put("questionSchema", extension.get("questionSchema"))
                .put("answerSchema", extension.get("answerSchema"))
                .put("outlineItemsDeclared", minor >= 1 && contains(capabilities, "outline-items"))
                .put("answerStateDeclared", minor >= 3 && contains(capabilities, "answer-state"));
        String input = request.toString();
        if (input.getBytes(StandardCharsets.UTF_8).length > MAX_INPUT)
            throw new StorageException("RULE_INPUT_TOO_LARGE", "题型规则输入超过 8 MiB，请缩小题库或题目");
        JavaScriptSandbox service = connected();
        IsolateStartupParameters settings = new IsolateStartupParameters();
        if (service.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE)) {
            settings.setMaxHeapSizeBytes(96L * 1024 * 1024);
        } else throw new StorageException("ENGINE_UNAVAILABLE", "当前题型执行器不支持内存限制，请更新系统 WebView");
        if (service.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_EVALUATE_WITHOUT_TRANSACTION_LIMIT)) {
            settings.setMaxEvaluationReturnSizeBytes(MAX_OUTPUT);
        } else throw new StorageException("ENGINE_UNAVAILABLE", "当前题型执行器不支持大型题目，请更新系统 WebView");
        JavaScriptIsolate isolate = null;
        long deadline = System.nanoTime() + DEADLINE_NANOS;
        try {
            if (service.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE)) {
                isolate = service.createIsolate(settings);
            } else throw new StorageException("ENGINE_UNAVAILABLE", "当前题型执行器不支持内存限制，请更新系统 WebView");
            if (runtimeSource == null) runtimeSource = readRuntime();
            isolate.evaluateJavaScriptAsync(runtimeSource + "\n'loaded'").get(remaining(deadline), TimeUnit.NANOSECONDS);
            // The request is a quoted JSON string; neither its rules nor private data
            // are interpolated as JavaScript statements. No app bridge is installed.
            String code = "JSON.stringify(QFAndroidRules.runRule(JSON.parse(" + quote(input) + ")))";
            String response = isolate.evaluateJavaScriptAsync(code).get(remaining(deadline), TimeUnit.NANOSECONDS);
            if (response.getBytes(StandardCharsets.UTF_8).length > MAX_OUTPUT)
                throw new StorageException("RULE_OUTPUT_TOO_LARGE", "题型规则输出超过大小上限");
            JSONObject envelope = new JSONObject(response);
            if (!envelope.optBoolean("ok")) {
                String detail = envelope.optString("error", "题型规则拒绝了当前数据");
                if (detail.length() > 200) detail = detail.substring(0, 200);
                throw new StorageException(envelope.optString("code", "RULE_REJECTED"), detail);
            }
            return envelope.getJSONObject("data");
        } catch (TimeoutException exception) {
            closeQuietly(isolate); isolate = null;
            close();
            throw new StorageException("RULE_TIMEOUT", "题型规则运行超时，当前答案未被覆盖，请检查题型拓展", exception);
        } catch (ExecutionException exception) {
            closeQuietly(isolate); isolate = null;
            close();
            throw new StorageException("RULE_RUNTIME_FAILED", "题型规则执行器已停止，原有题库和作答已保留，可以重试", exception);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            closeQuietly(isolate); isolate = null;
            close();
            throw new StorageException("RULE_INTERRUPTED", "题型操作已中断，原有作答已保留", exception);
        } catch (IllegalStateException exception) {
            closeQuietly(isolate); isolate = null;
            close();
            throw new StorageException("RULE_RUNTIME_FAILED", "题型执行器暂时不可用，可以重试；原有数据已保留", exception);
        } finally {
            closeQuietly(isolate);
        }
    }

    private JavaScriptSandbox connected() throws Exception {
        if (sandbox != null) return sandbox;
        try {
            if (!JavaScriptSandbox.isSupported())
                throw new StorageException("ENGINE_UNAVAILABLE", "当前 Android System WebView 不支持离线题型执行器，请更新系统 WebView 后重试");
            if (pendingConnection == null) pendingConnection = JavaScriptSandbox.createConnectedInstanceAsync(context);
            JavaScriptSandbox candidate = pendingConnection.get(8, TimeUnit.SECONDS);
            pendingConnection = null;
            for (String feature : new String[]{JavaScriptSandbox.JS_FEATURE_ISOLATE_TERMINATION,
                    JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE,
                    JavaScriptSandbox.JS_FEATURE_EVALUATE_WITHOUT_TRANSACTION_LIMIT}) {
                if (!candidate.isFeatureSupported(feature)) {
                    candidate.close();
                    throw new StorageException("ENGINE_UNAVAILABLE", "当前系统 WebView 缺少受限题型执行能力，请更新 Android System WebView 后重试");
                }
            }
            sandbox = candidate;
            return sandbox;
        } catch (StorageException exception) { throw exception; }
        catch (TimeoutException exception) {
            // Keep a slow service connection for a later retry. Cancelling an
            // in-flight bind can strand older AndroidX service bookkeeping.
            throw new StorageException("ENGINE_UNAVAILABLE", "本地题型执行器仍在启动，请稍后重试", exception);
        }
        catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new StorageException("ENGINE_UNAVAILABLE", "连接题型执行器已中断，请重新打开应用", exception);
        } catch (Exception exception) {
            pendingConnection = null;
            throw new StorageException("ENGINE_UNAVAILABLE", "无法启动本地题型执行器，请更新 Android System WebView 或重新打开应用", exception);
        }
    }

    private String readRuntime() throws Exception {
        try (InputStream input = context.getAssets().open("rules/runtime.js"); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384]; int size;
            while ((size = input.read(buffer)) != -1) {
                if (output.size() + size > 2 * 1024 * 1024) throw new StorageException("ENGINE_UNAVAILABLE", "本地规则执行器文件异常，请重新安装应用");
                output.write(buffer, 0, size);
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static long remaining(long deadline) throws TimeoutException {
        long time = deadline - System.nanoTime();
        if (time <= 0) throw new TimeoutException();
        return time;
    }

    private static boolean contains(JSONArray values, String expected) {
        if (values != null) for (int i = 0; i < values.length(); i++) if (expected.equals(values.optString(i))) return true;
        return false;
    }

    private static String quote(String value) {
        // Modern JS accepts JSON string literals; escape lone UTF-16 surrogates
        // explicitly because the sandbox transports script source as UTF-8.
        String quoted = JSONObject.quote(value); StringBuilder result = new StringBuilder(quoted.length());
        for (int i = 0; i < quoted.length(); i++) {
            char item = quoted.charAt(i);
            boolean lone = Character.isHighSurrogate(item) ? i + 1 >= quoted.length() || !Character.isLowSurrogate(quoted.charAt(i + 1))
                    : Character.isLowSurrogate(item) && (i == 0 || !Character.isHighSurrogate(quoted.charAt(i - 1)));
            if (lone || item == '\u2028' || item == '\u2029') {
                result.append("\\u");
                String hex = Integer.toHexString(item);
                for (int padding = hex.length(); padding < 4; padding++) result.append('0');
                result.append(hex);
            } else result.append(item);
        }
        return result.toString();
    }

    private static void closeQuietly(JavaScriptIsolate isolate) { if (isolate != null) try { isolate.close(); } catch (RuntimeException ignored) { } }

    @Override public synchronized void close() {
        JavaScriptSandbox previous = sandbox; sandbox = null;
        if (previous != null) try { previous.close(); } catch (RuntimeException ignored) { }
        ListenableFuture<JavaScriptSandbox> pending = pendingConnection; pendingConnection = null;
        if (pending != null) pending.addListener(() -> {
            try { pending.get().close(); } catch (Exception ignored) { }
        }, Runnable::run);
    }
}
