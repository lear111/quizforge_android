package cloud.treenewbee.quizforge.android;

import android.content.Context;
import android.os.CancellationSignal;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import okhttp3.Authenticator;
import okhttp3.Call;
import okhttp3.CookieJar;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/** Anonymous, pinned Hub delivery. The repository remains the package validator. */
public final class HubImportClient {
    // Confirmed in Hub README, its v1 contract, and the Windows client source.
    public static final String ORIGIN = "https://quizforge.treenewbee.cloud";
    public static final String LIBRARY_URL = ORIGIN + "/manage/#library";
    public static final long MAX_ARCHIVE_BYTES = 64L * 1024 * 1024;
    public static final long NETWORK_TIMEOUT_MILLIS = 180000;
    private static final int MAX_MANIFEST_BYTES = 32768;
    private static final long MAX_REVISION = 9007199254740991L;
    private static final Pattern UUID_PATTERN = Pattern.compile("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}");
    private static final Pattern SHA256_PATTERN = Pattern.compile("[a-f0-9]{64}");
    private final File privateCache;
    private final OkHttpClient transport;
    private final long timeoutMillis;

    /** Reuse one client; call download on the application's import executor. */
    public HubImportClient(Context context) {
        this(context.getApplicationContext().getCacheDir(), newAnonymousClient(), NETWORK_TIMEOUT_MILLIS);
    }

    // Test-only injection is package-private; no intent/config may change origin or TLS.
    HubImportClient(File privateCache, OkHttpClient transport, long timeoutMillis) {
        if (privateCache == null || transport == null || timeoutMillis < 1 || timeoutMillis > NETWORK_TIMEOUT_MILLIS)
            throw new IllegalArgumentException("Invalid Hub client configuration");
        this.privateCache = privateCache;
        this.transport = transport;
        this.timeoutMillis = timeoutMillis;
    }

