package cloud.treenewbee.quizforge.android;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.ContextWrapper;
import android.util.Base64;

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
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Tests use newly generated fictional packages and their own app-private files. */
@RunWith(AndroidJUnit4.class)
public final class BankRepositoryTest {
    private File work;
    private Context context;
    private BankRepository repository;

    @Before public void setUp() throws Exception {
        Context app = ApplicationProvider.getApplicationContext();
        File tests = new File(app.getCacheDir(), "repository-instrumentation");
        assertTrue(tests.isDirectory() || tests.mkdirs());
        work = new File(tests, UUID.randomUUID().toString());
        assertTrue(work.mkdir());
        context = new ContextWrapper(app) {
            @Override public File getFilesDir() { return work; }
        };
        repository = new BankRepository(context);
        repository.setImportValidator((extension, questions) -> {
            assertTrue(extension.getString("rules").contains("QF.defineType"));
            assertNotNull(questions);
        });
    }

    @After public void tearDown() throws Exception {
        // Delete only this test's generated UUID directory, never the app library.
        assertEquals("repository-instrumentation", work.getCanonicalFile().getParentFile().getName());
        removeGenerated(work);
    }

    @Test public void repeatedImportsHaveIndependentIdentityAndPreserveRawIds() throws Exception {
        JSONObject first = importFixture(), second = importFixture();
        String one = firstId(first), two = firstId(second);
        assertNotEquals(one, two);
        assertEquals(2, repository.listBanks().length());
        assertEquals("Demo", repository.listBanks().getJSONObject(0).getString("title"));
        assertEquals("Demo（2）", repository.listBanks().getJSONObject(1).getString("title"));
        JSONObject bank = repository.readBank(one).getJSONObject("bank");
        assertEquals("q1", bank.getJSONArray("questions").getJSONObject(0).getString("id"));
        assertEquals("extensions/Test/Demo", bank.getJSONObject("extension").getString("path"));
        JSONObject extension = repository.readExtension(one, "extensions/Test/Demo");
        assertTrue(extension.getString("html").contains("<body"));
        assertEquals("practice.html", extension.getString("entryPath"));
        assertThrowsCode("REVISION_CONFLICT", () -> repository.writeState(one, state(), 1));
        assertNull(repository.readState(two));
    }

    @Test public void failedRuleValidationNeverPublishesBank() throws Exception {
        repository.setImportValidator((extension, questions) -> { throw new StorageException("RULE_REJECTED", "synthetic rejection"); });
        assertThrowsCode("RULE_REJECTED", this::importFixture);
        assertEquals(0, repository.listBanks().length());
        assertEquals(0, new File(work, "library").list().length);
        assertEquals(0, new File(work, "import-staging").list().length);
    }

    @Test public void zipTraversalAndDuplicateCasePathsAreRejected() throws Exception {
        Map<String, byte[]> paths = fixtureFiles();
        paths.put("../outside.txt", "bad".getBytes(StandardCharsets.UTF_8));
        byte[] traversal = zip(paths);
        assertThrowsCode("INVALID_LIBRARY_ARCHIVE", () -> importBytes(traversal));
        assertFalse(new File(work, "outside.txt").exists());
        paths = fixtureFiles();
        paths.put("question-banks/Test/Demo/BANK.JSON", "{}".getBytes(StandardCharsets.UTF_8));
        byte[] duplicate = zip(paths);
        assertThrowsCode("INVALID_LIBRARY_ARCHIVE", () -> importBytes(duplicate));
        assertEquals(0, repository.listBanks().length());
    }

    @Test public void centralDirectorySymlinkAndEncryptionAreRejected() throws Exception {
        byte[] symlink = zip(fixtureFiles());
        int header = firstCentralHeader(symlink);
        // external attributes, high16 = Unix mode 0120777 (symbolic link).
        symlink[header + 38] = 0;
        symlink[header + 39] = 0;
        symlink[header + 40] = (byte)0xff;
        symlink[header + 41] = (byte)0xa1;
        assertThrowsCode("INVALID_LIBRARY_ARCHIVE", () -> importBytes(symlink));
        byte[] encrypted = zip(fixtureFiles());
        header = firstCentralHeader(encrypted);
        encrypted[header + 8] |= 1;
        assertThrowsCode("INVALID_LIBRARY_ARCHIVE", () -> importBytes(encrypted));
    }

