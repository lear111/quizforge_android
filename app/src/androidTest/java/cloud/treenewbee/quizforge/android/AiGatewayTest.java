package cloud.treenewbee.quizforge.android;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.Map;
import java.util.Arrays;
import java.util.zip.CRC32;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;

/** Fake model exchanges only: no live provider, billing or real credentials. */
@RunWith(AndroidJUnit4.class)
public final class AiGatewayTest {
    private File folder, file;
    private String alias;
    private AiGateway gateway;
    private final List<Request> requests = new ArrayList<>();
    private final List<JSONObject> bodies = new ArrayList<>();
    private interface Exchange { Response answer(Request request, JSONObject body, int index) throws Exception; }
    @Before public void setup() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String id = UUID.randomUUID().toString(); folder = new File(context.getCacheDir(), "ai-gateway-test-" + id); assertTrue(folder.mkdir());
        file = new File(folder, "profile.enc"); alias = context.getPackageName() + ".ai-test." + id; requests.clear(); bodies.clear();
    }
    @After public void cleanup() throws Exception {
        if (gateway != null) gateway.close();
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); if (store.containsAlias(alias)) store.deleteEntry(alias);
        assertTrue(folder.getName().startsWith("ai-gateway-test-"));
        File[] files = folder.listFiles(); if (files != null) for (File child : files) { assertEquals(folder.getCanonicalFile(), child.getCanonicalFile().getParentFile()); assertTrue(child.delete()); }
        assertTrue(folder.delete());
    }
    private AiGateway create(Exchange exchange) throws Exception {
        return create(exchange, (bank, image) -> { throw new AssertionError("No user image expected"); });
    }
    private AiGateway create(Exchange exchange, AiGateway.ResourceResolver resources) throws Exception {
        OkHttpClient client = HubImportClient.newAnonymousClient().newBuilder().addInterceptor(chain -> {
            try {
                Buffer buffer = new Buffer(); chain.request().body().writeTo(buffer); JSONObject body = new JSONObject(buffer.readUtf8());
                int index = requests.size(); requests.add(chain.request()); bodies.add(body); return exchange.answer(chain.request(), body, index);
            } catch (java.io.IOException exception) { throw exception; }
            catch (Exception exception) { throw new java.io.IOException(exception); }
        }).build();
        return new AiGateway(file, alias, resources, client);
    }
    private static Response model(Request request, String output) throws Exception {
        return raw(request, 200, new JSONObject().put("id", "mock-response").put("choices", new JSONArray().put(new JSONObject()
                .put("finish_reason", "stop").put("message", new JSONObject().put("content", output))))
                .put("usage", new JSONObject().put("total_tokens", 10)).toString());
    }
    private static Response raw(Request request, int code, String body) {
        return new Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("Synthetic")
                .body(ResponseBody.create(body, MediaType.get("application/json"))).build();
    }
    private static JSONObject config(String key) throws Exception {
        return new JSONObject().put("enabled", true).put("useCustom", true).put("baseUrl", "https://model.invalid/v1").put("model", "fictional-model").put("apiKey", key);
    }
    private static JSONObject input() throws Exception {
        JSONArray block = new JSONArray().put(new JSONObject().put("type", "text").put("text", "fictional test material"));
        return new JSONObject().put("bankId", "fixture-bank").put("input", new JSONObject().put("protocolVersion", 1).put("maxScore", 5).put("scoreStep", 0.5)
                .put("question", block).put("answer", block).put("referenceAnswer", block));
    }
    private interface Attempt { void run() throws Exception; }
    private static void rejects(String code, Attempt attempt) throws Exception { try { attempt.run(); fail("Expected " + code); } catch (StorageException exception) { assertEquals(code, exception.code); } }

    @Test public void keyIsEncryptedAtRestAndNeverReturnedByStatus() throws Exception {
        gateway = create((request, body, i) -> model(request, "{\"score\":2.5,\"feedback\":\"ok\"}"));
        String key = "synthetic-test-key-123"; JSONObject saved = gateway.update(config(key));
        assertTrue(saved.getBoolean("apiKeyConfigured")); assertFalse(saved.has("apiKey")); assertFalse(saved.toString().contains(key));
        String envelope = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8); assertFalse(envelope.contains(key)); assertFalse(envelope.contains("model.invalid"));
        AiGateway reopened = create((request, body, i) -> model(request, "{\"score\":2.5,\"feedback\":\"ok\"}"));
        try { assertTrue(reopened.status().getBoolean("apiKeyConfigured")); assertEquals("fictional-model", reopened.status().getString("model")); }
        finally { reopened.close(); }
        assertTrue(gateway.update(new JSONObject().put("autoGrade", true)).getBoolean("apiKeyConfigured"));
        assertFalse(gateway.update(new JSONObject().put("clearApiKey", true)).getBoolean("apiKeyConfigured"));
    }

    @Test public void invalidAndCleartextAddressesDoNotReplaceSavedConfiguration() throws Exception {
        gateway = create((request, body, i) -> { throw new AssertionError("No network expected"); }); gateway.update(config("synthetic-key"));
        for (String endpoint : new String[]{"http://localhost:1234/v1", "http://public.example/v1"}) rejects("AI_HTTPS_REQUIRED", () -> gateway.update(new JSONObject().put("baseUrl", endpoint)));
        for (String endpoint : new String[]{"https://user:password@model.invalid/v1", "https://model.invalid/v1?key=bad", "https://model.invalid/v1#fragment"}) rejects("AI_CONFIG", () -> gateway.update(new JSONObject().put("baseUrl", endpoint)));
        assertEquals("https://model.invalid/v1", gateway.status().getString("baseUrl")); assertEquals(0, requests.size());
        rejects("AI_KEY_REENTRY_REQUIRED", () -> gateway.update(new JSONObject().put("baseUrl", "https://different.invalid/v1")));
        assertEquals("https://model.invalid/v1", gateway.status().getString("baseUrl"));
        String version = gateway.status().getString("configurationVersion");
        gateway.update(new JSONObject().put("model", "changed-model"));
        rejects("AI_CONFIG_CHANGED", () -> gateway.generate(input().put("configurationVersion", version)));
        assertEquals(0, requests.size());
    }

    @Test public void modelUsesNativeBearerButAnyReflectedKeyIsRedacted() throws Exception {
        String key = "synthetic-reflected-key";
        gateway = create((request, body, i) -> model(request, "{\"score\":2.5,\"feedback\":\"" + key + "\"}")); gateway.update(config(key));
        JSONObject result = gateway.generate(input()); assertFalse(result.toString().contains(key)); assertTrue(result.getString("output").contains("[redacted]"));
        assertEquals(1, requests.size()); assertEquals("Bearer " + key, requests.get(0).header("Authorization")); assertNull(requests.get(0).header("Cookie"));
        assertEquals("https://model.invalid/v1/chat/completions", requests.get(0).url().toString());
        assertEquals("fictional-model", bodies.get(0).getString("model")); assertFalse(bodies.get(0).toString().contains(key));
    }

    @Test public void imageUrlsAreRejectedBeforeAnyNetworkRequest() throws Exception {
        gateway = create((request, body, i) -> { throw new AssertionError("No network expected"); }); gateway.update(config("synthetic-key"));
        JSONObject request = input(); request.getJSONObject("input").put("answer", new JSONArray().put(new JSONObject().put("type", "image").put("assetId", "a".repeat(64)).put("url", "https://untrusted.invalid/image")));
        rejects("INVALID_AI_INPUT", () -> gateway.generate(request)); assertEquals(0, requests.size());
    }

    @Test public void temporaryAttachmentsArePerCallPreferLocalBytesAndNeverChangeSavedSettings() throws Exception {
        JSONObject attachment = png(), request = withAttachments(attachment); List<String> resolved = new ArrayList<>();
        gateway = create((outbound, body, i) -> model(outbound, "{\"score\":2.5,\"feedback\":\"fictional image\"}"), (bank, id) -> {
            assertEquals("fixture-bank", bank); resolved.add(id); return attachment;
        });
        gateway.update(config("synthetic-key")); enableSyntheticVision(gateway);
        byte[] saved = Files.readAllBytes(file.toPath());
        request.put("configurationVersion", gateway.status().getString("configurationVersion"));
        assertTrue(gateway.generate(request).getString("output").contains("fictional image")); assertTrue(resolved.isEmpty());
        JSONArray content = bodies.get(0).getJSONArray("messages").getJSONObject(1).getJSONArray("content"); boolean found = false;
        for (int i = 0; i < content.length(); i++) if (content.getJSONObject(i).optString("type").equals("image_url")) {
            assertEquals("data:image/png;base64," + attachment.getString("data"), content.getJSONObject(i).getJSONObject("image_url").getString("url")); found = true;
        }
        assertTrue(found);
        JSONObject second = withAttachments(attachment); second.remove("attachments"); gateway.generate(second);
        assertEquals(Arrays.asList(attachment.getString("assetId")), resolved); assertEquals(2, requests.size());
        assertArrayEquals(saved, Files.readAllBytes(file.toPath())); assertFalse(gateway.status().has("attachments"));
        assertFalse(gateway.status().toString().contains(attachment.getString("data")));
    }

    @Test public void attachmentValidatorAcceptsSupportedImageFormatsWithoutVisionOrConfiguration() throws Exception {
        android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(2, 2, android.graphics.Bitmap.Config.ARGB_8888);
        try {
            for (android.graphics.Bitmap.CompressFormat format : new android.graphics.Bitmap.CompressFormat[]{android.graphics.Bitmap.CompressFormat.PNG, android.graphics.Bitmap.CompressFormat.JPEG, android.graphics.Bitmap.CompressFormat.WEBP}) {
                ByteArrayOutputStream output = new ByteArrayOutputStream(); assertTrue(bitmap.compress(format, 90, output));
                String mime = format == android.graphics.Bitmap.CompressFormat.PNG ? "image/png" : format == android.graphics.Bitmap.CompressFormat.JPEG ? "image/jpeg" : "image/webp";
                JSONObject attachment = attachment(output.toByteArray(), mime), args = withAttachments(attachment);
                Map<String, JSONObject> accepted = AiGateway.validateAttachments(args, args.getJSONObject("input"));
                assertEquals(1, accepted.size()); assertEquals(mime, accepted.get(attachment.getString("assetId")).getString("mime"));
            }
        } finally { bitmap.recycle(); }
        JSONObject gif = attachment(android.util.Base64.decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", android.util.Base64.NO_WRAP), "image/gif");
        JSONObject args = withAttachments(gif); assertEquals(1, AiGateway.validateAttachments(args, args.getJSONObject("input")).size());
        assertFalse(file.exists()); assertEquals(0, requests.size());
    }

    @Test public void malformedDuplicateUnreferencedAndUnexpectedAttachmentFieldsNeverReachTheModel() throws Exception {
        gateway = create((request, body, i) -> { throw new AssertionError("No network expected"); }); gateway.update(config("synthetic-key"));
        JSONObject original = png();
        rejects("INVALID_AI_INPUT", () -> gateway.generate(input().put("attachments", new JSONObject())));
        rejects("INVALID_AI_INPUT", () -> gateway.generate(input().put("attachments", new JSONArray().put(original))));
        rejects("INVALID_AI_INPUT", () -> gateway.generate(withAttachments(original, original)));
        rejects("INVALID_AI_INPUT", () -> gateway.generate(withAttachments(copy(original).put("url", "https://untrusted.invalid/image"))));
        JSONObject missing = copy(original); missing.remove("mime"); rejects("INVALID_AI_INPUT", () -> gateway.generate(withAttachments(missing)));
        rejects("INVALID_AI_INPUT", () -> gateway.generate(withAttachments(copy(original).put("mime", 42))));
        rejects("INVALID_AI_INPUT", () -> gateway.generate(withAttachments(copy(original).put("assetId", "A".repeat(64)))));
        assertEquals(0, requests.size());
    }

    @Test public void alteredHashMimeEncodingAndUnparseableBoundsRejectBeforeVisionAndNetwork() throws Exception {
        gateway = create((request, body, i) -> { throw new AssertionError("No network expected"); }); gateway.update(config("synthetic-key"));
        JSONObject original = png(); String data = original.getString("data");
        for (JSONObject invalid : new JSONObject[]{copy(original).put("assetId", "0".repeat(64)), copy(original).put("mime", "image/jpeg"),
                copy(original).put("mime", "image/svg+xml"), copy(original).put("data", data + "\n"), copy(original).put("data", data.substring(0, data.length() - 1)),
                attachment(new byte[]{1, 2, 3, 4}, "image/png"), attachment(pngDimensions(0, 1), "image/png")})
            rejects("AI_IMAGE_UNAVAILABLE", () -> gateway.generate(withAttachments(invalid)));
        rejects("AI_INPUT_LIMIT", () -> gateway.generate(withAttachments(attachment(pngDimensions(20000, 1), "image/png"))));
        rejects("AI_INPUT_LIMIT", () -> gateway.generate(withAttachments(attachment(pngDimensions(4001, 4001), "image/png"))));
        rejects("AI_CONFIG_CHANGED", () -> gateway.generate(withAttachments(original).put("configurationVersion", "stale-synthetic-version")));
        assertEquals(0, requests.size());
    }

    @Test public void attachmentAndFinalInputImageBudgetsStayAtEightImagesAndEightMiB() throws Exception {
        gateway = create((request, body, i) -> { throw new AssertionError("No network expected"); }); gateway.update(config("synthetic-key")); enableSyntheticVision(gateway);
        JSONObject small = png(); JSONArray nine = new JSONArray(); for (int i = 0; i < 9; i++) nine.put(small);
        rejects("AI_INPUT_LIMIT", () -> gateway.generate(withAttachments(small).put("attachments", nine)));
        JSONObject repeated = withAttachments(small); JSONArray blocks = repeated.getJSONObject("input").getJSONArray("answer");
        for (int i = 1; i < 9; i++) blocks.put(new JSONObject().put("type", "image").put("assetId", small.getString("assetId")));
        rejects("AI_INPUT_LIMIT", () -> gateway.generate(repeated));
        byte[] image = android.util.Base64.decode(small.getString("data"), android.util.Base64.NO_WRAP);
        byte[] large = Arrays.copyOf(image, 4 * 1024 * 1024); JSONObject one = attachment(large, "image/png");
        large[large.length - 1] = 1; JSONObject two = attachment(large, "image/png");
        large[large.length - 1] = 2; JSONObject three = attachment(large, "image/png");
        JSONObject exact = withAttachments(one, two); assertEquals(2, AiGateway.validateAttachments(exact, exact.getJSONObject("input")).size());
        rejects("AI_INPUT_LIMIT", () -> gateway.generate(withAttachments(one, two, three)));
        exact.getJSONObject("input").getJSONArray("answer").put(new JSONObject().put("type", "image").put("assetId", one.getString("assetId")));
        rejects("AI_INPUT_LIMIT", () -> gateway.generate(exact));
        rejects("AI_INPUT_LIMIT", () -> gateway.generate(withAttachments(attachment(Arrays.copyOf(image, 4 * 1024 * 1024 + 1), "image/png"))));
        assertEquals(0, requests.size());
    }

    @Test public void attachmentMapCannotBypassVisionAndCorruptStoredImagesAreNotSent() throws Exception {
        JSONObject image = png();
        gateway = create((request, body, i) -> { throw new AssertionError("No network expected"); }, (bank, id) -> copy(image).put("data", "broken"));
        gateway.update(config("synthetic-key")); rejects("AI_VISION_UNSUPPORTED", () -> gateway.generate(withAttachments(image)));
        enableSyntheticVision(gateway); JSONObject stored = withAttachments(image); stored.remove("attachments");
        rejects("AI_IMAGE_UNAVAILABLE", () -> gateway.generate(stored)); assertEquals(0, requests.size());
    }

    private static JSONObject copy(JSONObject value) throws Exception { return new JSONObject(value.toString()); }
    private static JSONObject png() throws Exception {
        return attachment(android.util.Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=", android.util.Base64.NO_WRAP), "image/png");
    }
    private static JSONObject attachment(byte[] bytes, String mime) throws Exception {
        return new JSONObject().put("assetId", BankRepository.sha256(bytes)).put("mime", mime).put("data", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
    }
    private static JSONObject withAttachments(JSONObject... attachments) throws Exception {
        JSONArray list = new JSONArray(), images = new JSONArray();
        for (JSONObject attachment : attachments) { list.put(attachment); images.put(new JSONObject().put("type", "image").put("assetId", attachment.opt("assetId"))); }
        JSONObject args = input().put("attachments", list); args.getJSONObject("input").put("answer", images); return args;
    }
    private static byte[] pngDimensions(int width, int height) throws Exception {
        byte[] bytes = android.util.Base64.decode(png().getString("data"), android.util.Base64.NO_WRAP);
        for (int i = 0; i < 4; i++) { bytes[16 + i] = (byte)(width >>> (24 - i * 8)); bytes[20 + i] = (byte)(height >>> (24 - i * 8)); }
        CRC32 crc = new CRC32(); crc.update(bytes, 12, 17); long value = crc.getValue();
        for (int i = 0; i < 4; i++) bytes[29 + i] = (byte)(value >>> (24 - i * 8)); return bytes;
    }
    private static void enableSyntheticVision(AiGateway value) throws Exception {
        // The fixture skips real OCR/model billing. No production setter or persisted capability is added.
        java.lang.reflect.Field field = AiGateway.class.getDeclaredField("profile"); field.setAccessible(true); ((JSONObject)field.get(value)).put("vision", true);
    }

    @Test public void providerErrorsAreMappedWithoutReturningRawBodyOrFollowingRedirect() throws Exception {
        gateway = create((request, body, i) -> raw(request, 302, "synthetic-key private provider body").newBuilder().header("Location", "https://elsewhere.invalid/").build());
        gateway.update(config("synthetic-key"));
        try { gateway.generate(input()); fail(); } catch (StorageException exception) { assertEquals("AI_CONFIG", exception.code); assertFalse(exception.getMessage().contains("synthetic-key")); assertFalse(exception.getMessage().contains("provider body")); }
        assertEquals(1, requests.size());
    }

    @Test public void diagnosticsPersistTextPassWithoutClaimingUnprovenImageSupport() throws Exception {
        gateway = create((request, body, i) -> model(request, i == 0 ? "{\"score\":2.5,\"feedback\":\"文字正常\"}" : "{\"score\":0,\"feedback\":\"WRONG\"}")); gateway.update(config("synthetic-key"));
        JSONObject report = gateway.testConnection(); assertEquals(2, report.getInt("calls")); assertEquals("partial", report.getString("status"));
        assertFalse(gateway.status().getBoolean("vision")); assertTrue(gateway.status().has("testReport"));
        assertFalse(report.toString().contains("synthetic-key"));
        String imageUrl = bodies.get(1).getJSONArray("messages").getJSONObject(1).getJSONArray("content")
                .getJSONObject(1).getJSONObject("image_url").getString("url");
        assertTrue(imageUrl.startsWith("data:image/png;base64,"));
        byte[] png = android.util.Base64.decode(imageUrl.substring("data:image/png;base64,".length()), android.util.Base64.NO_WRAP);
        android.graphics.Bitmap image = android.graphics.BitmapFactory.decodeByteArray(png, 0, png.length);
        assertNotNull(image);
        try { assertEquals(520, image.getWidth()); assertEquals(150, image.getHeight()); }
        finally { image.recycle(); }
        gateway.update(new JSONObject().put("model", "different-model")); assertFalse(gateway.status().has("testReport")); assertFalse(gateway.status().getBoolean("vision"));
    }

    @Test public void damagedEncryptedSettingsRemainIntactRatherThanResettingToDefaults() throws Exception {
        gateway = create((request, body, i) -> { throw new AssertionError(); }); gateway.update(config("synthetic-key"));
        Files.write(file.toPath(), "{\"schemaVersion\":1,\"iv\":\"AA==\",\"ciphertext\":\"AA==\"}".getBytes(StandardCharsets.UTF_8));
        String damaged = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
        rejects("AI_SETTINGS_UNAVAILABLE", () -> create((request, body, i) -> { throw new AssertionError(); })); assertEquals(damaged, new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
    }

    // A fake connected Hub account for the free AI quota; the token is synthetic.
    private static final String DEVICE_TOKEN = "qfd_" + "B".repeat(43);
    private static final class FakeHub implements AiGateway.HubToken {
        String token = DEVICE_TOKEN; final List<String> invalidated = new ArrayList<>();
        @Override public String token() { return token; }
        @Override public void invalidate(String value) { invalidated.add(value); if (value.equals(token)) token = null; }
    }
    private static Response officialError(Request request, int status, String code) throws Exception {
        return raw(request, status, new JSONObject().put("error", new JSONObject().put("code", code).put("message", "synthetic gateway text " + DEVICE_TOKEN)).toString());
    }
    private static boolean official(Request request) { return request.url().toString().equals("https://quizforge.treenewbee.cloud/api/ai/v1/chat/completions"); }

    @Test public void settingsSavedBeforeGradingSourcesMeanTheCustomModel() throws Exception {
        gateway = create((request, body, i) -> model(request, "{\"score\":2.5,\"feedback\":\"ok\"}")); gateway.update(config("synthetic-key"));
        java.lang.reflect.Field field = AiGateway.class.getDeclaredField("profile"); field.setAccessible(true);
        JSONObject legacy = new JSONObject(field.get(gateway).toString()); legacy.remove("useOfficial"); legacy.remove("useCustom");
        java.lang.reflect.Method persist = AiGateway.class.getDeclaredMethod("persist", JSONObject.class); persist.setAccessible(true); persist.invoke(gateway, legacy);
        AiGateway reopened = create((request, body, i) -> model(request, "{\"score\":2.5,\"feedback\":\"ok\"}"));
        try {
            JSONObject status = reopened.status(); assertTrue(status.getBoolean("useCustom")); assertFalse(status.getBoolean("useOfficial"));
            assertEquals("openai-compatible", reopened.generate(input()).getString("provider"));
        } finally { reopened.close(); }
        // Enabling with no source is allowed (the page asks for one); the custom source needs its address and model.
        AiGateway fresh = new AiGateway(new File(folder, "fresh.enc"), alias + ".fresh", (bank, id) -> null, HubImportClient.newAnonymousClient());
        try {
            assertTrue(fresh.update(new JSONObject().put("enabled", true)).getBoolean("enabled"));
            rejects("AI_NOT_CONFIGURED", () -> fresh.update(new JSONObject().put("useCustom", true)));
            rejects("AI_NOT_CONFIGURED", () -> fresh.generate(input()));
        } finally { fresh.close(); KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); if (store.containsAlias(alias + ".fresh")) store.deleteEntry(alias + ".fresh"); }
    }

    @Test public void freeQuotaUsesTheFixedGatewayDeviceTokenVisionAndJson() throws Exception {
        FakeHub hub = new FakeHub(); JSONObject attachment = png();
        gateway = create((request, body, i) -> model(request, "{\"score\":2.5,\"feedback\":\"" + DEVICE_TOKEN + "\"}"), (bank, id) -> attachment); gateway.attachHub(hub);
        String version = gateway.update(new JSONObject().put("enabled", true).put("useOfficial", true)).getString("configurationVersion");
        assertFalse(gateway.status().getBoolean("vision"));
        JSONObject result = gateway.generate(withAttachments(attachment).put("configurationVersion", version));
        assertEquals("quizforge-official", result.getString("provider")); assertEquals("quizforge-official", result.getString("model"));
        assertFalse(result.toString().contains(DEVICE_TOKEN));
        assertEquals(1, requests.size()); assertTrue(official(requests.get(0))); assertEquals("Bearer " + DEVICE_TOKEN, requests.get(0).header("Authorization"));
        JSONObject sent = bodies.get(0); assertEquals("quizforge-official", sent.getString("model")); assertFalse(sent.getBoolean("stream"));
        assertEquals("json_object", sent.getJSONObject("response_format").getString("type")); assertEquals(8192, sent.getInt("max_tokens"));
        JSONArray parts = sent.getJSONArray("messages").getJSONObject(1).getJSONArray("content"); boolean image = false;
        for (int i = 0; i < parts.length(); i++) if (parts.getJSONObject(i).optString("type").equals("image_url")) image = parts.getJSONObject(i).getJSONObject("image_url").getString("url").startsWith("data:image/png;base64,");
        assertTrue(image);
        assertFalse(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8).contains(DEVICE_TOKEN));
    }

    @Test public void freeQuotaAloneMapsGatewayErrorsAndLoginLossClearsTheToken() throws Exception {
        FakeHub hub = new FakeHub(); int[] status = {402}; String[] code = {"AI_BALANCE_EXHAUSTED"};
        gateway = create((request, body, i) -> officialError(request, status[0], code[0])); gateway.attachHub(hub);
        gateway.update(new JSONObject().put("enabled", true).put("useOfficial", true));
        Object[][] cases = {{402, "AI_BALANCE_EXHAUSTED", "AI_OFFICIAL_BALANCE"}, {503, "AI_DISABLED", "AI_OFFICIAL_UNAVAILABLE"}, {404, "OFFICIAL_AI_DISABLED", "AI_OFFICIAL_UNAVAILABLE"},
                {429, "AI_BUSY", "AI_RATE_LIMIT"}, {502, "AI_UPSTREAM_FAILED", "AI_UPSTREAM"}, {413, "AI_REQUEST_TOO_LARGE", "AI_INPUT_LIMIT"}, {400, "AI_REQUEST_UNSUPPORTED", "AI_CONFIG"}};
        for (Object[] item : cases) {
            status[0] = (Integer) item[0]; code[0] = (String) item[1];
            try { gateway.generate(input()); fail(); } catch (StorageException exception) { assertEquals((String) item[2], exception.code); assertFalse(exception.getMessage().contains(DEVICE_TOKEN)); assertFalse(exception.getMessage().contains("synthetic gateway text")); }
        }
        assertTrue(hub.invalidated.isEmpty()); assertEquals(DEVICE_TOKEN, hub.token);
        status[0] = 401; code[0] = "DEVICE_TOKEN_INVALID";
        rejects("AI_OFFICIAL_LOGIN", () -> gateway.generate(input()));
        assertEquals(List.of(DEVICE_TOKEN), hub.invalidated); assertNull(hub.token);
        int sent = requests.size();
        rejects("AI_OFFICIAL_LOGIN", () -> gateway.generate(input())); assertEquals(sent, requests.size());
    }

    @Test public void bothSourcesFallBackToTheCustomModelOnlyForUnavailableFreeQuota() throws Exception {
        FakeHub hub = new FakeHub(); int[] status = {402}; String[] code = {"AI_BALANCE_EXHAUSTED"};
        gateway = create((request, body, i) -> official(request) ? officialError(request, status[0], code[0]) : model(request, "{\"score\":2.5,\"feedback\":\"custom\"}"));
        gateway.attachHub(hub); gateway.update(config("synthetic-key").put("useOfficial", true));
        Object[][] fallback = {{402, "AI_BALANCE_EXHAUSTED"}, {503, "AI_DISABLED"}, {429, "AI_BUSY"}, {502, "AI_UPSTREAM_FAILED"}, {404, "OFFICIAL_AI_DISABLED"}, {401, "DEVICE_TOKEN_INVALID"}};
        for (Object[] item : fallback) {
            requests.clear(); bodies.clear(); status[0] = (Integer) item[0]; code[0] = (String) item[1];
            JSONObject result = gateway.generate(input());
            assertEquals("openai-compatible", result.getString("provider")); assertEquals("fictional-model", result.getString("model"));
            assertEquals(2, requests.size()); assertTrue(official(requests.get(0))); assertEquals("Bearer synthetic-key", requests.get(1).header("Authorization"));
            assertFalse(bodies.get(1).toString().contains(DEVICE_TOKEN));
        }
        // After the lost login the free quota is skipped without a request.
        requests.clear(); assertEquals("openai-compatible", gateway.generate(input()).getString("provider")); assertEquals(1, requests.size()); assertFalse(official(requests.get(0)));
        // Request errors are not a reason to switch sources.
        hub.token = DEVICE_TOKEN; requests.clear(); status[0] = 413; code[0] = "AI_REQUEST_TOO_LARGE";
        rejects("AI_INPUT_LIMIT", () -> gateway.generate(input())); assertEquals(1, requests.size());
        // A working free quota grades first and is recorded as the provider.
        gateway = create((request, body, i) -> model(request, "{\"score\":2.5,\"feedback\":\"official\"}")); gateway.attachHub(hub);
        requests.clear(); assertEquals("quizforge-official", gateway.generate(input()).getString("provider")); assertEquals(1, requests.size()); assertTrue(official(requests.get(0)));
    }

    @Test public void freeQuotaTimeoutsAndNetworkFailuresFallBack() throws Exception {
        FakeHub hub = new FakeHub();
        gateway = create((request, body, i) -> { if (official(request)) throw new java.io.IOException("synthetic offline"); return model(request, "{\"score\":2.5,\"feedback\":\"custom\"}"); });
        gateway.attachHub(hub); gateway.update(config("synthetic-key").put("useOfficial", true));
        assertEquals("openai-compatible", gateway.generate(input()).getString("provider")); assertEquals(2, requests.size());
    }

    @Test public void modelTestOnlyTestsTheCustomModelAndSourceChangesStopQueuedRequests() throws Exception {
        FakeHub hub = new FakeHub();
        gateway = create((request, body, i) -> model(request, i == 0 ? "{\"score\":2.5,\"feedback\":\"文字正常\"}" : "{\"score\":0,\"feedback\":\"WRONG\"}"));
        gateway.attachHub(hub); gateway.update(config("synthetic-key").put("useOfficial", true));
        gateway.testConnection();
        for (Request request : requests) { assertFalse(official(request)); assertEquals("Bearer synthetic-key", request.header("Authorization")); }
        String version = gateway.status().getString("configurationVersion");
        gateway.update(new JSONObject().put("useOfficial", false));
        rejects("AI_CONFIG_CHANGED", () -> gateway.generate(input().put("configurationVersion", version)));
    }

    @Test public void visionCheckToleratesOneMisreadCharacterLikeTheWeb() {
        assertTrue(AiGateway.closeEnough("AB5DEF", "ABSDEF")); assertTrue(AiGateway.closeEnough("ab-sd ef", "ABSDEF")); assertTrue(AiGateway.closeEnough("ABSDE", "ABSDEF"));
        assertFalse(AiGateway.closeEnough("A85DEF", "ABSDEF")); assertFalse(AiGateway.closeEnough("WRONG", "ABSDEF")); assertFalse(AiGateway.closeEnough("", "ABSDEF"));
    }
}
