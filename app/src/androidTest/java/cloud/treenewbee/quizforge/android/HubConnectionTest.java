package cloud.treenewbee.quizforge.android;

import static org.junit.Assert.*;

import android.content.Context;
import android.net.Uri;
import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;

/** A fake Hub only: no real account, password, code or device token is used. */
@RunWith(AndroidJUnit4.class)
public final class HubConnectionTest {
    private static final String TOKEN = "qfd_" + "A".repeat(43), CODE = "c".repeat(43);
    private File folder, file;
    private String alias;
    private final List<Request> requests = new ArrayList<>();
    private final List<String> bodies = new ArrayList<>();
    private interface Exchange { Response answer(Request request, String body, int index) throws Exception; }

    @Before public void setup() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String id = UUID.randomUUID().toString(); folder = new File(context.getCacheDir(), "hub-connection-test-" + id); assertTrue(folder.mkdir());
        file = new File(folder, "hub.enc"); alias = context.getPackageName() + ".hub-test." + id; requests.clear(); bodies.clear();
    }
    @After public void cleanup() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); if (store.containsAlias(alias)) store.deleteEntry(alias);
        assertTrue(folder.getName().startsWith("hub-connection-test-"));
        File[] files = folder.listFiles(); if (files != null) for (File child : files) assertTrue(child.delete());
        assertTrue(folder.delete());
    }
    private HubConnection create(Exchange exchange) {
        OkHttpClient client = HubImportClient.newAnonymousClient().newBuilder().addInterceptor(chain -> {
            try {
                String body = ""; if (chain.request().body() != null) { Buffer buffer = new Buffer(); chain.request().body().writeTo(buffer); body = buffer.readUtf8(); }
                int index = requests.size(); requests.add(chain.request()); bodies.add(body); return exchange.answer(chain.request(), body, index);
            } catch (java.io.IOException exception) { throw exception; }
            catch (Exception exception) { throw new java.io.IOException(exception); }
        }).build();
        return new HubConnection(file, alias, client, "Fake\u0007 Tablet");
    }
    private static Response json(Request request, int code, String body) {
        return new Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("Synthetic")
                .body(ResponseBody.create(body, MediaType.get("application/json"))).build();
    }
    private static Response granted(Request request) throws Exception {
        return json(request, 200, new JSONObject().put("token", TOKEN).put("device", new JSONObject().put("id", "d1").put("name", "Fake Tablet").put("client", "android"))
                .put("user", new JSONObject().put("name", "测试用户")).toString());
    }
    private interface Attempt { void run() throws Exception; }
    private static void rejects(String code, Attempt attempt) throws Exception { try { attempt.run(); fail("Expected " + code); } catch (StorageException exception) { assertEquals(code, exception.code); } }
    private static Uri callback(String state, String code) { return Uri.parse("quizforge://hub/connect?code=" + code + "&state=" + state); }
    private HubConnection loggedIn() throws Exception {
        HubConnection hub = create((request, body, i) -> granted(request));
        String state = Uri.parse(hub.start().getString("authorizeUrl")).getQueryParameter("state");
        hub.complete(callback(state, CODE)); requests.clear(); bodies.clear(); return hub;
    }

    @Test public void authorizeUrlUsesFixedOriginAndroidRedirectAndPkceS256() throws Exception {
        HubConnection hub = create((request, body, i) -> { throw new AssertionError("No network expected"); });
        Uri url = Uri.parse(hub.start().getString("authorizeUrl"));
        assertEquals("https", url.getScheme()); assertEquals("quizforge.treenewbee.cloud", url.getHost()); assertEquals("/connect/authorize", url.getPath());
        assertEquals("1", url.getQueryParameter("v")); assertEquals("android", url.getQueryParameter("client"));
        assertEquals("quizforge://hub/connect", url.getQueryParameter("redirect_uri")); assertEquals("S256", url.getQueryParameter("code_challenge_method"));
        assertTrue(url.getQueryParameter("state").matches("[A-Za-z0-9_-]{32}")); assertTrue(url.getQueryParameter("code_challenge").matches("[A-Za-z0-9_-]{43}"));
        assertEquals("Fake Tablet", url.getQueryParameter("device_name")); assertEquals(7, url.getQueryParameterNames().size());
        assertFalse(hub.summary().getBoolean("connected")); assertEquals(0, requests.size());
    }

    @Test public void callbackChecksStateOnceExchangesCodeNativelyAndSealsTheToken() throws Exception {
        HubConnection hub = create((request, body, i) -> granted(request));
        Uri url = Uri.parse(hub.start().getString("authorizeUrl")); String state = url.getQueryParameter("state");
        rejects("HUB_CONNECT_EXPIRED", () -> hub.complete(callback("forged-state", CODE)));
        rejects("HUB_CONNECT_INVALID", () -> hub.complete(Uri.parse("quizforge://hub/import?code=" + CODE + "&state=" + state)));
        assertEquals(0, requests.size());
        JSONObject summary = hub.complete(callback(state, CODE));
        assertTrue(summary.getBoolean("connected")); assertEquals("测试用户", summary.getJSONObject("user").getString("name")); assertEquals("android", summary.getJSONObject("device").getString("client"));
        assertFalse(summary.toString().contains(TOKEN));
        assertEquals(1, requests.size()); assertEquals("https://quizforge.treenewbee.cloud/api/connect/token", requests.get(0).url().toString()); assertNull(requests.get(0).header("Authorization"));
        JSONObject sent = new JSONObject(bodies.get(0));
        assertEquals(1, sent.getInt("v")); assertEquals("android", sent.getString("client")); assertEquals(CODE, sent.getString("code")); assertEquals("quizforge://hub/connect", sent.getString("redirect_uri"));
        String challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(sent.getString("code_verifier").getBytes(StandardCharsets.US_ASCII)), Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        assertEquals(url.getQueryParameter("code_challenge"), challenge);
        // The state is single use, and the token is never stored in plain text.
        rejects("HUB_CONNECT_EXPIRED", () -> hub.complete(callback(state, CODE))); assertEquals(1, requests.size());
        assertFalse(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8).contains(TOKEN));
        HubConnection reopened = create((request, body, i) -> { throw new AssertionError(); });
        assertEquals(TOKEN, reopened.token()); assertTrue(reopened.summary().getBoolean("connected"));
    }

    @Test public void deniedOrRejectedLoginsSaveNothing() throws Exception {
        HubConnection hub = create((request, body, i) -> json(request, 400, "{\"error\":{\"code\":\"INVALID_GRANT\",\"message\":\"授权码无效\"}}"));
        String state = Uri.parse(hub.start().getString("authorizeUrl")).getQueryParameter("state");
        rejects("HUB_CONNECT_DENIED", () -> hub.complete(Uri.parse("quizforge://hub/connect?error=access_denied&state=" + state)));
        String second = Uri.parse(hub.start().getString("authorizeUrl")).getQueryParameter("state");
        rejects("HUB_CONNECT_INVALID", () -> hub.complete(callback(second, "short")));
        String third = Uri.parse(hub.start().getString("authorizeUrl")).getQueryParameter("state");
        rejects("HUB_CONNECT_INVALID", () -> hub.complete(callback(third, CODE)));
        assertNull(hub.token()); assertFalse(file.exists());
    }

    @Test public void accountReadsBalanceAndARejectedTokenLogsOut() throws Exception {
        HubConnection hub = loggedIn();
        HubConnection reader = create((request, body, i) -> i == 0
                ? json(request, 200, "{\"user\":{\"name\":\"测试用户\"},\"device\":{\"id\":\"d1\",\"name\":\"Fake Tablet\",\"client\":\"android\"},\"ai\":{\"enabled\":true,\"model\":\"fake\",\"vision\":true,\"balance\":42000}}")
                : json(request, 401, "{\"error\":{\"code\":\"DEVICE_TOKEN_INVALID\"}}"));
        JSONObject account = reader.account();
        assertEquals(42000, account.getJSONObject("ai").getLong("balance")); assertTrue(account.getJSONObject("ai").getBoolean("enabled"));
        assertEquals("https://quizforge.treenewbee.cloud/api/connect/me", requests.get(0).url().toString()); assertEquals("Bearer " + TOKEN, requests.get(0).header("Authorization"));
        JSONObject expired = reader.account(); assertFalse(expired.getBoolean("connected")); assertTrue(expired.getBoolean("expired"));
        assertNull(reader.token()); assertFalse(file.exists()); assertNotNull(hub);
    }

    @Test public void redeemMapsHubErrorsAndUpdatesBalance() throws Exception {
        loggedIn();
        HubConnection hub = create((request, body, i) -> {
            String code = new JSONObject(body).getString("code");
            if (code.equals("AI-BAD")) return json(request, 400, "{\"error\":{\"code\":\"REDEEM_CODE_INVALID\",\"message\":\"x\"}}");
            if (code.equals("AI-LOCK")) return json(request, 429, "{\"error\":{\"code\":\"REDEEM_LOCKED\"}}");
            if (code.equals("AI-GONE")) return json(request, 401, "{\"error\":{\"code\":\"DEVICE_TOKEN_INVALID\"}}");
            return json(request, 200, "{\"added\":50000,\"balance\":92000}");
        });
        rejects("REDEEM_CODE_INVALID", () -> hub.redeem(" "));
        assertEquals(0, requests.size());
        JSONObject added = hub.redeem(" AI-GOOD "); assertEquals(50000, added.getLong("added")); assertEquals(92000, added.getLong("balance"));
        assertEquals("AI-GOOD", new JSONObject(bodies.get(0)).getString("code"));
        rejects("REDEEM_CODE_INVALID", () -> hub.redeem("AI-BAD")); rejects("REDEEM_LOCKED", () -> hub.redeem("AI-LOCK"));
        rejects("HUB_LOGIN_REQUIRED", () -> hub.redeem("AI-GONE")); assertNull(hub.token());
        rejects("HUB_LOGIN_REQUIRED", () -> hub.redeem("AI-GOOD"));
    }

    @Test public void logoutForgetsTheTokenEvenWhenTheHubCannotBeReached() throws Exception {
        loggedIn();
        HubConnection hub = create((request, body, i) -> { throw new java.io.IOException("offline"); });
        assertFalse(hub.logout().getBoolean("connected")); assertNull(hub.token()); assertFalse(file.exists());
        assertEquals("https://quizforge.treenewbee.cloud/api/connect/logout", requests.get(0).url().toString()); assertEquals("Bearer " + TOKEN, requests.get(0).header("Authorization"));
        assertNull(create((request, body, i) -> { throw new AssertionError(); }).token());
    }

    @Test public void onlyFixedHubPagesAndTheConnectCallbackAreAccepted() {
        assertTrue(HubConnection.hubPage("https://quizforge.treenewbee.cloud/connect/authorize?v=1"));
        assertTrue(HubConnection.hubPage("https://quizforge.treenewbee.cloud/manage/"));
        for (String url : new String[]{"http://quizforge.treenewbee.cloud/manage/", "https://quizforge.treenewbee.cloud.evil.invalid/", "https://user@quizforge.treenewbee.cloud/", "https://quizforge.treenewbee.cloud:8443/", "javascript:alert(1)", ""})
            assertFalse(url, HubConnection.hubPage(url));
        assertTrue(HubConnection.callback(Uri.parse("quizforge://hub/connect?code=x&state=y")));
        assertFalse(HubConnection.callback(Uri.parse("quizforge://hub/import?url=x"))); assertFalse(HubConnection.callback(Uri.parse("https://hub/connect")));
    }
}