    @Test public void missingImageAndUnsupportedPackageDoNotAlterExistingBank() throws Exception {
        String original = firstId(importFixture());
        Map<String, byte[]> paths = fixtureFiles();
        JSONObject bank = new JSONObject(new String(paths.get("question-banks/Test/Demo/bank.json"), StandardCharsets.UTF_8));
        bank.getJSONArray("questions").getJSONObject(0).getJSONObject("data")
                .put("image", new JSONObject().put("type", "image").put("attrs", new JSONObject().put("assetId", "0".repeat(64))));
        paths.put("question-banks/Test/Demo/bank.json", utf8(bank.toString()));
        byte[] missingImage = zip(paths);
        assertThrowsCode("INVALID_LIBRARY_ARCHIVE", () -> importBytes(missingImage));
        paths = fixtureFiles();
        paths.put("quizforge-package.json", utf8("{\"format\":\"quizforge-bank-group\",\"formatVersion\":2,\"group\":\"Test\"}"));
        byte[] oldPackage = zip(paths);
        assertThrowsCode("UNSUPPORTED_LIBRARY_ARCHIVE", () -> importBytes(oldPackage));
        assertEquals(1, repository.listBanks().length());
        assertEquals(original, repository.listBanks().getJSONObject(0).getString("id"));
    }

    @Test public void stateSurvivesRepositoryRecreationAndRejectsStaleWrite() throws Exception {
        String bank = firstId(importFixture());
        JSONObject saved = repository.writeState(bank, state(), 0);
        assertEquals(1, saved.getLong("revision"));
        repository = new BankRepository(context);
        assertEquals(1, repository.readState(bank).getLong("revision"));
        assertThrowsCode("REVISION_CONFLICT", () -> repository.writeState(bank, state(), 0));
        assertEquals("A", repository.readState(bank).getJSONObject("questions").getJSONObject("q1").getString("answer"));
    }

    @Test public void corruptedStateIsPreservedAndNeverSilentlyReset() throws Exception {
        String bank = firstId(importFixture());
        repository.writeState(bank, state(), 0);
        File file = new File(work, "practice/" + bank + ".json");
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(utf8("{damaged")); output.getFD().sync(); }
        assertThrowsCode("STORAGE_CORRUPT", () -> repository.readState(bank));
        assertEquals("{damaged", new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
    }

