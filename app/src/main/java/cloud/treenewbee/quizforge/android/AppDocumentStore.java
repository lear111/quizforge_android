package cloud.treenewbee.quizforge.android;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** Bounded, revisioned private documents for durable local service records. */
public final class AppDocumentStore {
    private static final int MAX_DOCUMENT = 128 * 1024 * 1024;
    private static final long MAX_NAMESPACE = 256L * 1024 * 1024;
    private final File root;
    public AppDocumentStore(Context context) throws Exception {
        root = new File(context.getFilesDir(), "local-services");
        if (!root.isDirectory() && !root.mkdirs()) throw failure("本地服务记录目录无法创建");
        if (Files.isSymbolicLink(root.toPath())) throw failure("本地服务记录目录异常，原文件已保留");
    }
    private File file(String namespace, String key) throws Exception {
        if (!namespace.matches("exam|ai-task|hub-import") || !key.matches("[A-Za-z0-9_-]{1,96}"))
            throw new StorageException("INVALID_DOCUMENT", "本地记录编号无效");
        File folder = new File(root, namespace);
        if (!folder.isDirectory() && !folder.mkdir()) throw failure("本地记录目录无法创建");
        File result = new File(folder, key + ".json");
        if (Files.isSymbolicLink(folder.toPath()) || Files.isSymbolicLink(result.toPath())
                || !result.getCanonicalFile().getParentFile().equals(folder.getCanonicalFile()))
            throw failure("本地记录路径异常，原文件已保留");
        return result;
    }
    public synchronized JSONObject read(String namespace, String key) throws Exception {
        File target = file(namespace, key);
        if (!target.exists() && !new File(target + ".bak").exists()) return null;
        try (InputStream input = new AtomicFile(target).openRead(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] block = new byte[16384]; int count;
            while ((count = input.read(block)) != -1) {
                if (bytes.size() + count > MAX_DOCUMENT) throw failure("本地记录超过大小上限，原文件已保留");
                bytes.write(block, 0, count);
            }
            JSONObject value = new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
            if (value.optInt("schemaVersion", 0) != 1 || value.optLong("revision", -1) < 1)
                throw failure("本地记录版本异常，原文件已保留");
            return value;
        }
    }
    public synchronized JSONObject write(String namespace, String key, JSONObject value, long expectedRevision) throws Exception {
        JSONObject previous = read(namespace, key);
        long actual = previous == null ? 0 : previous.getLong("revision");
        if (expectedRevision != actual) throw new StorageException("REVISION_CONFLICT", "本地记录已更新，请重新读取后重试");
        if (actual >= 9007199254740991L) throw failure("本地记录版本已达到上限");
        JSONObject next = new JSONObject(value.toString()).put("schemaVersion", 1).put("revision", actual + 1);
        byte[] encoded = next.toString().getBytes(StandardCharsets.UTF_8);
        if (encoded.length > MAX_DOCUMENT) throw failure("本地记录超过大小上限，原内容已保留");
        File target = file(namespace, key); long total = encoded.length; int records = 0;
        File[] files = target.getParentFile().listFiles();
        if (files == null) throw failure("无法读取本地记录目录");
        for (File item : files) if (item.getName().endsWith(".json") && !item.equals(target)) { total += item.length(); records++; }
        if (records >= 1024 || total > MAX_NAMESPACE) throw failure("本地服务记录已达到存储上限，已有内容已保留");
        AtomicFile atomic = new AtomicFile(target); FileOutputStream output = null;
        try { output = atomic.startWrite(); output.write(encoded); output.getFD().sync(); atomic.finishWrite(output); }
        catch (Exception exception) { if (output != null) atomic.failWrite(output); throw exception; }
        return next;
    }
    public synchronized JSONArray list(String namespace) throws Exception {
        File folder = file(namespace, "index").getParentFile();
        String[] names = folder.list(); if (names == null) throw failure("无法读取本地服务目录");
        java.util.Set<String> keys = new java.util.TreeSet<>();
        for (String name : names) {
            if (name.endsWith(".bak")) name = name.substring(0, name.length() - 4);
            if (name.matches("[A-Za-z0-9_-]{1,96}\\.json")) keys.add(name.substring(0, name.length() - 5));
        }
        return new JSONArray(keys);
    }
    private static StorageException failure(String message) { return new StorageException("DOCUMENT_UNAVAILABLE", message); }
}
