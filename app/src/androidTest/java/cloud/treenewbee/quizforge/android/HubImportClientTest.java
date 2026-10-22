package cloud.treenewbee.quizforge.android;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.ContextWrapper;
import android.os.CancellationSignal;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import okhttp3.Authenticator;
import okhttp3.CookieJar;
import okhttp3.Interceptor;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/** Canned HTTP exchanges: tests never request the production Hub or user data. */
@RunWith(AndroidJUnit4.class)
public final class HubImportClientTest {
    private static final String PACK = "123e4567-e89b-42d3-a456-426614174000";
    private static final String LINK = "quizforge://hub/import?v=1&pack=" + PACK + "&revision=3";
    private static final byte[] ARCHIVE = "fictional package bytes".getBytes(StandardCharsets.UTF_8);
    private File cache;
    private final List<Request> requests = new ArrayList<>();

    @Before public void setup() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        cache = new File(context.getCacheDir(), "hub-client-test-" + UUID.randomUUID());
        assertTrue(cache.mkdir()); requests.clear();
    }

    @After public void cleanup() throws Exception {
        assertTrue(cache.getName().startsWith("hub-client-test-"));
        remove(cache, cache.getCanonicalFile());
    }
    private static void remove(File value, File root) throws Exception {
        File canonical = value.getCanonicalFile();
        assertTrue(canonical.equals(root) || canonical.getPath().startsWith(root.getPath() + File.separator));
        File[] children = value.listFiles(); if (children != null) for (File child : children) remove(child, root);
        assertTrue(value.delete());
    }
    private interface Exchange { Response answer(Request request, int index) throws Exception; }
    private HubImportClient client(Exchange exchange) { return client(exchange, HubImportClient.NETWORK_TIMEOUT_MILLIS); }
    private HubImportClient client(Exchange exchange, long timeout) {
        OkHttpClient transport = HubImportClient.newAnonymousClient().newBuilder().addInterceptor(chain -> {
            Request request = chain.request(); int index = requests.size(); requests.add(request);
            try { return exchange.answer(request, index); }
            catch (IOException exception) { throw exception; }
            catch (Exception exception) { throw new IOException(exception); }
        }).build();
        return new HubImportClient(cache, transport, timeout);
    }
    private static Response reply(Request request, int status, String type, byte[] body) {
        return new Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(status).message("Synthetic")
                .header("Content-Type", type).header("Content-Length", String.valueOf(body.length))
                .body(ResponseBody.create(body, MediaType.get(type))).build();
    }
    private static String sha(byte[] bytes) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format(Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
    private static JSONObject manifest(byte[] bytes) throws Exception {
        return new JSONObject().put("schemaVersion", 1)
                .put("pack", new JSONObject().put("id", PACK).put("revision", 3).put("title", "示例题库"))
                .put("archive", new JSONObject().put("name", "展示名.qbank").put("size", bytes.length).put("sha256", sha(bytes)));
    }
    private static Response manifestReply(Request request, JSONObject value) {
        return reply(request, 200, "application/json", value.toString().getBytes(StandardCharsets.UTF_8));
    }
    private void noStagedTasks() {
        File root = new File(cache, "hub-import-v1");
        assertTrue(!root.exists() || root.list().length == 0);
    }
    private interface Attempt { void run() throws Exception; }
    private static void rejects(String code, Attempt attempt) throws Exception {
        try { attempt.run(); fail("Expected " + code); }
        catch (StorageException exception) { assertEquals(code, exception.code); }
    }

    @Test public void uriParserOnlyAcceptsTheExactVersionOneContract() throws Exception {
        HubImportClient.ImportRequest source = HubImportClient.parse(LINK);
        assertEquals(PACK, source.packId); assertEquals(3, source.revision); assertEquals(PACK + ":3", source.key());
        assertEquals(LINK, HubImportClient.parse("quizforge://hub/import?revision=3&pack=" + PACK + "&v=1").uri());
        assertEquals(9007199254740991L, HubImportClient.parse(LINK.replace("revision=3", "revision=9007199254740991")).revision);
        String[] invalid = {"", LINK + "&url=https://evil.test", LINK + "#fragment", LINK + "&v=1", LINK.replace("v=1", "v=2"),
                LINK.replace("v=1", "%76=1"), LINK.replace("revision=3", "revision=%33"), LINK.replace("revision=3", "revision=03"),
                LINK.replace("revision=3", "revision=9007199254740992"), LINK.replace("revision=3", "revision=-1"),
                LINK.replace("quizforge://hub", "https://hub"), LINK.replace("hub/import", "hub:443/import"),
                LINK.replace("hub/import", "user@hub/import"), LINK.replace("/import?", "/import/?"),
                LINK.replace(PACK, PACK.toUpperCase(Locale.ROOT)), LINK + "\n", LINK.replace("revision=3", "revision=3=4")};
        for (String value : invalid) rejects("HUB_IMPORT_INVALID_LINK", () -> HubImportClient.parse(value));
    }

    @Test public void anonymousTransportRetainsSystemProxyAndDisablesCredentialReuseAndRedirects() {
        OkHttpClient transport = HubImportClient.newAnonymousClient();
        assertSame(CookieJar.NO_COOKIES, transport.cookieJar()); assertSame(Authenticator.NONE, transport.authenticator());
        assertSame(Authenticator.NONE, transport.proxyAuthenticator()); assertFalse(transport.followRedirects());
        assertFalse(transport.followSslRedirects()); assertFalse(transport.retryOnConnectionFailure());
        assertNull(transport.proxy()); assertNull(transport.cache()); assertEquals(180000, transport.callTimeoutMillis());
    }

    @Test public void fixedManifestThenPinnedDownloadYieldsOwnedBytesAndCloseCleansOnlyTheTask() throws Exception {
        List<String> progress = new ArrayList<>();
        HubImportClient downloader = client((request, index) -> index == 0 ? manifestReply(request, manifest(ARCHIVE)) : reply(request, 200, "application/octet-stream", ARCHIVE));
        try (HubImportClient.DownloadedPackage result = downloader.download(LINK, null, (stage, received, total, title) -> progress.add(stage))) {
            assertEquals("展示名.qbank", result.displayName); assertEquals("示例题库", result.title); assertEquals(ARCHIVE.length, result.size);
            try (InputStream stream = result.openStream()) { assertArrayEquals(ARCHIVE, stream.readAllBytes()); }
            assertEquals(2, requests.size());
            assertEquals(HubImportClient.ORIGIN + "/api/packs/" + PACK + "/local-import?revision=3", requests.get(0).url().toString());
            assertEquals(HubImportClient.ORIGIN + "/api/packs/" + PACK + "/download?revision=3&sha256=" + sha(ARCHIVE), requests.get(1).url().toString());
            for (Request request : requests) {
                assertEquals("GET", request.method()); assertNull(request.header("Cookie")); assertNull(request.header("Authorization"));
                assertNull(request.header("Proxy-Authorization")); assertEquals("identity", request.header("Accept-Encoding"));
            }
            File[] stages = new File(cache, "hub-import-v1").listFiles(); assertEquals(1, stages.length);
            assertArrayEquals(new String[]{"package.qbank"}, stages[0].list());
        }
        assertTrue(progress.contains("manifest")); assertTrue(progress.contains("download")); assertEquals("verified", progress.get(progress.size() - 1));
        noStagedTasks();
    }

    @Test public void manifestIdentityAndNumericTypesAreCheckedBeforeAnyArchiveDownload() throws Exception {
        JSONObject wrong = manifest(ARCHIVE); wrong.getJSONObject("pack").put("revision", 4);
        rejects("HUB_IMPORT_MANIFEST_INVALID", () -> client((request, index) -> manifestReply(request, wrong)).download(LINK, null, null));
        assertEquals(1, requests.size()); noStagedTasks(); requests.clear();
        wrong.getJSONObject("pack").put("revision", "3");
        rejects("HUB_IMPORT_MANIFEST_INVALID", () -> client((request, index) -> manifestReply(request, wrong)).download(LINK, null, null));
        assertEquals(1, requests.size()); noStagedTasks();
    }

    @Test public void oversizedMalformedAndInvalidUtf8ManifestsFailClosed() throws Exception {
        byte[][] documents = {new byte[32769], new byte[]{(byte) 0xc0, (byte) 0xaf}, "[]".getBytes(StandardCharsets.UTF_8),
                (manifest(ARCHIVE) + " trailing").getBytes(StandardCharsets.UTF_8)};
        for (byte[] document : documents) {
            requests.clear(); rejects("HUB_IMPORT_MANIFEST_INVALID", () -> client((request, index) -> reply(request, 200, "application/json", document)).download(LINK, null, null));
            assertEquals(1, requests.size()); noStagedTasks();
        }
    }

    @Test public void oversizedArchiveAndNonQbankNamesNeverStartDownload() throws Exception {
        JSONObject document = manifest(ARCHIVE); document.getJSONObject("archive").put("size", HubImportClient.MAX_ARCHIVE_BYTES + 1);
        rejects("HUB_IMPORT_TOO_LARGE", () -> client((request, index) -> manifestReply(request, document)).download(LINK, null, null));
        requests.clear(); document.getJSONObject("archive").put("size", ARCHIVE.length).put("name", "../unsafe.qbank");
        rejects("HUB_IMPORT_MANIFEST_INVALID", () -> client((request, index) -> manifestReply(request, document)).download(LINK, null, null));
        assertEquals(1, requests.size()); noStagedTasks();
    }

    @Test public void redirectAtEitherStageIsRejectedWithoutRequestingAnotherHost() throws Exception {
        for (int at : new int[]{0, 1}) {
            requests.clear();
            rejects("HUB_IMPORT_REDIRECT", () -> client((request, index) -> index == at
                    ? reply(request, 302, "text/html", new byte[0]).newBuilder().header("Location", "https://other.example/file").build()
                    : manifestReply(request, manifest(ARCHIVE))).download(LINK, null, null));
            assertEquals(at + 1, requests.size()); noStagedTasks();
        }
    }

    @Test public void serverRevisionAndAvailabilityErrorsKeepStableCodesWithoutEchoingRemoteText() throws Exception {
        String[] codes = {"LOCAL_IMPORT_REVISION_CHANGED", "LOCAL_IMPORT_DISABLED", "LOCAL_IMPORT_UNAVAILABLE", "LOCAL_IMPORT_RATE_LIMITED", "LOCAL_IMPORT_TRAFFIC_LIMIT"};
        for (String code : codes) {
            requests.clear();
            rejects(code, () -> client((request, index) -> reply(request, 409, "application/json", ("{\"code\":\"" + code + "\",\"error\":\"untrusted text\"}").getBytes(StandardCharsets.UTF_8))).download(LINK, null, null));
            assertEquals(1, requests.size()); noStagedTasks();
        }
    }

    @Test public void archiveLengthEncodingAndDigestMismatchesRemoveEveryPartialDownload() throws Exception {
        for (int mode = 0; mode < 5; mode++) {
            final int variant = mode; requests.clear();
            String code = mode == 0 ? "HUB_IMPORT_RESPONSE_INVALID" : mode == 4 ? "HUB_IMPORT_HASH_MISMATCH" : "HUB_IMPORT_SIZE_MISMATCH";
            rejects(code, () -> client((request, index) -> {
                if (index == 0) return manifestReply(request, manifest(ARCHIVE));
                if (variant == 0) return reply(request, 200, "application/octet-stream", ARCHIVE).newBuilder().header("Content-Encoding", "gzip").build();
                if (variant == 1) return reply(request, 200, "application/octet-stream", ARCHIVE).newBuilder().removeHeader("Content-Length").build();
                if (variant == 2) return reply(request, 200, "application/octet-stream", new byte[ARCHIVE.length - 1]).newBuilder().header("Content-Length", String.valueOf(ARCHIVE.length)).build();
                if (variant == 3) return reply(request, 200, "application/octet-stream", new byte[ARCHIVE.length + 1]).newBuilder().header("Content-Length", String.valueOf(ARCHIVE.length)).build();
                return reply(request, 200, "application/octet-stream", new byte[ARCHIVE.length]);
            }).download(LINK, null, null));
            assertEquals(2, requests.size()); noStagedTasks();
        }
    }

    @Test public void cancellationBeforeAndDuringDownloadNeverLeavesAnArchive() throws Exception {
        CancellationSignal before = new CancellationSignal(); before.cancel();
        rejects("HUB_IMPORT_CANCELLED", () -> client((request, index) -> { throw new AssertionError("No request expected"); }).download(LINK, before, null));
        assertEquals(0, requests.size());
        CancellationSignal during = new CancellationSignal();
        rejects("HUB_IMPORT_CANCELLED", () -> client((request, index) -> index == 0 ? manifestReply(request, manifest(ARCHIVE)) : reply(request, 200, "application/octet-stream", ARCHIVE))
                .download(LINK, during, (stage, received, total, name) -> { if (stage.equals("download") && received > 0) during.cancel(); }));
        noStagedTasks();
    }

    @Test public void oneDeadlineCoversManifestAndDownloadRatherThanRestartingPerRequest() throws Exception {
        rejects("HUB_IMPORT_TIMEOUT", () -> client((request, index) -> {
            try { Thread.sleep(80); } catch (InterruptedException exception) { Thread.currentThread().interrupt(); }
            return manifestReply(request, manifest(ARCHIVE));
        }, 20).download(LINK, null, null));
        assertEquals(1, requests.size()); noStagedTasks();
    }

    @Test public void verifiedOldFormatStillFailsRepositoryImportWithoutPublishingAnything() throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
            zip.putNextEntry(new ZipEntry("quizforge-package.json"));
            zip.write("{\"format\":\"quizforge-bank-group\",\"formatVersion\":2}".getBytes(StandardCharsets.UTF_8)); zip.closeEntry();
        }
        byte[] legacy = bytes.toByteArray();
        File data = new File(cache, "repository"); assertTrue(data.mkdir());
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        BankRepository repository = new BankRepository(new ContextWrapper(app) { @Override public File getFilesDir() { return data; } });
        repository.setImportValidator((extension, questions) -> {});
        try (HubImportClient.DownloadedPackage result = client((request, index) -> index == 0 ? manifestReply(request, manifest(legacy)) : reply(request, 200, "application/octet-stream", legacy)).download(LINK, null, null);
             InputStream input = result.openStream()) {
            rejects("UNSUPPORTED_LIBRARY_ARCHIVE", () -> repository.importPackage(input, null));
        }
        assertEquals(0, repository.listBanks().length()); noStagedTasks();
    }
}