    @Test public void uploadedImagesAreCheckedAndBoundToTheirBank() throws Exception {
        String one = firstId(importFixture()), two = firstId(importFixture());
        String png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=";
        JSONObject resource = repository.putResource(one, "image/png", png);
        String id = resource.getString("id");
        assertEquals(png, repository.getResource(one, id).getString("data"));
        assertThrowsCode("RESOURCE_NOT_FOUND", () -> repository.getResource(two, id));
        assertThrowsCode("IMAGE_TYPE_MISMATCH", () -> repository.putResource(one, "image/jpeg", png));
        File file = new File(work, "practice/resources/" + one + "/" + id + ".png");
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(utf8("bad")); }
        assertThrowsCode("RESOURCE_UNAVAILABLE", () -> repository.getResource(one, id));
    }

    @Test public void historyDisabledBankCannotPersistPracticeOrUploadedImages() throws Exception {
        Map<String, byte[]> files = fixtureFiles();
        JSONObject bank = new JSONObject(new String(files.get("question-banks/Test/Demo/bank.json"), StandardCharsets.UTF_8));
        bank.put("features", new JSONObject().put("history", false));
        files.put("question-banks/Test/Demo/bank.json", utf8(bank.toString()));
        String id = firstId(importBytes(zip(files)));
        assertNull(repository.readState(id));
        assertThrowsCode("PERSISTENCE_DISABLED", () -> repository.writeState(id, state(), 0));
        assertThrowsCode("PERSISTENCE_DISABLED", () -> repository.putResource(id, "image/png", "AA=="));
        assertEquals(0, new File(work, "practice").list().length);
    }

    @Test public void declaredPrivateSourceWorksButUndeclaredPrivateFileIsRejected() throws Exception {
        Map<String, byte[]> files = fixtureFiles();
        String prefix = "extensions/Test/Demo/";
        JSONObject manifest = new JSONObject(new String(files.get(prefix + "manifest.json"), StandardCharsets.UTF_8));
        manifest.put("script", "./.practice.js");
        files.put(prefix + "manifest.json", utf8(manifest.toString()));
        files.put(prefix + ".practice.js", files.remove(prefix + "practice.js"));
        String id = firstId(importBytes(zip(files)));
        assertTrue(repository.readExtension(id, "extensions/Test/Demo").getString("script").contains("QF.page.register"));
        files.put(prefix + ".unrelated.json", utf8("{}"));
        byte[] undeclared = zip(files);
        assertThrowsCode("INVALID_LIBRARY_ARCHIVE", () -> importBytes(undeclared));
        assertEquals(1, repository.listBanks().length());
    }

    @Test public void api15PackagesImportWithoutRelaxingFutureVersionRejection() throws Exception {
        Map<String, byte[]> files = fixtureFiles(); String name = "extensions/Test/Demo/manifest.json";
        JSONObject manifest = new JSONObject(new String(files.get(name), StandardCharsets.UTF_8));
        manifest.getJSONObject("requiresApi").put("minMinor",5).getJSONArray("capabilities").put("answer-areas");files.put(name,utf8(manifest.toString()));
        String id=firstId(importBytes(zip(files)));assertEquals(5,repository.readExtension(id,"extensions/Test/Demo").getJSONObject("manifest").getJSONObject("requiresApi").getInt("minMinor"));
        manifest.getJSONObject("requiresApi").put("minMinor",6);files.put(name,utf8(manifest.toString()));
        assertThrowsCode("UNSUPPORTED_API_VERSION",()->importBytes(zip(files)));assertEquals(1,repository.listBanks().length());assertEquals(id,repository.listBanks().getJSONObject(0).getString("id"));
    }

    private JSONObject importFixture() throws Exception { return importBytes(zip(fixtureFiles())); }
    private JSONObject importBytes(byte[] bytes) throws Exception { return repository.importPackage(new ByteArrayInputStream(bytes), "Demo.qbank"); }
    private static String firstId(JSONObject result) throws Exception { return result.getJSONArray("banks").getJSONObject(0).getString("id"); }
    private static JSONObject state() throws Exception {
        return new JSONObject().put("schemaVersion", 1).put("revision", 0)
                .put("questions", new JSONObject().put("q1", new JSONObject().put("answer", "A")));
    }

    static Map<String, byte[]> fixtureFiles() throws Exception {
        Map<String, byte[]> files = new LinkedHashMap<>();
        files.put("quizforge-package.json", utf8("{\"format\":\"quizforge-bank-group\",\"formatVersion\":3,\"group\":\"Test\",\"scope\":\"bank\"}"));
        JSONObject bank = new JSONObject().put("id", "demo").put("title", "Demo")
                .put("extension", new JSONObject().put("path", "extensions/Test/Demo"))
                .put("questions", new JSONArray().put(new JSONObject().put("id", "q1").put("title", "Question")
                        .put("data", new JSONObject().put("correct", "A"))));
        files.put("question-banks/Test/Demo/bank.json", utf8(bank.toString()));
        String prefix = "extensions/Test/Demo/";
        JSONObject manifest = new JSONObject().put("id", "demo").put("version", "1.0.0").put("name", "Demo")
                .put("entry", "practice.html").put("script", "practice.js").put("style", "practice.css")
                .put("rules", "rules.js").put("questionSchema", "question.schema.json").put("answerSchema", "answer.schema.json")
                .put("examples", "examples/bank.json")
                .put("requiresApi", new JSONObject().put("major", 1).put("minMinor", 4)
                        .put("capabilities", new JSONArray().put("practice").put("score")));
        files.put(prefix + "manifest.json", utf8(manifest.toString()));
        files.put(prefix + "practice.html", utf8("<!doctype html><html><head><style>body{color:black}</style></head><body class=\"demo\"><div>Demo</div></body></html>"));
        files.put(prefix + "practice.js", utf8("QF.page.register({render(){}});"));
        files.put(prefix + "practice.css", utf8("body{margin:0}"));
        files.put(prefix + "rules.js", utf8("QF.defineType({project:d=>({title:'Demo'}),grade:()=>({score:1,maxScore:1,correct:true,feedback:null})});"));
        files.put(prefix + "question.schema.json", utf8("{\"type\":\"object\"}"));
        files.put(prefix + "answer.schema.json", utf8("{\"type\":\"object\"}"));
        files.put(prefix + "examples/bank.json", utf8(bank.toString()));
        return files;
    }

    static byte[] zip(Map<String, byte[]> files) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(output, StandardCharsets.UTF_8)) {
            for (Map.Entry<String, byte[]> entry : files.entrySet()) {
                zip.putNextEntry(new ZipEntry(entry.getKey()));
                zip.write(entry.getValue());
                zip.closeEntry();
            }
        }
        return output.toByteArray();
    }

    private static int firstCentralHeader(byte[] bytes) {
        for (int i = 0; i < bytes.length - 46; i++) if ((bytes[i]&255) == 0x50 && (bytes[i+1]&255) == 0x4b
                && (bytes[i+2]&255) == 1 && (bytes[i+3]&255) == 2) return i;
        throw new AssertionError("central header missing");
    }

    private interface Checked { void run() throws Exception; }
    private static void assertThrowsCode(String code, Checked action) throws Exception {
        try { action.run(); fail("Expected " + code); }
        catch (StorageException error) { assertEquals(code, error.code); }
    }
    private static byte[] utf8(String value) { return value.getBytes(StandardCharsets.UTF_8); }
    private static void removeGenerated(File file) throws Exception {
        if (file.isDirectory()) for (File child : file.listFiles()) removeGenerated(child);
        if (!file.delete()) throw new AssertionError("Unable to remove generated test data");
    }
}
