package cloud.treenewbee.quizforge.android;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.ContextWrapper;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Backup tests use isolated generated data and a private no_backup directory. */
@RunWith(AndroidJUnit4.class)
public final class RepositoryBackupTest {
    private File testRoot;
    private File files;
    private File noBackup;
    private Context context;
    private BankRepository repository;
    private RepositoryBackup backup;

    @Before public void setup() throws Exception {
        Context app = ApplicationProvider.getApplicationContext();
        File base = new File(app.getCacheDir(), "repository-backup-instrumentation"); assertTrue(base.isDirectory() || base.mkdirs());
        testRoot = new File(base, UUID.randomUUID().toString()); assertTrue(testRoot.mkdir());
        files = new File(testRoot, "files"); assertTrue(files.mkdir()); noBackup = new File(testRoot, "no_backup"); assertTrue(noBackup.mkdir());
        context = new ContextWrapper(app) { @Override public File getFilesDir() { return files; } @Override public File getNoBackupFilesDir() { return noBackup; } };
        repository = instance(); backup = new RepositoryBackup(context);
    }
    @After public void cleanup() throws Exception { assertEquals("repository-backup-instrumentation", testRoot.getCanonicalFile().getParentFile().getName()); remove(testRoot); }

    @Test public void exportedBackupContainsWhitelistedHistoryAndExcludesCredentialsAndUnknownFiles() throws Exception {
        String id = imported(); repository.writeState(id, state(), 0);
        Files.write(new File(files, "ai-profile.enc").toPath(), utf8("never-export-this-key"));
        Files.write(new File(files, "unknown-private.json").toPath(), utf8("do-not-export"));
        File exam = new File(files, "local-services/exam/attempt.json"); assertTrue(exam.getParentFile().mkdirs());
        Files.write(exam.toPath(), utf8("{\"schemaVersion\":1,\"revision\":1,\"paper\":\"frozen\"}"));
        Map<String, byte[]> archive = unzip(export());
        assertTrue(archive.containsKey("data/practice/" + id + ".json"));
        assertTrue(archive.containsKey("data/local-services/exam/attempt.json"));
        assertTrue(archive.containsKey("data/version-key.bin"));
        for (String path : archive.keySet()) { assertFalse(path.contains("ai-profile")); assertFalse(path.contains("unknown-private")); assertFalse(path.contains("staging")); }
        JSONObject marker = new JSONObject(new String(archive.get("quizforge-backup.json"), StandardCharsets.UTF_8)); assertFalse(marker.getBoolean("containsCredentials"));
        assertEquals("never-export-this-key", new String(Files.readAllBytes(new File(files, "ai-profile.enc").toPath()), StandardCharsets.UTF_8));
    }

    @Test public void inspectFullyValidatesStagingWithoutReplacingCurrentLibrary() throws Exception {
        String first = imported(); byte[] saved = export(); String second = imported();
        JSONObject inspection = backup.inspectBackup(repository, new ByteArrayInputStream(saved), "full.qfbackup");
        assertEquals(1, inspection.getInt("banks")); assertTrue(inspection.getBoolean("requiresReplace"));
        assertEquals(2, repository.listBanks().length()); assertEquals(second, repository.listBanks().getJSONObject(1).getString("id"));
        assertNotNull(repository.readBank(first)); assertFalse(new File(files, "restore-journal.json").exists());
    }

    @Test public void tamperedFileHashTraversalAndUnexpectedCredentialEntryAreRejectedBeforeRestore() throws Exception {
        imported(); Map<String, byte[]> archive = unzip(export());
        archive.put("data/library-catalog.json", utf8("{}")); byte[] tampered = BankRepositoryTest.zip(archive);
        assertCode("INVALID_BACKUP", () -> backup.inspectBackup(repository, new ByteArrayInputStream(tampered), "tampered.qfbackup"));
        archive = unzip(export()); archive.put("data/../outside", utf8("escape")); byte[] traversal = BankRepositoryTest.zip(archive);
        assertCode("INVALID_BACKUP", () -> backup.inspectBackup(repository, new ByteArrayInputStream(traversal), "traversal.qfbackup"));
        archive = unzip(export()); archive.put("data/ai-profile.enc", utf8("untrusted")); byte[] credentials = BankRepositoryTest.zip(archive);
        assertCode("INVALID_BACKUP", () -> backup.inspectBackup(repository, new ByteArrayInputStream(credentials), "credentials.qfbackup"));
        assertEquals(1, repository.listBanks().length()); assertFalse(new File(files.getParentFile(), "outside").exists());
    }