    static OkHttpClient newAnonymousClient() {
        return new OkHttpClient.Builder()
                .cookieJar(CookieJar.NO_COOKIES)
                .authenticator(Authenticator.NONE)
                .proxyAuthenticator(Authenticator.NONE)
                .followRedirects(false).followSslRedirects(false)
                .retryOnConnectionFailure(false)
                .callTimeout(NETWORK_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
                .connectTimeout(20000, TimeUnit.MILLISECONDS)
                .readTimeout(30000, TimeUnit.MILLISECONDS)
                .cache(null)
                // Keep the Android system proxy selector. Never read browser cookies,
                // global Java authenticators, account tokens or arbitrary intent URLs.
                .build();
    }

    public interface ProgressListener {
        /** Called on the download worker; marshal UI work to the main thread. */
        void onProgress(String stage, long receivedBytes, long totalBytes, String displayName);
    }

    public static final class ImportRequest {
        public final String packId;
        public final long revision;
        private ImportRequest(String packId, long revision) { this.packId = packId; this.revision = revision; }
        public String key() { return packId + ":" + revision; }
        public String uri() { return "quizforge://hub/import?v=1&pack=" + packId + "&revision=" + revision; }
    }

    /** Strict v1 parser: no encoded/duplicate/unknown parameters or arbitrary URLs. */
    public static ImportRequest parse(String value) throws StorageException {
        final String prefix = "quizforge://hub/import?";
        if (value == null || value.length() > 1024 || !value.startsWith(prefix) || !value.matches("[\\x21-\\x7e]+")) throw invalidLink();
        String[] parameters = value.substring(prefix.length()).split("&", -1);
        if (parameters.length != 3) throw invalidLink();
        Map<String, String> fields = new HashMap<>();
        for (String parameter : parameters) {
            String[] pair = parameter.split("=", -1);
            if (pair.length != 2 || !("v".equals(pair[0]) || "pack".equals(pair[0]) || "revision".equals(pair[0]))
                    || fields.put(pair[0], pair[1]) != null) throw invalidLink();
        }
        String revision = fields.get("revision"), pack = fields.get("pack");
        if (!"1".equals(fields.get("v")) || pack == null || !UUID_PATTERN.matcher(pack).matches()
                || revision == null || !revision.matches("[1-9][0-9]{0,15}")) throw invalidLink();
        long number;
        try { number = Long.parseLong(revision); } catch (NumberFormatException exception) { throw invalidLink(); }
        if (number > MAX_REVISION) throw invalidLink();
        return new ImportRequest(pack, number);
    }

    private static StorageException invalidLink() {
        return new StorageException("HUB_IMPORT_INVALID_LINK", "Hub 导入链接无效，请返回题库广场重新点击");
    }

    /** Owns exactly one verified temporary archive, never an installed bank. */
    public static final class DownloadedPackage implements AutoCloseable {
        public final ImportRequest request;
        public final String title;
        public final String displayName;
        public final long size;
        public final String sha256;
        private final File stage;
        private final File file;
        private boolean closed;
        private DownloadedPackage(ImportRequest request, Manifest manifest, File stage, File file) {
            this.request = request; this.title = manifest.title; this.displayName = manifest.name;
            this.size = manifest.size; this.sha256 = manifest.sha256; this.stage = stage; this.file = file;
        }
        /** Pass this stream to repository.importPackage(input, null), then close both. */
        public synchronized InputStream openStream() throws IOException {
            if (closed) throw new IOException("Downloaded package has been closed");
            checkOwnedFile(stage, file);
            return Files.newInputStream(file.toPath(), StandardOpenOption.READ);
        }
        @Override public synchronized void close() throws IOException {
            if (!closed) { removeStage(stage); closed = true; }
        }
    }

    public DownloadedPackage download(String uri, CancellationSignal cancellation, ProgressListener listener) throws StorageException {
        return download(parse(uri), cancellation, listener);
    }

    /** Download only; successful bytes still require full repository/rules validation. */
    public DownloadedPackage download(ImportRequest source, CancellationSignal cancellation, ProgressListener listener) throws StorageException {
        if (source == null) throw invalidLink();
        CancellationSignal signal = cancellation == null ? new CancellationSignal() : cancellation;
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
        File stage = null;
        try {
            checkDeadline(deadline, signal);
            progress(listener, "manifest", 0, 0, "正在获取 Hub 题库信息");
            String prefix = "/api/packs/" + source.packId;
            JSONObject document;
            try (Response response = response(prefix + "/local-import?revision=" + source.revision, "application/json", signal, deadline)) {
                document = readJson(response, signal, deadline);
            }
            Manifest manifest = manifest(document, source);
            checkDeadline(deadline, signal);
            stage = createStage();
            File archive = new File(stage, "package.qbank");
            progress(listener, "download", 0, manifest.size, manifest.name);
            String route = prefix + "/download?revision=" + source.revision + "&sha256=" + manifest.sha256;
            try (Response response = response(route, "application/octet-stream", signal, deadline)) {
                if (contentLength(response) != manifest.size) throw sizeMismatch();
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (InputStream input = response.body().byteStream();
                     OutputStream output = Files.newOutputStream(archive.toPath(), StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                    byte[] buffer = new byte[32768]; long received = 0, lastProgress = 0;
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        checkDeadline(deadline, signal);
                        received += count;
                        if (received > manifest.size || received > MAX_ARCHIVE_BYTES) throw sizeMismatch();
                        output.write(buffer, 0, count); digest.update(buffer, 0, count);
                        if (received - lastProgress >= 262144 || received == manifest.size) {
                            progress(listener, "download", received, manifest.size, manifest.name); lastProgress = received;
                        }
                    }
                    if (received != manifest.size) throw sizeMismatch();
                }
                if (!MessageDigest.isEqual(manifest.sha256.getBytes(StandardCharsets.US_ASCII), hex(digest.digest()).getBytes(StandardCharsets.US_ASCII)))
                    throw new StorageException("HUB_IMPORT_HASH_MISMATCH", "题库文件校验失败，未导入；请重新下载");
            }
            checkDeadline(deadline, signal);
            progress(listener, "verified", manifest.size, manifest.size, manifest.name);
            return new DownloadedPackage(source, manifest, stage, archive);
        } catch (Exception exception) {
            StorageException failure;
            if (exception instanceof StorageException) failure = (StorageException) exception;
            else if (signal.isCanceled() || Thread.currentThread().isInterrupted()) failure = new StorageException("HUB_IMPORT_CANCELLED", "已取消 Hub 下载", exception);
            else if (exception instanceof InterruptedIOException || System.nanoTime() >= deadline) failure = new StorageException("HUB_IMPORT_TIMEOUT", "Hub 下载超时，未导入；请检查网络后重试", exception);
            else if (exception instanceof IOException) failure = new StorageException("HUB_IMPORT_NETWORK", "无法完成 Hub 下载，未导入；请检查网络或下载文件后导入", exception);
            else failure = new StorageException("HUB_IMPORT_FAILED", "Hub 下载未能完成，原有题库和作答仍保留", exception);
            if (stage != null) try { removeStage(stage); } catch (IOException cleanup) { failure.addSuppressed(cleanup); }
            throw failure;
        } finally { signal.setOnCancelListener(null); }
    }

    private Response response(String path, String expectedType, CancellationSignal signal, long deadline) throws Exception {
        checkDeadline(deadline, signal);
        Request request = new Request.Builder().url(ORIGIN + path).get()
                .header("Accept", expectedType).header("Accept-Encoding", "identity")
                .header("Cache-Control", "no-store").header("User-Agent", "QuizForge-Android-HubImport/1")
                .build();
        Call call = transport.newCall(request);
        call.timeout().timeout(Math.max(1, TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())), TimeUnit.MILLISECONDS);
        signal.setOnCancelListener(call::cancel);
        Response response = call.execute();
        try {
            checkDeadline(deadline, signal);
            if (response.code() >= 300 && response.code() <= 399)
                throw new StorageException("HUB_IMPORT_REDIRECT", "Hub 下载地址发生跳转，已停止；请返回题库广场重试");
            if (response.code() != 200) throw remoteFailure(response, signal, deadline);
            if (!mediaType(response).equals(expectedType) || !response.headers("Content-Encoding").isEmpty())
                throw new StorageException("HUB_IMPORT_RESPONSE_INVALID", "Hub 返回的文件类型或编码无效，未导入");
            return response;
        } catch (Exception exception) { response.close(); throw exception; }
    }

