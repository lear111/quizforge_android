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
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

@RunWith(AndroidJUnit4.class)
public final class RepositoryManagementEditingTest {
    private static final String PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=";
    private File work;
    private Context context;
    private BankRepository repository;

    @Before public void setup() throws Exception {
        Context app = ApplicationProvider.getApplicationContext();
        File base = new File(app.getCacheDir(), "repository-authoring-instrumentation"); assertTrue(base.isDirectory() || base.mkdirs());
        work = new File(base, UUID.randomUUID().toString()); assertTrue(work.mkdir());
        context = new ContextWrapper(app) { @Override public File getFilesDir() { return work; } };
        repository = instance();
    }
    @After public void cleanup() throws Exception {
        assertEquals("repository-authoring-instrumentation", work.getCanonicalFile().getParentFile().getName()); remove(work);
    }

    @Test public void renameMoveAndGroupRenameKeepIdentityPracticeAndPerQuestionVersions() throws Exception {
        String id = imported(null), version = qVersion(repository.readBank(id), "q1");
        repository.writeState(id, state(), 0);
        change("create", "group", null, "Study", null, null);
        change("update", "item", id, "Renamed", "Study", null);
        change("update", "group", null, "Study 2", null, "Study");
        JSONObject bank = repository.readBank(id);
        assertEquals("Renamed", bank.getString("title")); assertEquals("Renamed", bank.getJSONObject("bank").getString("title"));
        assertEquals("Study 2", bank.getString("group")); assertEquals(version, qVersion(bank, "q1"));
        assertEquals("old-answer", repository.readState(id).getJSONObject("questions").getJSONObject("q1").getString("answer"));
        BankRepository reopened = instance(); assertEquals(version, qVersion(reopened.readBank(id), "q1"));
        assertEquals(1, reopened.readState(id).getLong("revision"));
    }

    @Test public void deleteAndRestoreUseRecoverableTrashWithoutClearingHistory() throws Exception {
        String id = imported(null); repository.writeState(id, state(), 0);
        String history = repository.readState(id).getJSONArray("history").toString();
        JSONObject deleted = change("delete", "item", id, null, null, null);
        assertEquals(0, repository.listBanks().length()); assertEquals(1, repository.listTrash().length());
        assertCode("BANK_NOT_FOUND", () -> repository.readBank(id));
        JSONObject restored = repository.restoreTrash(deleted.getString("trashId"));
        assertEquals(id, restored.getJSONArray("restored").getJSONObject(0).getString("id"));
        assertEquals(history, repository.readState(id).getJSONArray("history").toString());
        assertEquals(0, repository.listTrash().length());
    }

    @Test public void groupDeletionAndConflictingRestoreAllocateIndependentNames() throws Exception {
        String one = imported(null), two = imported(null);
        change("create", "group", null, "Study", null, null);
        change("update", "item", one, "One", "Study", null); change("update", "item", two, "Two", "Study", null);
        JSONObject deleted = change("delete", "group", null, null, null, "Study"); assertEquals(0, repository.listBanks().length());
        change("create", "group", null, "Study", null, null);
        JSONObject restored = repository.restoreTrash(deleted.getString("trashId"));
        assertEquals("Study（2）", restored.getString("group")); assertEquals(2, restored.getJSONArray("restored").length());
        assertEquals("Study（2）", repository.readBank(one).getString("group"));
    }