    @Test public void restoreKeepsPreRestoreArchiveAndProviderKeyWhileRestoringPracticeAndTrash() throws Exception {
        String original = imported(); repository.writeState(original, state(), 0);
        JSONObject deleted = repository.changeLibrary(new JSONObject().put("kind", "bank").put("action", "delete").put("target", "item").put("bankId", original));
        byte[] saved = export(); String later = imported();
        Files.write(new File(files, "ai-profile.enc").toPath(), utf8("device-key-is-kept"));
        Files.write(new File(files, "unknown.keep").toPath(), utf8("unknown-kept"));
        File tasks = new File(files, "local-services/ai-task/old.json"); assertTrue(tasks.getParentFile().mkdirs()); Files.write(tasks.toPath(), utf8("{\"task\":\"stale\"}"));
        JSONObject prepared = backup.inspectBackup(repository, new ByteArrayInputStream(saved), "restore.qfbackup");
        JSONObject restored = backup.restoreBackup(repository, prepared.getString("restoreId")); assertTrue(restored.getBoolean("restored")); assertTrue(restored.getBoolean("restartRequired"));
        repository = instance(); assertEquals(0, repository.listBanks().length()); assertEquals(1, repository.listTrash().length());
        assertCode("BANK_NOT_FOUND", () -> repository.readBank(later));
        repository.restoreTrash(deleted.getString("trashId")); assertEquals("history-unchanged", repository.readState(original).getJSONArray("history").getJSONObject(0).getString("id"));
        assertEquals("device-key-is-kept", new String(Files.readAllBytes(new File(files, "ai-profile.enc").toPath()), StandardCharsets.UTF_8));
        assertEquals("unknown-kept", new String(Files.readAllBytes(new File(files, "unknown.keep").toPath()), StandardCharsets.UTF_8)); assertFalse(tasks.exists());
        File previous = new File(restored.getJSONObject("previousBackup").getString("path")); assertTrue(previous.isFile());
        Map<String, byte[]> old = unzip(Files.readAllBytes(previous.toPath()));
        JSONObject oldCatalog = new JSONObject(new String(old.get("data/library-catalog.json"), StandardCharsets.UTF_8)); assertEquals(later, oldCatalog.getJSONArray("banks").getJSONObject(0).getString("id"));
    }

    @Test public void interruptedRenameSwitchRecoversBeforeRepositoryLoads() throws Exception {
        String original = imported(); byte[] saved = export(); imported();
        JSONObject prepared = backup.inspectBackup(repository, new ByteArrayInputStream(saved), "interrupted.qfbackup");
        File ticket = ticket(prepared.getString("restoreId")); File staged = new File(ticket, "new"), old = new File(ticket, "old"); assertTrue(old.mkdir());
        JSONObject journal = simulatedJournal(prepared.getString("restoreId"), staged);
        Files.write(new File(privateRoot(), "restore-journal.json").toPath(), utf8(journal.toString()));
        assertTrue(new File(files, "library").renameTo(new File(old, "library"))); // Process dies after first old-data rename.
        repository = instance(); assertEquals(1, repository.listBanks().length()); assertEquals(original, repository.listBanks().getJSONObject(0).getString("id"));
        assertFalse(new File(privateRoot(), "restore-journal.json").exists()); assertTrue(new File(old, "library").isDirectory());
    }

    @Test public void conflictingStagedOrActiveBytesNeverOverwriteOriginalFiles() throws Exception {
        imported(); byte[] saved = export();
        JSONObject prepared = backup.inspectBackup(repository, new ByteArrayInputStream(saved), "conflict.qfbackup");
        File ticket = ticket(prepared.getString("restoreId")); Files.write(new File(ticket, "new/library-catalog.json").toPath(), utf8("{}"));
        String before = new String(Files.readAllBytes(new File(files, "library-catalog.json").toPath()), StandardCharsets.UTF_8);
        assertCode("BACKUP_CHANGED", () -> backup.restoreBackup(repository, prepared.getString("restoreId")));
        assertEquals(before, new String(Files.readAllBytes(new File(files, "library-catalog.json").toPath()), StandardCharsets.UTF_8));
    }

