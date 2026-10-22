package cloud.treenewbee.quizforge.android;

import android.util.AtomicFile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/** Forward-only, checksummed source + state transaction with bounded disk staging. */
final class RepositoryTransaction {
    private static final long MAX_PLANNED_BYTES = 96L * 1024 * 1024;
    private final File root;
    private final File staging;
    private final File journal;
    private boolean recovering;

    RepositoryTransaction(File root) throws Exception {
        this.root = root.getCanonicalFile();
        this.staging = new File(root, "transactions");
        this.journal = new File(root, "repository-transaction.json");
        mkdir(staging);
    }

    void commit(Map<File, byte[]> replacements) throws Exception {
        commit(replacements, new LinkedHashMap<>());
    }

    void commit(Map<File, byte[]> replacements, Map<File, String> expected) throws Exception {
        recover();
        if (replacements.isEmpty()) return;
        if (replacements.size() > 24) throw new StorageException("TRANSACTION_LIMIT", "本次修改文件过多");
        String id = UUID.randomUUID().toString();
        File work = new File(staging, id);
        mkdir(work);
        boolean published = false;
        try {
            JSONArray targets = new JSONArray();
            long bytes = 0;
            int index = 0;
            for (Map.Entry<File, byte[]> entry : replacements.entrySet()) {
                File target = allowedTarget(relative(entry.getKey()));
                byte[] after = entry.getValue();
                if (after != null && (after.length > targetLimit(relative(target)) || (bytes += after.length) > MAX_PLANNED_BYTES))
                    throw new StorageException("TRANSACTION_LIMIT", "本次修改超过本地事务大小上限，原文件已保留");
                String before = digest(target), required = expected.get(entry.getKey());
                if (required != null && !required.equals(before)) throw new StorageException("CONTENT_CONFLICT", "源文件或练习记录已变化，本次修改未保存");
                JSONObject row = new JSONObject().put("path", relative(target)).put("before", before);
                if (after == null) row.put("after", "absent").put("file", JSONObject.NULL);
                else {
                    String name = index + ".bin";
                    File planned = new File(work, name);
                    write(planned, after);
                    row.put("after", digest(planned)).put("file", name);
                }
                targets.put(row);
                index++;
            }
            JSONObject document = new JSONObject().put("schemaVersion", 1).put("id", id).put("targets", targets);
            write(journal, document.toString().getBytes(StandardCharsets.UTF_8));
            published = true;
            recover();
        } finally {
            // Once the journal is published, preserve staged bytes on any failure.
            // Recovery must finish or reject conflicting changes before other writes.
            if (!published) removeOwned(work);
        }
    }

    void recover() throws Exception {
        if (recovering || !journal.exists() && !new File(journal.getPath() + ".bak").exists()) return;
        recovering = true;
        try {
            JSONObject document;
            try (InputStream input = new AtomicFile(journal).openRead()) {
                document = new JSONObject(new String(read(input, 256 * 1024), StandardCharsets.UTF_8));
            }
            String id = document.optString("id");
            JSONArray targets = document.optJSONArray("targets");
            if (document.optInt("schemaVersion") != 1 || !id.matches("[a-f0-9-]{36}") || targets == null
                    || targets.length() == 0 || targets.length() > 24) throw failure("本地修改恢复日志无效");
            File work = new File(staging, id).getCanonicalFile();
            if (!work.getParentFile().equals(staging.getCanonicalFile()) || !work.isDirectory()) throw failure("本地修改恢复文件缺失");
            Map<File, File> plan = new LinkedHashMap<>();
            long bytes = 0;
            for (int i = 0; i < targets.length(); i++) {
                JSONObject row = targets.getJSONObject(i);
                File target = allowedTarget(row.getString("path"));
                if (plan.containsKey(target)) throw failure("恢复日志包含重复目标");
                String before = row.getString("before"), after = row.getString("after");
                if (!hashOrAbsent(before) || !hashOrAbsent(after)) throw failure("恢复日志校验值无效");
                String actual = digest(target);
                if (!actual.equals(before) && !actual.equals(after)) throw failure("修改目标含有其他更改，已保留恢复日志和原文件");
                File source = null;
                if (!after.equals("absent")) {
                    String file = row.getString("file");
                    if (!file.matches("[0-9]{1,2}\\.bin")) throw failure("恢复日志暂存名称无效");
                    source = new File(work, file);
                    if (!source.isFile() || Files.isSymbolicLink(source.toPath()) || source.length() > targetLimit(row.getString("path"))
                            || (bytes += source.length()) > MAX_PLANNED_BYTES || !digest(source).equals(after))
                        throw failure("本地修改暂存文件校验失败");
                }
                plan.put(target, source);
            }
            for (Map.Entry<File, File> entry : plan.entrySet()) {
                if (entry.getValue() == null) {
                    if (entry.getKey().exists() && !entry.getKey().delete()) throw new IOException("无法删除已确认的本地草稿文件");
                } else copyAtomic(entry.getValue(), entry.getKey());
            }
            new AtomicFile(journal).delete();
            // Targets are durable and the log has been retired. A leftover private
            // staging directory is harmless and is never treated as active data.
            try { removeOwned(work); } catch (IOException ignored) { }
        } catch (StorageException error) { throw error; }
        catch (Exception error) { throw new StorageException("EDIT_PENDING", "本地修改尚未完成，恢复日志已保留；请重试原操作", error); }
        finally { recovering = false; }
    }

