package cloud.treenewbee.quizforge.android;

import android.content.Context;
import android.content.ContextWrapper;
import android.util.AtomicFile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipException;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/**
 * Legacy preview compatibility: BankRepository retains startup journal recovery.
 * Current builds expose no backup import/export UI or bridge entry points.
 * Explicit local backup whitelist. Credentials and unknown files never enter the
 * archive. Restore validates a private copy, keeps a pre-restore archive, and
 * publishes directory replacements through a resumable rename journal.
 */
public final class RepositoryBackup {
    private static final String MANIFEST = "quizforge-backup.json";
    private static final long MAX_ARCHIVE = 512L * 1024 * 1024;
    private static final long MAX_EXPANDED = 1024L * 1024 * 1024;
    private static final int MAX_FILE = 128 * 1024 * 1024;
    private static final int MAX_ENTRIES = 50000;
    private static final int MAX_MANIFEST = 16 * 1024 * 1024;
    private static final String[] PATHS = {"library", "practice", "author-resources", "editor-drafts", "editor-receipts",
            "edit-backups", "version-key.bin", "local-services/exam", "library-catalog.json"};
    private final Context context;
    private final File root;
    private final File privateRoot;
    private final File tickets;
    private final File previous;
    private final File journal;

    public RepositoryBackup(Context context) throws Exception {
        this.context = context;
        this.root = context.getFilesDir().getCanonicalFile();
        this.privateRoot = privateDirectory(context);
        this.tickets = new File(privateRoot, "tickets"); mkdir(tickets);
        this.previous = new File(privateRoot, "previous"); mkdir(previous);
        this.journal = new File(privateRoot, "restore-journal.json");
    }

    public synchronized JSONObject exportBackup(BankRepository repository, OutputStream output) throws Exception {
        requireRoot(repository);
        if (output == null) throw failure("INVALID_REQUEST", "没有可写入的备份目标");
        synchronized (repository) {
            repository.transactions.recover();
            File work = new File(tickets, UUID.randomUUID().toString()); mkdir(work);
            try {
                File archive = new File(work, "export.qfbackup");
                JSONObject metadata = buildArchive(root, archive);
                try (InputStream input = new FileInputStream(archive)) { copy(input, output, MAX_ARCHIVE); output.flush(); }
                return metadata.put("name", "QuizForge-" + System.currentTimeMillis() + ".qfbackup").put("size", archive.length()).put("containsCredentials", false);
            } finally { removeOwned(work, tickets); }
        }
    }

    /** Read-only preparation. No active library or saved practice is replaced. */
    public synchronized JSONObject inspectBackup(BankRepository repository, InputStream input, String filename) throws Exception {
        requireRoot(repository);
        if (input == null || filename == null || filename.length() > 1000 || !filename.toLowerCase(Locale.ROOT).endsWith(".qfbackup"))
            throw failure("INVALID_BACKUP", "请选择 .qfbackup 完整备份文件");
        String id = UUID.randomUUID().toString(); File ticket = new File(tickets, id); mkdir(ticket);
        boolean keep = false;
        try {
            File archive = new File(ticket, "incoming.qfbackup");
            try (FileOutputStream output = new FileOutputStream(archive)) { copy(input, output, MAX_ARCHIVE); output.getFD().sync(); }
            File staged = new File(ticket, "new"); mkdir(staged);
            JSONObject manifest = extract(archive, staged);
            BankRepository candidate = new BankRepository(stagedContext(staged));
            candidate.setImportValidator(repository.importValidator());
            JSONObject summary = candidate.validateBackupRoot();
            JSONObject ticketValue = new JSONObject().put("schemaVersion", 1).put("restoreId", id).put("createdAt", System.currentTimeMillis())
                    .put("backupCreatedAt", manifest.getLong("createdAt")).put("summary", summary)
                    .put("treeHash", treeHash(staged)).put("archiveHash", fileHash(archive));
            write(new File(ticket, "ticket.json"), bytes(ticketValue));
            keep = true;
            return summary.put("restoreId", id).put("createdAt", manifest.getLong("createdAt"))
                    .put("requiresReplace", true).put("containsCredentials", false).put("fileCount", manifest.getJSONArray("files").length());
        } finally { if (!keep) removeOwned(ticket, tickets); }
    }