    @Test public void deletingBankPreservesAllExtensionAndPracticeBytesWithoutReadingOtherBankSources() throws Exception {
        String selected = imported(null), unrelated = imported(null);
        repository.writeState(selected, state(), 0); repository.writeState(unrelated, state(), 0);
        JSONArray records = repository.readCatalog().getJSONArray("banks");
        for (int i = 0; i < records.length(); i++) {
            JSONObject row = records.getJSONObject(i);
            if (row.getString("id").equals(unrelated)) {
                File source = BankRepository.safeFile(repository.importRoot(row), row.getString("bankPath"));
                Files.write(source.toPath(), "{unreadable unrelated bank".getBytes(StandardCharsets.UTF_8));
            }
        }
        Map<String, byte[]> imports = snapshot(new File(work, "library")), practice = snapshot(new File(work, "practice"));
        boolean hasExtension = false;
        for (String path : imports.keySet()) if (path.contains("/extensions/") && path.endsWith("/manifest.json")) hasExtension = true;
        assertTrue("fixture must include extension bytes in both import roots", hasExtension);
        JSONObject deleted = change("delete", "item", selected, null, null, null);
        assertEquals(1, repository.listBanks().length()); assertEquals(unrelated, repository.listBanks().getJSONObject(0).getString("id"));
        assertSnapshot(imports, snapshot(new File(work, "library"))); assertSnapshot(practice, snapshot(new File(work, "practice")));
        repository.restoreTrash(deleted.getString("trashId"));
        assertEquals(2, repository.listBanks().length()); assertEquals("old-answer", repository.readState(selected).getJSONObject("questions").getJSONObject("q1").getString("answer"));
        assertSnapshot(imports, snapshot(new File(work, "library"))); assertSnapshot(practice, snapshot(new File(work, "practice")));
    }

    @Test public void contentEditResetsOnlyChangedQuestionAndKeepsFrozenHistory() throws Exception {
        String id = imported(null); repository.writeState(id, state(), 0);
        String history = repository.readState(id).getJSONArray("history").toString();
        JSONObject before = repository.readBank(id), opened = repository.readEditor(id, "q1");
        String otherVersion = qVersion(before, "q2");
        JSONObject request = editRequest(opened, "edit-1"); request.getJSONObject("question").getJSONObject("data").put("correct", "C");
        JSONObject reply = repository.editQuestion(id, "q1", request);
        assertTrue(reply.getBoolean("dataChanged")); assertFalse(reply.getBoolean("replayed"));
        JSONObject afterState = repository.readState(id);
        assertEquals("unanswered", afterState.getJSONObject("questions").getJSONObject("q1").getString("status"));
        assertTrue(afterState.getJSONObject("questions").getJSONObject("q1").isNull("answer"));
        assertFalse(afterState.getJSONObject("ink").has("q1")); assertTrue(afterState.getJSONObject("ink").has("q2"));
        assertEquals("other-answer", afterState.getJSONObject("questions").getJSONObject("q2").getString("answer"));
        assertEquals(history, afterState.getJSONArray("history").toString());
        assertEquals(otherVersion, qVersion(repository.readBank(id), "q2"));
        assertNotEquals(qVersion(before, "q1"), qVersion(repository.readBank(id), "q1"));
        assertEquals(1, new File(work, "edit-backups").list().length);
        assertEquals(reply.getString("contentVersion"), repository.readEditor(id, "q1").getString("contentVersion"));
    }

    @Test public void titleOnlyEditKeepsAnswersInkAndReceiptReplayCannotClearLaterAnswer() throws Exception {
        String id = imported(null); repository.writeState(id, state(), 0);
        JSONObject opened = repository.readEditor(id, "q1"), request = editRequest(opened, "title-edit"); request.getJSONObject("question").put("title", "Renamed question");
        JSONObject first = repository.editQuestion(id, "q1", request); assertFalse(first.getBoolean("dataChanged"));
        JSONObject state = repository.readState(id); assertEquals("old-answer", state.getJSONObject("questions").getJSONObject("q1").getString("answer")); assertTrue(state.getJSONObject("ink").has("q1"));
        state.getJSONObject("questions").getJSONObject("q1").put("answer", "new-answer");
        repository.writeState(id, state, state.getLong("revision"));
        JSONObject replay = instance().editQuestion(id, "q1", request); assertTrue(replay.getBoolean("replayed"));
        assertEquals(first.getString("contentVersion"), replay.getString("contentVersion"));
        assertEquals("new-answer", repository.readState(id).getJSONObject("questions").getJSONObject("q1").getString("answer"));
        request.getJSONObject("question").put("title", "different"); assertCode("REQUEST_ID_REUSED", () -> repository.editQuestion(id, "q1", request));
    }