    private static JSONObject readJson(Response response, CancellationSignal signal, long deadline) throws Exception {
        if (!"application/json".equals(mediaType(response))) throw invalidManifest();
        String length = response.header("Content-Length");
        if (length != null && (!length.matches("[0-9]{1,10}") || Long.parseLong(length) > MAX_MANIFEST_BYTES)) throw invalidManifest();
        try (InputStream input = response.body().byteStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int count;
            while ((count = input.read(buffer)) != -1) {
                checkDeadline(deadline, signal);
                if (output.size() + count > MAX_MANIFEST_BYTES) throw invalidManifest();
                output.write(buffer, 0, count);
            }
            String text;
            try { text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(output.toByteArray())).toString(); }
            catch (CharacterCodingException exception) { throw invalidManifest(); }
            JSONTokener tokener = new JSONTokener(text);
            Object value = tokener.nextValue();
            if (!(value instanceof JSONObject) || tokener.nextClean() != 0) throw invalidManifest();
            return (JSONObject) value;
        } catch (org.json.JSONException exception) { throw invalidManifest(); }
    }

    private static Manifest manifest(JSONObject document, ImportRequest source) throws Exception {
        JSONObject pack = document.optJSONObject("pack"), archive = document.optJSONObject("archive");
        if (number(document.opt("schemaVersion")) != 1 || pack == null || archive == null
                || !source.packId.equals(pack.opt("id")) || number(pack.opt("revision")) != source.revision
                || !(pack.opt("title") instanceof String) || !(archive.opt("name") instanceof String)
                || !(archive.opt("sha256") instanceof String)) throw invalidManifest();
        String title = (String) pack.opt("title"), name = (String) archive.opt("name"), sha256 = (String) archive.opt("sha256");
        long size = number(archive.opt("size"));
        if (title.length() > 1000 || name.isEmpty() || name.length() > 255 || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0
                || name.codePoints().anyMatch(c -> Character.isISOControl(c)) || !name.toLowerCase(Locale.ROOT).endsWith(".qbank")
                || !SHA256_PATTERN.matcher(sha256).matches() || size < 1) throw invalidManifest();
        if (size > MAX_ARCHIVE_BYTES) throw new StorageException("HUB_IMPORT_TOO_LARGE", "Hub 题库文件超过 64 MiB，请使用文件下载");
        return new Manifest(title, name, size, sha256);
    }

    private static long number(Object value) throws StorageException {
        if (!(value instanceof Integer) && !(value instanceof Long)) throw invalidManifest();
        return ((Number) value).longValue();
    }
    private static final class Manifest {
        final String title, name, sha256; final long size;
        Manifest(String title, String name, long size, String sha256) { this.title = title; this.name = name; this.size = size; this.sha256 = sha256; }
    }
    private static String mediaType(Response response) {
        String type = response.header("Content-Type", "");
        return type.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
    }
    private static long contentLength(Response response) throws StorageException {
        List<String> lengths = response.headers("Content-Length");
        if (lengths.size() != 1 || !lengths.get(0).matches("[0-9]{1,10}")) throw sizeMismatch();
        return Long.parseLong(lengths.get(0));
    }
    private static StorageException remoteFailure(Response response, CancellationSignal signal, long deadline) throws Exception {
        String code = "";
        try { code = readJson(response, signal, deadline).optString("code", ""); }
        catch (StorageException ignored) { checkDeadline(deadline, signal); }
        String message;
        switch (code) {
            case "LOCAL_IMPORT_REQUEST_INVALID": message = "Hub 导入参数无效，请返回题库广场重新点击"; break;
            case "LOCAL_IMPORT_DISABLED": message = "Hub 暂未开放直接导入，请先下载 .qbank 文件"; break;
            case "LOCAL_IMPORT_UNAVAILABLE": message = "此题库未公开或暂不可用，请返回 Hub 查看"; break;
            case "LOCAL_IMPORT_REVISION_CHANGED": message = "题库版本已变化，请刷新 Hub 后重新点击"; break;
            case "LOCAL_IMPORT_TOO_LARGE": message = "Hub 题库文件超过下载上限，请使用文件下载"; break;
            case "LOCAL_IMPORT_FORMAT_UNSUPPORTED": message = "此附件暂不支持直接导入，请使用 .qbank 文件"; break;
            case "LOCAL_IMPORT_RATE_LIMITED": message = "Hub 请求过于频繁，请稍后重试"; break;
            case "LOCAL_IMPORT_TRAFFIC_LIMIT": message = "Hub 下载流量额度不足，请稍后重试"; break;
            default: return new StorageException("HUB_IMPORT_DOWNLOAD_FAILED", "Hub 未能提供此题库，请稍后重试或下载文件后导入");
        }
        return new StorageException(code, message);
    }
    private static StorageException invalidManifest() {
        return new StorageException("HUB_IMPORT_MANIFEST_INVALID", "Hub 题库清单无效或与链接不一致，未导入");
    }
    private static StorageException sizeMismatch() {
        return new StorageException("HUB_IMPORT_SIZE_MISMATCH", "Hub 文件长度不符或下载不完整，未导入");
    }
    private static void checkDeadline(long deadline, CancellationSignal signal) throws StorageException {
        if (signal.isCanceled() || Thread.currentThread().isInterrupted()) throw new StorageException("HUB_IMPORT_CANCELLED", "已取消 Hub 下载");
        if (System.nanoTime() >= deadline) throw new StorageException("HUB_IMPORT_TIMEOUT", "Hub 下载超时，未导入；请稍后重试");
    }
    private static void progress(ProgressListener listener, String stage, long received, long total, String name) {
        if (listener != null) listener.onProgress(stage, received, total, name);
    }
    private File createStage() throws IOException {
        File cache = privateCache.getCanonicalFile();
        File root = new File(cache, "hub-import-v1");
        if (!root.exists() && !root.mkdir()) throw new IOException("Cannot create Hub staging root");
        if (Files.isSymbolicLink(root.toPath()) || !root.getCanonicalFile().getParentFile().equals(cache) || !root.isDirectory())
            throw new IOException("Invalid Hub staging root");
        File stage = new File(root, UUID.randomUUID().toString());
        if (!stage.mkdir() || !stage.getCanonicalFile().getParentFile().equals(root.getCanonicalFile())) throw new IOException("Cannot create Hub staging task");
        return stage;
    }
    private static void checkOwnedFile(File stage, File file) throws IOException {
        if (!UUID_PATTERN.matcher(stage.getName()).matches() || Files.isSymbolicLink(stage.toPath())
                || !"hub-import-v1".equals(stage.getParentFile().getName()) || !stage.isDirectory()
                || !stage.getCanonicalFile().equals(stage.getAbsoluteFile()) || Files.isSymbolicLink(file.toPath())
                || !file.getName().equals("package.qbank") || !file.getCanonicalFile().getParentFile().equals(stage.getCanonicalFile()))
            throw new IOException("Invalid owned Hub staging file");
    }
    private static void removeStage(File stage) throws IOException {
        File archive = new File(stage, "package.qbank"); checkOwnedFile(stage, archive);
        String[] names = stage.list();
        if (names == null || names.length > 1 || names.length == 1 && !names[0].equals("package.qbank")) throw new IOException("Unknown Hub staging contents");
        if (Files.exists(archive.toPath(), LinkOption.NOFOLLOW_LINKS) && !Files.isRegularFile(archive.toPath(), LinkOption.NOFOLLOW_LINKS))
            throw new IOException("Hub staging archive is not a regular file");
        Files.deleteIfExists(archive.toPath()); Files.delete(stage.toPath());
    }
    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) text.append(String.format(Locale.ROOT, "%02x", value & 255));
        return text.toString();
    }
}