    /** Caller pauses domain/AI/exam writes and reopens its repositories after success. */
    public synchronized JSONObject restoreBackup(BankRepository current, String restoreId) throws Exception {
        requireRoot(current);
        if (restoreId == null || !restoreId.matches("[a-f0-9-]{36}")) throw failure("INVALID_BACKUP", "恢复任务标识无效");
        synchronized (current) {
            recoverPending(context);
            current.transactions.recover();
            File ticket = new File(tickets, restoreId).getCanonicalFile();
            if (!ticket.getParentFile().equals(tickets.getCanonicalFile())) throw failure("INVALID_BACKUP", "恢复任务路径无效");
            JSONObject metadata = readJson(new File(ticket, "ticket.json"), 1024 * 1024);
            if (metadata.optInt("schemaVersion") != 1 || !restoreId.equals(metadata.optString("restoreId"))) throw failure("INVALID_BACKUP", "恢复任务记录无效");
            File staged = new File(ticket, "new");
            if (!treeHash(staged).equals(metadata.getString("treeHash"))) throw failure("BACKUP_CHANGED", "备份暂存内容已变化，原数据未替换，请重新选择备份");
            BankRepository candidate = new BankRepository(stagedContext(staged)); candidate.setImportValidator(current.importValidator());
            JSONObject summary = candidate.validateBackupRoot();
            String priorName = "before-restore-" + System.currentTimeMillis() + "-" + UUID.randomUUID() + ".qfbackup";
            File priorArchive = new File(previous, priorName);
            buildArchive(root, priorArchive); // Durable local backup before the first active-data rename.
            File rollback = new File(ticket, "old"); mkdir(rollback);
            JSONArray operations = new JSONArray();
            for (String path : PATHS) operations.put(new JSONObject().put("path", path)
                    .put("before", hashOrAbsent(new File(root, path))).put("after", hashOrAbsent(new File(staged, path))));
            // Saved AI task generations belong to the pre-restore state. Quarantine
            // them without reading or deleting the encrypted provider profile.
            operations.put(new JSONObject().put("path", "local-services/ai-task")
                    .put("before", hashOrAbsent(new File(root, "local-services/ai-task"))).put("after", "absent"));
            JSONObject planned = new JSONObject().put("schemaVersion", 1).put("restoreId", restoreId)
                    .put("previousBackup", priorName).put("operations", operations);
            write(journal, bytes(planned));
            recoverPending(context);
            return new JSONObject().put("restored", true).put("restartRequired", true).put("summary", summary)
                    .put("previousBackup", new JSONObject().put("name", priorName).put("size", priorArchive.length()).put("path", priorArchive.getAbsolutePath()))
                    .put("containsCredentials", false);
        }
    }

    /** Cancel a prepared inspection, retaining all active or completed restore evidence. */
    public synchronized JSONObject discardInspection(String restoreId) throws Exception {
        if (restoreId == null || !restoreId.matches("[a-f0-9-]{36}")) throw failure("INVALID_BACKUP", "恢复任务标识无效");
        if (journal.exists() || new File(journal.getPath() + ".bak").exists())
            throw failure("RESTORE_PENDING", "恢复任务已经开始，不能清理其恢复文件");
        File ticket = new File(tickets, restoreId);
        if (!ticket.exists()) return new JSONObject().put("discarded", false);
        if (!ticket.getCanonicalFile().getParentFile().equals(tickets.getCanonicalFile()) || Files.isSymbolicLink(ticket.toPath()))
            throw failure("INVALID_BACKUP", "恢复任务路径无效");
        if (new File(ticket, "old").exists() || new File(ticket, "completed.json").exists())
            throw failure("RESTORE_COMPLETED", "恢复后的旧数据和本地备份会保留，不能按取消任务清理");
        JSONObject metadata = readJson(new File(ticket, "ticket.json"), 1024 * 1024);
        if (metadata.optInt("schemaVersion") != 1 || !restoreId.equals(metadata.optString("restoreId")))
            throw failure("INVALID_BACKUP", "恢复任务记录无效，文件已保留");
        removeOwned(ticket, tickets);
        return new JSONObject().put("discarded", true);
    }