    @Test public void staleSourceRevisionUnknownFieldsAndIdChangesAreRejected() throws Exception {
        String id = imported(null); repository.writeState(id, state(), 0);
        JSONObject opened = repository.readEditor(id, "q1"), stale = editRequest(opened, "stale");
        JSONObject another = editRequest(repository.readEditor(id, "q2"), "other"); another.getJSONObject("question").put("title", "Other title"); repository.editQuestion(id, "q2", another);
        assertCode("CONTENT_CONFLICT", () -> repository.editQuestion(id, "q1", stale));
        JSONObject revision = editRequest(repository.readEditor(id, "q1"), "revision").put("revision", 99); assertCode("REVISION_CONFLICT", () -> repository.editQuestion(id, "q1", revision));
        JSONObject extra = editRequest(repository.readEditor(id, "q1"), "extra").put("unexpected", true); assertCode("INVALID_REQUEST", () -> repository.editQuestion(id, "q1", extra));
        JSONObject changedId = editRequest(repository.readEditor(id, "q1"), "id"); changedId.getJSONObject("question").put("id", "different"); assertCode("INVALID_REQUEST", () -> repository.editQuestion(id, "q1", changedId));
        assertEquals("q1", repository.readBank(id).getJSONObject("bank").getJSONArray("questions").getJSONObject(0).getString("id"));
    }

    @Test public void draftsPersistWorkingFormsAndEditingDisabledStillHasPracticeVersions() throws Exception {
        String id = imported(null); JSONObject opened = repository.readEditor(id, "q1");
        JSONObject draft = new JSONObject().put("contentVersion", opened.getString("draftVersion")).put("draft", new JSONObject().put("invalidWorkingText", "")).put("changed", true);
        repository.putEditorDraft(id, "q1", draft); assertTrue(instance().readEditorDraft(id, "q1").getBoolean("changed"));
        repository.deleteEditorDraft(id, "q1"); assertTrue(repository.readEditorDraft(id, "q1").isNull("draft"));
        String disabled = imported(new JSONObject().put("editing", false));
        assertTrue(repository.readBank(disabled).getJSONObject("questionVersions").has("q1"));
        assertCode("EDITING_DISABLED", () -> repository.readEditor(disabled, "q1"));
        assertCode("EDITING_DISABLED", () -> repository.putEditorDraft(disabled, "q1", draft));
    }