    @Test public void cancelReleasesOnlyPreparedTicketAndRefusesCompletedRestoreEvidence() throws Exception {
        imported(); byte[] saved = export();
        String cancelled = backup.inspectBackup(repository, new ByteArrayInputStream(saved), "cancel.qfbackup").getString("restoreId");
        assertTrue(ticket(cancelled).isDirectory()); assertTrue(backup.discardInspection(cancelled).getBoolean("discarded")); assertFalse(ticket(cancelled).exists());
        assertEquals(1, repository.listBanks().length());
        String active = backup.inspectBackup(repository, new ByteArrayInputStream(saved), "restore.qfbackup").getString("restoreId");
        JSONObject restored = backup.restoreBackup(repository, active);
        assertCode("RESTORE_COMPLETED", () -> backup.discardInspection(active));
        assertTrue(new File(restored.getJSONObject("previousBackup").getString("path")).isFile()); assertTrue(new File(ticket(active), "old").isDirectory());
    }

    private JSONObject simulatedJournal(String id, File staged) throws Exception {
        Field fields = RepositoryBackup.class.getDeclaredField("PATHS"); fields.setAccessible(true); String[] paths = (String[])fields.get(null);
        Method hash = RepositoryBackup.class.getDeclaredMethod("hashOrAbsent", File.class); hash.setAccessible(true);
        JSONArray rows = new JSONArray();
        for (String path : paths) rows.put(new JSONObject().put("path", path).put("before", hash.invoke(null, new File(files, path))).put("after", hash.invoke(null, new File(staged, path))));
        rows.put(new JSONObject().put("path", "local-services/ai-task").put("before", "absent").put("after", "absent"));
        return new JSONObject().put("schemaVersion", 1).put("restoreId", id).put("previousBackup", "synthetic-pre-restore.qfbackup").put("operations", rows);
    }
    private File privateRoot() throws Exception { Field field = RepositoryBackup.class.getDeclaredField("privateRoot"); field.setAccessible(true); return (File)field.get(backup); }
    private File ticket(String id) throws Exception { return new File(privateRoot(), "tickets/" + id); }
    private byte[] export() throws Exception { ByteArrayOutputStream output = new ByteArrayOutputStream(); backup.exportBackup(repository, output); return output.toByteArray(); }
    private String imported() throws Exception { return repository.importPackage(new ByteArrayInputStream(BankRepositoryTest.zip(BankRepositoryTest.fixtureFiles())), "Demo.qbank").getJSONArray("banks").getJSONObject(0).getString("id"); }
    private BankRepository instance() throws Exception { BankRepository value = new BankRepository(context); value.setImportValidator((extension, questions) -> {}); return value; }
    private static JSONObject state() throws Exception { return new JSONObject().put("schemaVersion", 1).put("revision", 0).put("questions", new JSONObject()).put("ink", new JSONObject())
            .put("history", new JSONArray().put(new JSONObject().put("id", "history-unchanged"))).put("roundId", "round").put("finished", false); }
    private static Map<String, byte[]> unzip(byte[] bytes) throws Exception {
        Map<String, byte[]> files = new LinkedHashMap<>(); try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(bytes), StandardCharsets.UTF_8)) { ZipEntry entry; while ((entry = zip.getNextEntry()) != null) {
            ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] block = new byte[16384]; int size; while ((size = zip.read(block)) != -1) output.write(block, 0, size); if (!entry.isDirectory()) files.put(entry.getName(), output.toByteArray()); } } return files;
    }
    private interface Checked { void run() throws Exception; }
    private static void assertCode(String code, Checked checked) throws Exception { try { checked.run(); fail("Expected " + code); } catch (StorageException failure) { assertEquals(code, failure.code); } }
    private static byte[] utf8(String value) { return value.getBytes(StandardCharsets.UTF_8); }
    private static void remove(File file) throws Exception { if (file.isDirectory()) for (File child : file.listFiles()) remove(child); assertTrue(file.delete()); }
}