    /** Runs before BankRepository opens data, including after process death. */
    public static synchronized void recoverPending(Context context) throws Exception {
        File root = context.getFilesDir().getCanonicalFile(), privateRoot = privateDirectory(context);
        File journal = new File(privateRoot, "restore-journal.json");
        if (!journal.exists() && !new File(journal.getPath() + ".bak").exists()) return;
        try {
            JSONObject plan;
            try (InputStream input = new AtomicFile(journal).openRead()) { plan = new JSONObject(new String(read(input, 256 * 1024), StandardCharsets.UTF_8)); }
            String id = plan.optString("restoreId"); JSONArray operations = plan.optJSONArray("operations");
            if (plan.optInt("schemaVersion") != 1 || !id.matches("[a-f0-9-]{36}") || operations == null || operations.length() != PATHS.length + 1)
                throw failure("RESTORE_PENDING", "恢复日志无效，原数据和恢复文件已保留");
            File ticket = new File(privateRoot, "tickets/" + id), staged = new File(ticket, "new"), rollback = new File(ticket, "old");
            if (!ticket.getCanonicalFile().getParentFile().equals(new File(privateRoot, "tickets").getCanonicalFile())) throw failure("RESTORE_PENDING", "恢复任务路径越界");
            Set<String> seen = new HashSet<>();
            // Verify every target before performing any more renames.
            for (int i = 0; i < operations.length(); i++) {
                JSONObject row = operations.getJSONObject(i); String path = row.getString("path");
                if (!allowedSwitch(path) || !seen.add(path)) throw failure("RESTORE_PENDING", "恢复日志包含未授权路径");
                String before = row.getString("before"), after = row.getString("after");
                if (!validHash(before) || !validHash(after)) throw failure("RESTORE_PENDING", "恢复日志校验值无效");
                String targetHash = hashOrAbsent(new File(root, path)), oldHash = hashOrAbsent(new File(rollback, path)), newHash = hashOrAbsent(new File(staged, path));
                boolean oldAvailable = before.equals("absent") || oldHash.equals(before) || targetHash.equals(before);
                boolean newAvailable = after.equals("absent") || newHash.equals(after) || targetHash.equals(after);
                boolean targetAllowed = targetHash.equals("absent") || targetHash.equals(before) || targetHash.equals(after);
                if (!oldAvailable || !newAvailable || !targetAllowed || !oldHash.equals("absent") && !oldHash.equals(before)
                        || !newHash.equals("absent") && !newHash.equals(after))
                    throw failure("RESTORE_PENDING", "恢复目标含有其他更改，已保留原数据、旧备份和恢复日志");
            }
            for (int i = 0; i < operations.length(); i++) {
                JSONObject row = operations.getJSONObject(i); String path = row.getString("path"), before = row.getString("before"), after = row.getString("after");
                File target = new File(root, path), old = new File(rollback, path), incoming = new File(staged, path);
                String actual = hashOrAbsent(target);
                if (actual.equals(after) && !after.equals("absent")) continue;
                if (!before.equals("absent") && actual.equals(before) && !old.exists()) rename(target, old);
                if (!after.equals("absent") && !target.exists()) rename(incoming, target);
                if (!hashOrAbsent(target).equals(after)) throw failure("RESTORE_PENDING", "本地恢复尚未完成，恢复文件已保留");
            }
            new AtomicFile(journal).delete();
            try {
                write(new File(ticket, "completed.json"), bytes(new JSONObject().put("restoredAt", System.currentTimeMillis()).put("previousBackup", plan.getString("previousBackup"))));
            } catch (Exception ignored) { /* The verified data switch is already durable and complete. */ }
            // Rollback trees and before-restore archives stay private and intact.
        } catch (StorageException exception) { throw exception; }
        catch (Exception exception) { throw new StorageException("RESTORE_PENDING", "恢复尚未完成，原数据与本地备份已保留；请重新打开应用重试", exception); }
    }