    @Test public void historyDisabledAuthorImagesAndSourceEditPersistWithoutPractice() throws Exception {
        String id = imported(new JSONObject().put("history", false));
        JSONObject resource = repository.putEditorResource(id, "image/png", PNG), opened = repository.readEditor(id, "q1");
        JSONObject draft = new JSONObject().put("contentVersion", opened.getString("draftVersion")).put("draft", new JSONObject()).put("changed", true);
        assertTrue(repository.putEditorDraft(id, "q1", draft).getBoolean("memoryOnly"));
        JSONObject request = editRequest(opened, "author-no-history").put("revision", 37);
        request.getJSONObject("question").getJSONObject("data").put("image", image(resource.getString("id")));
        repository.editQuestion(id, "q1", request);
        assertNull(repository.readState(id)); assertFalse(new File(work, "practice/" + id + ".json").exists());
        assertEquals(PNG, instance().getResource(id, resource.getString("id")).getString("data"));
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); repository.exportPackage(id, null, bytes);
        String copy = first(repository.importPackage(new ByteArrayInputStream(bytes.toByteArray()), "Export.qbank"));
        assertEquals(PNG, repository.getResource(copy, resource.getString("id")).getString("data"));
    }

    @Test public void groupExportReimportsBothBanksAndExactRulesWithoutPracticeOrHistory() throws Exception {
        String one = imported(null), two = imported(null); repository.writeState(one, state(), 0);
        change("create", "group", null, "Bundle", null, null);
        change("update", "item", one, "One", "Bundle", null); change("update", "item", two, "Two", "Bundle", null);
        String rules = repository.readExtension(one, "extensions/Test/Demo").getString("rules");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); JSONObject metadata = repository.exportPackage(null, "Bundle", bytes);
        assertEquals(2, metadata.getInt("exportedBanks")); assertEquals(2, metadata.getInt("exportedExtensions"));
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(bytes.toByteArray()), StandardCharsets.UTF_8)) {
            ZipEntry entry; while ((entry = zip.getNextEntry()) != null) {
                assertFalse(entry.getName().contains("practice" + "/")); assertFalse(entry.getName().startsWith(".state")); assertFalse(entry.getName().contains("history"));
                assertFalse(entry.getName().contains("version-key")); assertFalse(entry.getName().contains("author-resources"));
            }
        }
        JSONArray imported = repository.importPackage(new ByteArrayInputStream(bytes.toByteArray()), "Bundle copy.qbank").getJSONArray("banks"); assertEquals(2, imported.length());
        for (int i = 0; i < imported.length(); i++) {
            String id = imported.getJSONObject(i).getString("id"); assertNull(repository.readState(id));
            JSONObject bank = repository.readBank(id).getJSONObject("bank"); assertEquals("q1", bank.getJSONArray("questions").getJSONObject(0).getString("id"));
            assertEquals(rules, repository.readExtension(id, bank.getJSONObject("extension").getString("path")).getString("rules"));
        }
    }

    @Test public void forwardRecoveryCompletesExactPlannedBytesAndRefusesUnrelatedChanges() throws Exception {
        String id = imported(null); repository.writeState(id, state(), 0);
        File target = new File(work, "practice/" + id + ".json");
        JSONObject after = repository.readState(id).put("revision", 2).put("marker", "recovered");
        stageRecovery(target, RepositoryManagement.json(after));
        BankRepository reopened = instance(); assertEquals("recovered", reopened.readState(id).getString("marker")); assertFalse(new File(work, "repository-transaction.json").exists());
        stageRecovery(target, RepositoryManagement.json(after.put("revision", 3)));
        Files.write(target.toPath(), "{\"unrelated\":true}".getBytes(StandardCharsets.UTF_8));
        assertCode("EDIT_PENDING", this::instance); assertTrue(new File(work, "repository-transaction.json").exists());
        assertEquals("{\"unrelated\":true}", new String(Files.readAllBytes(target.toPath()), StandardCharsets.UTF_8));
    }

    private void stageRecovery(File target, byte[] after) throws Exception {
        String id = UUID.randomUUID().toString(); File staged = new File(work, "transactions/" + id); assertTrue(staged.mkdir());
        Files.write(new File(staged, "0.bin").toPath(), after);
        JSONObject row = new JSONObject().put("path", work.toPath().relativize(target.toPath()).toString().replace(File.separatorChar, '/'))
                .put("before", RepositoryManagement.fileDigest(target)).put("after", BankRepository.sha256(after)).put("file", "0.bin");
        Files.write(new File(work, "repository-transaction.json").toPath(), RepositoryManagement.json(new JSONObject().put("schemaVersion", 1).put("id", id).put("targets", new JSONArray().put(row))));
    }
    private BankRepository instance() throws Exception {
        BankRepository value = new BankRepository(context); value.setImportValidator((extension, questions) -> {
            for (int i = 0; i < questions.length(); i++) if (questions.optJSONObject(i) != null && questions.getJSONObject(i).optBoolean("invalid")) throw new StorageException("RULE_REJECTED", "Synthetic invalid data");
        }); return value;
    }
    private String imported(JSONObject features) throws Exception {
        Map<String, byte[]> files = BankRepositoryTest.fixtureFiles();
        JSONObject bank = new JSONObject(new String(files.get("question-banks/Test/Demo/bank.json"), StandardCharsets.UTF_8));
        if (features != null) bank.put("features", features);
        bank.getJSONArray("questions").put(new JSONObject().put("id", "q2").put("title", "Other").put("data", new JSONObject().put("correct", "B")));
        files.put("question-banks/Test/Demo/bank.json", RepositoryManagement.json(bank));
        return first(repository.importPackage(new ByteArrayInputStream(BankRepositoryTest.zip(files)), "Demo.qbank"));
    }
    private JSONObject change(String action, String target, String bankId, String name, String group, String path) throws Exception {
        JSONObject request = new JSONObject().put("kind", "bank").put("action", action).put("target", target);
        if (bankId != null) request.put("bankId", bankId); if (name != null) request.put("name", name); if (group != null) request.put("group", group); if (path != null) request.put("path", path);
        return repository.changeLibrary(request);
    }
    private static JSONObject editRequest(JSONObject editor, String id) throws Exception {
        return new JSONObject().put("requestId", id).put("revision", editor.getLong("revision")).put("contentVersion", editor.getString("contentVersion"))
                .put("sourceVersion", editor.getString("sourceVersion")).put("question", new JSONObject(editor.getJSONObject("question").toString()));
    }
    private static JSONObject state() throws Exception {
        JSONObject one = new JSONObject().put("status", "draft").put("answer", "old-answer").put("result", JSONObject.NULL).put("revision", 4);
        JSONObject two = new JSONObject().put("status", "submitted").put("answer", "other-answer").put("result", new JSONObject().put("score", 1)).put("revision", 8);
        return new JSONObject().put("schemaVersion", 1).put("revision", 0).put("roundId", "frozen-original").put("finished", false)
                .put("questions", new JSONObject().put("q1", one).put("q2", two)).put("ink", new JSONObject().put("q1", new JSONObject().put("strokes", 1)).put("q2", new JSONObject().put("strokes", 2)))
                .put("history", new JSONArray().put(new JSONObject().put("id", "history-original").put("pages", new JSONObject().put("immutable", "old-code"))));
    }
    private static JSONObject image(String id) throws Exception { return new JSONObject().put("type", "image").put("attrs", new JSONObject().put("assetId", id)); }
    private static String first(JSONObject result) throws Exception { return result.getJSONArray("banks").getJSONObject(0).getString("id"); }
    private static String qVersion(JSONObject bank, String question) throws Exception { return bank.getJSONObject("questionVersions").getJSONObject(question).getString("contentVersion"); }
    private static Map<String, byte[]> snapshot(File root) throws Exception {
        Map<String, byte[]> result = new LinkedHashMap<>(); snapshot(root, root, result); return result;
    }
    private static void snapshot(File root, File item, Map<String, byte[]> result) throws Exception {
        if (item.isDirectory()) { File[] children = item.listFiles(); assertNotNull(children); for (File child : children) snapshot(root, child, result); }
        else result.put(root.toPath().relativize(item.toPath()).toString().replace(File.separatorChar, '/'), Files.readAllBytes(item.toPath()));
    }
    private static void assertSnapshot(Map<String, byte[]> expected, Map<String, byte[]> actual) {
        assertEquals(expected.keySet(), actual.keySet()); for (String path : expected.keySet()) assertArrayEquals(path, expected.get(path), actual.get(path));
    }
    private interface Checked { void run() throws Exception; }
    private static void assertCode(String code, Checked action) throws Exception { try { action.run(); fail("Expected " + code); } catch (StorageException exception) { assertEquals(code, exception.code); } }
    private static void remove(File file) throws Exception { if (file.isDirectory()) for (File child : file.listFiles()) remove(child); assertTrue(file.delete()); }
}