    private File allowedTarget(String relative) throws Exception {
        if (relative.startsWith("/") || relative.contains("\\") || relative.contains(":")
                || relative.contains("\0") || relative.matches("(?:^|.*/)(?:\\.|\\.\\.)(?:/.*|$)")) throw failure("恢复目标路径无效");
        boolean catalog = relative.equals("library-catalog.json");
        boolean bank = relative.matches("library/[a-f0-9-]{36}/question-banks/[^/]+/[^/]+/bank\\.json");
        boolean state = relative.matches("practice/[a-f0-9-]{36}\\.json");
        boolean editor = relative.matches("editor-drafts/[a-f0-9]{64}\\.json") || relative.matches("editor-receipts/[a-f0-9-]{36}\\.json");
        boolean backup = relative.matches("edit-backups/[a-f0-9]{64}\\.json");
        if (!catalog && !bank && !state && !editor && !backup) throw failure("恢复日志包含未授权文件目标");
        File target = new File(root, relative).getCanonicalFile();
        if (!target.getPath().startsWith(root.getPath() + File.separator) || Files.isSymbolicLink(target.toPath())) throw failure("恢复目标路径越界");
        return target;
    }

    private String relative(File file) throws IOException {
        File absolute = file.getCanonicalFile();
        if (!absolute.getPath().startsWith(root.getPath() + File.separator)) throw new IOException("事务目标超出应用数据目录");
        return root.toPath().relativize(absolute.toPath()).toString().replace(File.separatorChar, '/');
    }

    private static int targetLimit(String relative) {
        if (relative.startsWith("practice/")) return BankRepository.MAX_STATE;
        if (relative.startsWith("edit-backups/")) return 40 * 1024 * 1024;
        if (relative.equals("library-catalog.json")) return 4 * 1024 * 1024;
        if (relative.startsWith("editor-")) return 2 * 1024 * 1024;
        return BankRepository.MAX_FILE;
    }

    private static String digest(File file) throws Exception {
        if (!file.exists()) return "absent";
        if (!file.isFile() || Files.isSymbolicLink(file.toPath()) || file.length() > 40L * 1024 * 1024) throw failure("恢复目标文件类型或大小异常");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[32768]; int size;
            while ((size = input.read(buffer)) != -1) digest.update(buffer, 0, size);
        }
        StringBuilder result = new StringBuilder(64);
        for (byte value : digest.digest()) result.append(String.format(Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }

    private static boolean hashOrAbsent(String value) { return value.equals("absent") || value.matches("[a-f0-9]{64}"); }
    private static void mkdir(File file) throws IOException { if (!file.isDirectory() && !file.mkdirs()) throw new IOException("无法创建事务目录"); }
    private static byte[] read(InputStream input, int max) throws IOException {
        java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[16384]; int size;
        while ((size = input.read(buffer)) != -1) { if (output.size() + size > max) throw new IOException("事务日志过大"); output.write(buffer, 0, size); }
        return output.toByteArray();
    }
    private static void write(File file, byte[] bytes) throws IOException {
        mkdir(file.getParentFile()); AtomicFile atomic = new AtomicFile(file); FileOutputStream output = null;
        try { output = atomic.startWrite(); output.write(bytes); output.getFD().sync(); atomic.finishWrite(output); }
        catch (IOException | RuntimeException error) { if (output != null) atomic.failWrite(output); throw error; }
    }
    private static void copyAtomic(File source, File target) throws IOException {
        mkdir(target.getParentFile()); AtomicFile atomic = new AtomicFile(target); FileOutputStream output = null;
        try (InputStream input = new FileInputStream(source)) {
            output = atomic.startWrite(); byte[] buffer = new byte[32768]; int size;
            while ((size = input.read(buffer)) != -1) output.write(buffer, 0, size);
            output.getFD().sync(); atomic.finishWrite(output);
        } catch (IOException | RuntimeException error) { if (output != null) atomic.failWrite(output); throw error; }
    }
    private void removeOwned(File work) throws IOException {
        if (!work.getCanonicalFile().getParentFile().equals(staging.getCanonicalFile()) || !work.getName().matches("[a-f0-9-]{36}")) throw new IOException("拒绝清理未知事务目录");
        remove(work);
    }
    private static void remove(File file) throws IOException {
        if (!file.exists()) return;
        if (file.isDirectory() && !Files.isSymbolicLink(file.toPath())) {
            File[] children = file.listFiles(); if (children == null) throw new IOException("无法读取事务暂存目录");
            for (File child : children) remove(child);
        }
        if (!file.delete()) throw new IOException("无法清理事务暂存文件");
    }
    private static StorageException failure(String message) { return new StorageException("EDIT_PENDING", message); }
}
