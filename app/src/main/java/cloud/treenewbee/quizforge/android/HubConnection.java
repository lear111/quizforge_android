package cloud.treenewbee.quizforge.android;

import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Connects this device to a QuizForge Hub account for the free AI quota
 * (Hub docs/HUB_CONNECT_AI.md v1, section 7.2). The origin and redirect are fixed;
 * the device token is sealed with an Android Keystore key and never returned to pages.
 */
public final class HubConnection implements AiGateway.HubToken {
    public static final String ORIGIN = HubImportClient.ORIGIN;
    public static final String REDIRECT = "quizforge://hub/connect";
    static final Pattern TOKEN = Pattern.compile("qfd_[A-Za-z0-9_-]{43}");
    private static final Pattern CODE = Pattern.compile("[A-Za-z0-9_-]{43}");
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final long PENDING_TTL = 600000;
    private final AtomicFile file;
    private final String alias, deviceName;
    private final OkHttpClient transport;
    private final Map<String, Pending> pending = new LinkedHashMap<>();
    private JSONObject value;

    private static final class Pending {
        final String verifier, url; final long expires;
        Pending(String verifier, String url, long expires) { this.verifier = verifier; this.url = url; this.expires = expires; }
    }

    public HubConnection(Context context) {
        this(new File(context.getFilesDir(), "hub-connection.enc"), context.getPackageName() + ".hub.connection.v1",
                HubImportClient.newAnonymousClient(), defaultDeviceName());
    }
    HubConnection(File file, String alias, OkHttpClient transport, String deviceName) {
        this.file = new AtomicFile(file); this.alias = alias; this.transport = transport; this.deviceName = cleanName(deviceName);
        if (file.exists() || new File(file + ".bak").exists()) {
            try (InputStream input = this.file.openRead()) {
                JSONObject envelope = new JSONObject(new String(read(input, 16384), StandardCharsets.UTF_8));
                if (envelope.getInt("schemaVersion") != 1) throw new Exception();
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)));
                cipher.updateAAD(alias.getBytes(StandardCharsets.UTF_8));
                JSONObject saved = new JSONObject(new String(cipher.doFinal(Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP)), StandardCharsets.UTF_8));
                if (saved.getInt("schemaVersion") == 1 && TOKEN.matcher(saved.getString("token")).matches()) value = saved;
            } catch (Exception exception) { value = null; } // An unreadable connection is the same as being logged out.
        }
    }

    static String defaultDeviceName() {
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim(), model = Build.MODEL == null ? "" : Build.MODEL.trim();
        if (!maker.isEmpty() && !model.toLowerCase(java.util.Locale.ROOT).startsWith(maker.toLowerCase(java.util.Locale.ROOT)))
            model = Character.toUpperCase(maker.charAt(0)) + maker.substring(1) + " " + model;
        return model.isEmpty() ? "QuizForge 安卓设备" : model;
    }
    private static String cleanName(String name) {
        String text = (name == null ? "" : name).replaceAll("[\\u0000-\\u001f\\u007f-\\u009f]", "").trim();
        int end = text.offsetByCodePoints(0, Math.min(40, text.codePointCount(0, text.length())));
        text = text.substring(0, end);
        return text.isEmpty() ? "QuizForge 安卓设备" : text;
    }

    @Override public synchronized String token() { return value == null ? null : value.optString("token", null); }
    public synchronized JSONObject summary() throws Exception {
        if (value == null) return new JSONObject().put("connected", false);
        return new JSONObject().put("connected", true).put("user", new JSONObject().put("name", value.getJSONObject("user").getString("name")))
                .put("device", new JSONObject().put("name", value.getJSONObject("device").getString("name")).put("client", "android"));
    }

    /** Starts the browser flow: PKCE S256 and a single-use state, valid for ten minutes. */
    public synchronized JSONObject start() throws Exception {
        long now = System.currentTimeMillis();
        for (Iterator<Pending> entries = pending.values().iterator(); entries.hasNext();) if (entries.next().expires <= now) entries.remove();
        if (pending.size() >= 8) pending.remove(pending.keySet().iterator().next());
        String verifier = random(48), state = random(24);
        String challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)), Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        String url = Uri.parse(ORIGIN + "/connect/authorize").buildUpon().appendQueryParameter("v", "1").appendQueryParameter("client", "android")
                .appendQueryParameter("redirect_uri", REDIRECT).appendQueryParameter("state", state).appendQueryParameter("code_challenge", challenge)
                .appendQueryParameter("code_challenge_method", "S256").appendQueryParameter("device_name", deviceName).build().toString();
        pending.put(state, new Pending(verifier, url, now + PENDING_TTL));
        return new JSONObject().put("authorizeUrl", url);
    }

    /** Only HTTPS pages of the fixed Hub origin may be opened from the app page. */
    public static boolean hubPage(String url) {
        try {
            URI uri = new URI(url);
            return "https".equals(uri.getScheme()) && "quizforge.treenewbee.cloud".equals(uri.getHost()) && uri.getPort() == -1 && uri.getRawUserInfo() == null;
        } catch (Exception exception) { return false; }
    }
    public static boolean callback(Uri uri) {
        return uri != null && "quizforge".equals(uri.getScheme()) && "hub".equals(uri.getHost()) && "/connect".equals(uri.getPath());
    }

    /** Handles quizforge://hub/connect: checks state, then exchanges the code natively. */
    public JSONObject complete(Uri uri) throws Exception {
        if (!callback(uri)) throw failure("HUB_CONNECT_INVALID", "登录结果无效，请回到 QuizForge 重新登录。");
        String state = uri.getQueryParameter("state"); Pending entry;
        synchronized (this) { entry = state == null ? null : pending.remove(state); }
        if (entry == null || entry.expires <= System.currentTimeMillis()) throw failure("HUB_CONNECT_EXPIRED", "登录请求已过期，请回到 QuizForge 的 AI 设置重新点击“登录”。");
        if ("access_denied".equals(uri.getQueryParameter("error"))) throw failure("HUB_CONNECT_DENIED", "你拒绝了连接，没有登录。可以回到 QuizForge 重新登录。");
        String code = uri.getQueryParameter("code");
        if (code == null || !CODE.matcher(code).matches()) throw failure("HUB_CONNECT_INVALID", "登录结果无效，请回到 QuizForge 重新登录。");
        JSONObject body = new JSONObject().put("v", 1).put("client", "android").put("code", code).put("code_verifier", entry.verifier).put("redirect_uri", REDIRECT);
        Exchange result;
        try { result = exchange(new Request.Builder().url(ORIGIN + "/api/connect/token").post(RequestBody.create(body.toString().getBytes(StandardCharsets.UTF_8), JSON)), null, 15); }
        catch (Exception exception) { throw failure("HUB_UNREACHABLE", "无法连接 QuizForge 服务器，请检查网络后重新登录。"); }
        JSONObject json = result.json;
        if (result.status < 200 || result.status >= 300) {
            JSONObject error = json == null ? null : json.optJSONObject("error");
            String message = error == null ? "" : error.optString("message", "");
            throw failure("HUB_CONNECT_INVALID", message.isEmpty() || message.length() > 200 ? "登录没有完成，请回到 QuizForge 重新登录。" : message);
        }
        JSONObject user = json == null ? null : json.optJSONObject("user"), device = json == null ? null : json.optJSONObject("device");
        if (json == null || !TOKEN.matcher(json.optString("token")).matches() || user == null || !(user.opt("name") instanceof String) || device == null || !(device.opt("name") instanceof String))
            throw failure("HUB_CONNECT_INVALID", "服务器返回的登录结果无效，请稍后重试。");
        JSONObject saved = new JSONObject().put("schemaVersion", 1).put("token", json.getString("token"))
                .put("user", new JSONObject().put("name", limit(user.getString("name"), 60)))
                .put("device", new JSONObject().put("id", String.valueOf(device.opt("id") == null ? "" : device.opt("id"))).put("name", limit(device.getString("name"), 40)))
                .put("connectedAt", java.time.Instant.now().toString());
        synchronized (this) { persist(saved); return summary(); }
    }

    /** Account and free AI balance from the Hub; a rejected token logs this device out. */
    public JSONObject account() throws Exception {
        String token = token(); if (token == null) return new JSONObject().put("connected", false);
        try {
            Exchange result = exchange(new Request.Builder().url(ORIGIN + "/api/connect/me").get(), token, 10);
            if (result.status == 401) { invalidate(token); return new JSONObject().put("connected", false).put("expired", true); }
            JSONObject ai = result.json == null ? null : result.json.optJSONObject("ai");
            if (result.status < 200 || result.status >= 300 || ai == null) return summary().put("unavailable", true);
            String model = ai.opt("model") instanceof String ? limit(ai.getString("model"), 80) : "";
            return summary().put("ai", new JSONObject().put("enabled", Boolean.TRUE.equals(ai.opt("enabled"))).put("model", model).put("balance", count(ai.opt("balance"))));
        } catch (Exception exception) { return summary().put("unavailable", true); }
    }

    /** Adds free AI balance with a redeem code (docs/HUB_CONNECT_AI.md 5, 6.1). */
    public JSONObject redeem(Object code) throws Exception {
        String token = token(); if (token == null) throw failure("HUB_LOGIN_REQUIRED", "请先登录 QuizForge 账号。");
        if (!(code instanceof String) || ((String) code).trim().isEmpty() || ((String) code).length() > 64) throw failure("REDEEM_CODE_INVALID", "请输入兑换码。");
        Exchange result;
        try { result = exchange(new Request.Builder().url(ORIGIN + "/api/connect/redeem").post(RequestBody.create(new JSONObject().put("code", ((String) code).trim()).toString().getBytes(StandardCharsets.UTF_8), JSON)), token, 15); }
        catch (Exception exception) { throw failure("HUB_UNREACHABLE", "无法连接 QuizForge 服务器，请检查网络后重试。"); }
        if (result.status == 401) { invalidate(token); throw failure("HUB_LOGIN_REQUIRED", "登录已失效，请重新登录 QuizForge 账号。"); }
        JSONObject error = result.json == null ? null : result.json.optJSONObject("error");
        String errorCode = error == null ? "" : error.optString("code");
        if (errorCode.equals("REDEEM_CODE_INVALID")) throw failure(errorCode, "兑换码无效、已使用或已过期。");
        if (errorCode.equals("REDEEM_LOCKED")) throw failure(errorCode, "兑换码输错次数太多，请 1 小时后再试。");
        Object balance = result.json == null ? null : result.json.opt("balance");
        if (result.status < 200 || result.status >= 300 || !(balance instanceof Integer || balance instanceof Long)) throw failure("HUB_REDEEM_FAILED", "兑换没有完成，请稍后重试。");
        return new JSONObject().put("added", count(result.json.opt("added"))).put("balance", count(balance));
    }

    public JSONObject logout() throws Exception {
        String token = token(); if (token == null) return summary();
        clear();
        // Revoking on the Hub is best effort; the local token is gone either way.
        try { exchange(new Request.Builder().url(ORIGIN + "/api/connect/logout").post(RequestBody.create(new byte[0], null)), token, 5); }
        catch (Exception ignored) { }
        return summary();
    }

    @Override public synchronized void invalidate(String token) { if (token != null && value != null && token.equals(value.optString("token"))) clear(); }

    private synchronized void clear() {
        value = null;
        file.delete(); // A leftover file is ignored once the token is rejected.
    }

    private static final class Exchange { final int status; final JSONObject json; Exchange(int status, JSONObject json) { this.status = status; this.json = json; } }
    private Exchange exchange(Request.Builder builder, String token, int seconds) throws Exception {
        builder.header("Accept", "application/json").header("Cache-Control", "no-store");
        if (token != null) builder.header("Authorization", "Bearer " + token);
        Call call = transport.newCall(builder.build()); call.timeout().timeout(seconds, TimeUnit.SECONDS);
        try (Response response = call.execute()) {
            JSONObject json = null;
            try { json = new JSONObject(new String(read(response.body().byteStream(), 65536), StandardCharsets.UTF_8)); } catch (Exception ignored) { }
            return new Exchange(response.code(), json);
        }
    }

    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        if (!create) throw new Exception("Missing Hub key");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }
    private void persist(JSONObject saved) throws Exception {
        FileOutputStream output = null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key(true));
            cipher.updateAAD(alias.getBytes(StandardCharsets.UTF_8));
            byte[] plaintext = saved.toString().getBytes(StandardCharsets.UTF_8), ciphertext;
            try { ciphertext = cipher.doFinal(plaintext); } finally { Arrays.fill(plaintext, (byte) 0); }
            JSONObject envelope = new JSONObject().put("schemaVersion", 1).put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                    .put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP));
            output = file.startWrite(); output.write(envelope.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync(); file.finishWrite(output);
            value = saved;
        } catch (Exception exception) {
            if (output != null) file.failWrite(output);
            throw failure("HUB_SAVE_FAILED", "登录信息未能安全保存，请重新登录。");
        }
    }

    private static String random(int bytes) {
        byte[] data = new byte[bytes]; new SecureRandom().nextBytes(data);
        return Base64.encodeToString(data, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }
    private static String limit(String text, int max) { return text.length() <= max ? text : text.substring(0, max); }
    private static long count(Object value) { return (value instanceof Integer || value instanceof Long) && ((Number) value).longValue() >= 0 && ((Number) value).longValue() <= 9007199254740991L ? ((Number) value).longValue() : 0; }
    private static byte[] read(InputStream input, int maximum) throws Exception {
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) { byte[] buffer = new byte[4096]; int n; while ((n = input.read(buffer)) != -1) { if (output.size() + n > maximum) throw new Exception("Too large"); output.write(buffer, 0, n); } return output.toByteArray(); }
    }
    private static StorageException failure(String code, String message) { return new StorageException(code, message); }
}