    private JSONObject buildArchive(File source, File target) throws Exception {
        if (new File(source, "repository-transaction.json").exists()) throw failure("EDIT_PENDING", "存在尚未完成的编辑事务，请先重开应用完成恢复");
        Map<String, File> files = new LinkedHashMap<>(); long[] total = {0};
        for (String path : PATHS) { File item = new File(source, path); if (item.exists()) inventory(source, item, files, total); }
        if (!files.containsKey("library-catalog.json")) {
            // An empty installation still has a complete, explicit library identity.
            BankRepository.atomicWrite(new File(source, "library-catalog.json"), bytes(new JSONObject().put("schemaVersion", 1)
                    .put("banks", new JSONArray()).put("groups", new JSONArray()).put("trash", new JSONArray()).put("revision", 0)));
            inventory(source, new File(source, "library-catalog.json"), files, total);
        }
        JSONArray manifestFiles = new JSONArray(); Map<String, String> hashes = new LinkedHashMap<>();
        for (Map.Entry<String, File> entry : files.entrySet()) {
            String hash = fileHash(entry.getValue()); hashes.put(entry.getKey(), hash);
            manifestFiles.put(new JSONObject().put("path", entry.getKey()).put("size", entry.getValue().length()).put("sha256", hash));
        }
        JSONObject manifest = new JSONObject().put("format", "quizforge-android-backup").put("formatVersion", 1)
                .put("createdAt", System.currentTimeMillis()).put("containsCredentials", false).put("files", manifestFiles);
        byte[] encoded = bytes(manifest); if (encoded.length > MAX_MANIFEST) throw failure("BACKUP_LIMIT", "备份清单超过大小上限");
        boolean success = false;
        try (FileOutputStream output = new FileOutputStream(target); ZipOutputStream zip = new ZipOutputStream(output, StandardCharsets.UTF_8)) {
            zip.putNextEntry(new ZipEntry(MANIFEST)); zip.write(encoded); zip.closeEntry();
            for (Map.Entry<String, File> entry : files.entrySet()) {
                if (!fileHash(entry.getValue()).equals(hashes.get(entry.getKey()))) throw failure("BACKUP_CHANGED", "备份期间本地数据发生变化，请保存后重新导出");
                zip.putNextEntry(new ZipEntry("data/" + entry.getKey()));
                try (InputStream input = new FileInputStream(entry.getValue())) { copy(input, zip, MAX_FILE); }
                zip.closeEntry();
                if (!fileHash(entry.getValue()).equals(hashes.get(entry.getKey()))) throw failure("BACKUP_CHANGED", "备份期间本地数据发生变化，请保存后重新导出");
            }
            zip.finish(); zip.flush(); output.getFD().sync();
            if (target.length() > MAX_ARCHIVE) throw failure("BACKUP_LIMIT", "完整备份超过 512 MiB，请先分批备份题库");
            success = true;
        } finally { if (!success && target.exists()) target.delete(); }
        return new JSONObject().put("createdAt", manifest.getLong("createdAt")).put("fileCount", files.size()).put("expandedSize", total[0]);
    }

    private static JSONObject extract(File archive, File staged) throws Exception {
        verifyDirectory(archive);
        Set<String> paths = new HashSet<>(); JSONObject manifest;
        try (ZipFile zip = new ZipFile(archive, StandardCharsets.UTF_8)) {
            ZipEntry marker = zip.getEntry(MANIFEST);
            if (marker == null || marker.getSize() > MAX_MANIFEST) throw failure("INVALID_BACKUP", "备份缺少格式清单");
            try (InputStream input = zip.getInputStream(marker)) { manifest = new JSONObject(new String(read(input, MAX_MANIFEST), StandardCharsets.UTF_8)); }
            if (!manifest.optString("format").equals("quizforge-android-backup") || manifest.optInt("formatVersion") != 1
                    || manifest.optBoolean("containsCredentials", true) || manifest.optLong("createdAt", -1) < 0 || manifest.optJSONArray("files") == null)
                throw failure("INVALID_BACKUP", "备份格式不受支持");
            JSONArray listed = manifest.getJSONArray("files");
            if (listed.length() == 0 || listed.length() > MAX_ENTRIES - 1) throw failure("BACKUP_LIMIT", "备份文件数量超过上限");
            Map<String, JSONObject> expected = new LinkedHashMap<>();
            for (int i = 0; i < listed.length(); i++) {
                JSONObject row = listed.getJSONObject(i); String path = row.getString("path");
                validatePath(path); if (!allowedFile(path) || expected.containsKey(path) || row.getLong("size") < 0 || row.getLong("size") > MAX_FILE || !row.getString("sha256").matches("[a-f0-9]{64}"))
                    throw failure("INVALID_BACKUP", "备份清单包含无效或未授权文件");
                expected.put(path, row);
            }
            long total = 0; int count = 0; Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement(); if (++count > MAX_ENTRIES) throw failure("BACKUP_LIMIT", "备份文件数量超过上限");
                String raw = entry.getName();
                if (!paths.add(raw.toLowerCase(Locale.ROOT))) throw failure("INVALID_BACKUP", "备份包含重复路径");
                if (raw.equals(MANIFEST)) continue;
                if (entry.isDirectory() || !raw.startsWith("data/")) throw failure("INVALID_BACKUP", "备份包含未知条目");
                String path = raw.substring(5); validatePath(path); JSONObject row = expected.remove(path);
                if (row == null || entry.getSize() != row.getLong("size") || (total += entry.getSize()) > MAX_EXPANDED)
                    throw failure("INVALID_BACKUP", "备份条目与清单不一致或超过大小上限");
                File target = new File(staged, path); mkdir(target.getParentFile());
                CRC32 crc = new CRC32(); MessageDigest digest = MessageDigest.getInstance("SHA-256"); long size = 0;
                try (InputStream input = zip.getInputStream(entry); FileOutputStream output = new FileOutputStream(target)) {
                    byte[] buffer = new byte[32768]; int read;
                    while ((read = input.read(buffer)) != -1) { if ((size += read) > MAX_FILE || size > row.getLong("size")) throw failure("BACKUP_LIMIT", "备份解压文件超过上限"); crc.update(buffer, 0, read); digest.update(buffer, 0, read); output.write(buffer, 0, read); }
                    output.getFD().sync();
                }
                if (size != row.getLong("size") || crc.getValue() != entry.getCrc() || !hex(digest.digest()).equals(row.getString("sha256"))) throw failure("INVALID_BACKUP", "备份文件长度、CRC 或 SHA-256 校验失败");
            }
            if (!expected.isEmpty() || !new File(staged, "library-catalog.json").isFile() || !new File(staged, "version-key.bin").isFile())
                throw failure("INVALID_BACKUP", "备份缺少目录、版本密钥或声明文件");
        } catch (ZipException exception) {
            // Android's safe ZIP path validator may reject a malicious entry as
            // soon as ZipFile opens. Keep that protection and expose our stable
            // domain error without leaking the archive's raw path/message.
            throw new StorageException("INVALID_BACKUP", "备份 ZIP 损坏或包含不安全路径，当前本地数据未修改", exception);
        }
        return manifest;
    }

    private Context stagedContext(File staged) {
        return new ContextWrapper(context) {
            @Override public File getFilesDir() { return staged; }
            @Override public File getNoBackupFilesDir() { return new File(staged.getParentFile(), "validation-private"); }
        };
    }
    private void requireRoot(BankRepository repository) throws Exception { if (repository == null || !repository.getDataRoot().getCanonicalFile().equals(root)) throw failure("INVALID_REQUEST", "备份仓库与当前应用目录不一致"); }
    private static File privateDirectory(Context context) throws Exception {
        File data = context.getFilesDir().getCanonicalFile();
        String identity = BankRepository.sha256(data.getPath().getBytes(StandardCharsets.UTF_8)).substring(0, 24);
        File folder = new File(context.getNoBackupFilesDir(), "quizforge-backups/" + identity); mkdir(folder);
        if (Files.isSymbolicLink(folder.toPath())) throw failure("BACKUP_UNAVAILABLE", "备份工作目录包含链接");
        return folder.getCanonicalFile();
    }
    private static void inventory(File root, File item, Map<String, File> files, long[] total) throws Exception {
        if (Files.isSymbolicLink(item.toPath())) throw failure("BACKUP_UNAVAILABLE", "备份白名单包含链接，原文件未改动");
        if (item.isDirectory()) { File[] children = item.listFiles(); if (children == null) throw new IOException("无法读取备份目录"); Arrays.sort(children, (a,b)->a.getName().compareTo(b.getName())); for (File child : children) inventory(root, child, files, total); }
        else {
            String path = root.toPath().relativize(item.toPath()).toString().replace(File.separatorChar, '/');
            if (!allowedFile(path)) throw failure("BACKUP_UNAVAILABLE", "备份白名单中出现未知文件，原数据已保留");
            if (item.length() > MAX_FILE || (total[0] += item.length()) > MAX_EXPANDED || files.size() >= MAX_ENTRIES - 1) throw failure("BACKUP_LIMIT", "完整备份超过文件数量或大小上限");
            files.put(path, item);
        }
    }
    private static boolean allowedFile(String path) {
        if (path.equals("library-catalog.json") || path.equals("version-key.bin")) return true;
        for (String prefix : new String[]{"library/", "practice/", "author-resources/", "editor-drafts/", "editor-receipts/", "edit-backups/", "local-services/exam/"}) if (path.startsWith(prefix)) return !path.contains("/.state/") && !path.endsWith(".bak") && !path.endsWith(".new");
        return false;
    }
    private static boolean allowedSwitch(String path) { return Arrays.asList(PATHS).contains(path) || path.equals("local-services/ai-task"); }
    private static void validatePath(String path) throws Exception {
        if (path.isEmpty() || path.length() > 4096 || path.startsWith("/") || path.split("/", -1).length > 40) throw failure("INVALID_BACKUP", "备份路径无效");
        for (String part : path.split("/", -1)) BankRepository.validSegment(part);
    }
    private static String hashOrAbsent(File file) throws Exception { return file.exists() ? treeHash(file) : "absent"; }
    private static boolean validHash(String value) { return value.equals("absent") || value.matches("[a-f0-9]{64}"); }
    private static String treeHash(File item) throws Exception {
        if (Files.isSymbolicLink(item.toPath())) throw failure("BACKUP_UNAVAILABLE", "恢复目录包含链接");
        if (item.isFile()) return fileHash(item);
        if (!item.isDirectory()) throw failure("BACKUP_UNAVAILABLE", "恢复目录缺失");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        treeDigest(item, item, digest, new int[]{0}); return hex(digest.digest());
    }
    private static void treeDigest(File base, File directory, MessageDigest digest, int[] count) throws Exception {
        File[] children = directory.listFiles(); if (children == null) throw new IOException("无法读取恢复目录"); Arrays.sort(children, (a,b)->a.getName().compareTo(b.getName()));
        for (File item : children) {
            if (++count[0] > MAX_ENTRIES * 2 || Files.isSymbolicLink(item.toPath())) throw failure("BACKUP_LIMIT", "恢复目录条目无效或过多");
            String path = base.toPath().relativize(item.toPath()).toString().replace(File.separatorChar, '/');
            digest.update((path + (item.isDirectory() ? "/\n" : ":" + item.length() + ":" + fileHash(item) + "\n")).getBytes(StandardCharsets.UTF_8));
            if (item.isDirectory()) treeDigest(base, item, digest, count);
        }
    }
    private static String fileHash(File file) throws Exception {
        if (!file.isFile() || file.length() > MAX_ARCHIVE || Files.isSymbolicLink(file.toPath())) throw failure("BACKUP_LIMIT", "备份文件缺失、包含链接或超过大小上限");
        MessageDigest digest = MessageDigest.getInstance("SHA-256"); try (InputStream input = new FileInputStream(file)) { byte[] buffer = new byte[32768]; int size; while ((size = input.read(buffer)) != -1) digest.update(buffer, 0, size); } return hex(digest.digest());
    }
    private static JSONObject readJson(File file, int max) throws Exception { try (InputStream input = new FileInputStream(file)) { return new JSONObject(new String(read(input, max), StandardCharsets.UTF_8)); } }
    private static byte[] read(InputStream input, int max) throws Exception { ByteArrayOutputStream output = new ByteArrayOutputStream(); copy(input, output, max); return output.toByteArray(); }
    private static void copy(InputStream input, OutputStream output, long max) throws Exception { long count = 0; byte[] buffer = new byte[32768]; int size; while ((size = input.read(buffer)) != -1) { if ((count += size) > max) throw failure("BACKUP_LIMIT", "备份超过大小上限"); output.write(buffer, 0, size); } }
    private static void write(File file, byte[] bytes) throws Exception { BankRepository.atomicWrite(file, bytes); }
    private static void mkdir(File file) throws IOException { if (!file.isDirectory() && !file.mkdirs()) throw new IOException("无法创建本地备份目录"); }
    private static void rename(File source, File target) throws Exception { mkdir(target.getParentFile()); if (target.exists() || !source.renameTo(target)) throw failure("RESTORE_PENDING", "无法完成本地恢复切换，原数据和恢复日志已保留"); }
    private static void removeOwned(File work, File base) throws Exception { if (!work.getCanonicalFile().getParentFile().equals(base.getCanonicalFile()) || !work.getName().matches("[a-f0-9-]{36}")) throw new IOException("拒绝清理未知备份目录"); remove(work); }
    private static void remove(File file) throws IOException { if (!file.exists()) return; if (file.isDirectory() && !Files.isSymbolicLink(file.toPath())) { File[] children = file.listFiles(); if (children == null) throw new IOException("无法读取备份暂存目录"); for (File child : children) remove(child); } if (!file.delete()) throw new IOException("无法清理备份暂存文件"); }
    private static String hex(byte[] bytes) { StringBuilder result = new StringBuilder(64); for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 255)); return result.toString(); }
    private static byte[] bytes(JSONObject value) { return value.toString().getBytes(StandardCharsets.UTF_8); }
    private static StorageException failure(String code, String message) { return new StorageException(code, message); }

    private static void verifyDirectory(File file) throws Exception {
        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
            long length = input.length(); if (length < 22 || length > MAX_ARCHIVE) throw failure("BACKUP_LIMIT", "备份不是有效 ZIP 或超过 512 MiB");
            int tailSize = (int)Math.min(length, 65557); byte[] tail = new byte[tailSize]; input.seek(length-tailSize); input.readFully(tail); int end = -1;
            for (int i = tailSize-22; i >= 0; i--) if (u32(tail,i)==0x06054b50L && i+22+u16(tail,i+20)==tailSize) { end=i; break; }
            if (end < 0 || u16(tail,end+4)!=0 || u16(tail,end+6)!=0) throw failure("INVALID_BACKUP", "备份 ZIP 目录无效或为多卷压缩");
            int count=u16(tail,end+10); long size=u32(tail,end+12), offset=u32(tail,end+16);
            if (count!=u16(tail,end+8)||count>MAX_ENTRIES||count==65535||offset+size!=length-tailSize+end) throw failure("INVALID_BACKUP", "备份条目数量或目录位置无效");
            input.seek(offset);
            for(int i=0;i<count;i++) { byte[] header=new byte[46]; input.readFully(header); int mode=(int)((u32(header,38)>>>16)&0xf000);
                if(u32(header,0)!=0x02014b50L||(u16(header,8)&1)!=0||u16(header,34)!=0||(mode!=0&&mode!=0x8000)||u32(header,20)==0xffffffffL||u32(header,24)==0xffffffffL||u32(header,42)==0xffffffffL) throw failure("INVALID_BACKUP", "备份包含链接、加密文件、目录项或 ZIP64");
                int name=u16(header,28),extra=u16(header,30),comment=u16(header,32); if(name==0||name>4096) throw failure("INVALID_BACKUP", "备份条目路径无效"); input.seek(input.getFilePointer()+name+extra+comment); if(input.getFilePointer()>offset+size)throw failure("INVALID_BACKUP", "备份目录越界"); }
            if(input.getFilePointer()!=offset+size)throw failure("INVALID_BACKUP", "备份目录长度不一致");
        }
    }
    private static int u16(byte[] bytes,int offset){return(bytes[offset]&255)|((bytes[offset+1]&255)<<8);}
    private static long u32(byte[] bytes,int offset){return((long)u16(bytes,offset))|((long)u16(bytes,offset+2)<<16);}
}
