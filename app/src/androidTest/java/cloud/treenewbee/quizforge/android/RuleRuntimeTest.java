package cloud.treenewbee.quizforge.android;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.ContextWrapper;

import androidx.javascriptengine.JavaScriptSandbox;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.InputStream;
import java.util.UUID;

/** Native process/isolate verification; complements the Node differential suite. */
@RunWith(AndroidJUnit4.class)
public final class RuleRuntimeTest {
    private Context context;
    private RuleRuntime runtime;
    private File testRoot;

    @Before public void setup() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Assume.assumeTrue("System WebView has no JavaScriptSandbox service", JavaScriptSandbox.isSupported());
        runtime = new RuleRuntime(context);
        JSONObject info = runtime.information();
        assertTrue(info.optString("sandboxError", "Missing bounded sandbox features"), info.getBoolean("sandboxSupported"));
    }

    @After public void cleanup() throws Exception {
        if (runtime != null) runtime.close();
        if (testRoot != null) {
            assertEquals(context.getCacheDir().getCanonicalFile(), testRoot.getCanonicalFile().getParentFile());
            assertTrue(testRoot.getName().startsWith("rule-native-"));
            remove(testRoot, testRoot.getCanonicalFile());
        }
    }

    private static void remove(File file, File root) throws Exception {
        File canonical = file.getCanonicalFile();
        assertTrue(canonical.equals(root) || canonical.getPath().startsWith(root.getPath() + File.separator));
        File[] children = file.listFiles();
        if (children != null) for (File child : children) remove(child, root);
        assertTrue("Cannot clean isolated test file", file.delete());
    }

    private static JSONObject extension(String source) throws Exception {
        return new JSONObject().put("rules", source).put("questionSchema", true).put("answerSchema", true)
                .put("manifest", new JSONObject().put("requiresApi", new JSONObject().put("major", 1)
                        .put("minMinor", 4).put("capabilities", new JSONArray().put("practice").put("score"))));
    }

    private static JSONObject project(JSONObject data) throws Exception {
        return new JSONObject().put("op", "project").put("data", data)
                .put("state", new JSONObject().put("submitted", false).put("result", JSONObject.NULL));
    }

    @Test public void freshIsolatesDoNotRetainRuleGlobals() throws Exception {
        JSONObject type = extension("globalThis.counter=(globalThis.counter||0)+1;QF.defineType({project(){return {counter:globalThis.counter};},grade(){return {score:0,maxScore:1,correct:false,feedback:null};}});");
        for (int i = 0; i < 3; i++) assertEquals(1, runtime.run(type, project(new JSONObject())).getJSONObject("projected").getInt("counter"));
    }

    @Test public void api15AnswerAreaRuleRunsInsideTheBoundedNativeIsolate() throws Exception {
        JSONObject type=extension("QF.defineType({project(data){return {minor:QF.api.minor,answerAreas:QF.api.capabilities.includes('answer-areas'),stem:data.stem};},grade(){return {gradingStatus:'pending',score:null,maxScore:5,correct:null,feedback:null};},getScore(){return {score:null,maxScore:5};}});");
        type.getJSONObject("manifest").getJSONObject("requiresApi").put("minMinor",5).getJSONArray("capabilities").put("answer-areas");
        JSONObject value=runtime.run(type,project(new JSONObject().put("stem","synthetic answer area"))).getJSONObject("projected");
        assertEquals(5,value.getInt("minor"));assertTrue(value.getBoolean("answerAreas"));assertEquals("synthetic answer area",value.getString("stem"));
    }

    @Test public void largeJsonRequestsUseTransportBeyondBinderTransactionLimit() throws Exception {
        JSONObject type = extension("QF.defineType({project(data){return {length:data.text.length};},grade(){return {score:0,maxScore:1,correct:false,feedback:null};}});");
        String text = "测".repeat(600000);
        assertEquals(600000, runtime.run(type, project(new JSONObject().put("text", text))).getJSONObject("projected").getInt("length"));
    }

    @Test public void pendingAndManualReviewKeepWireValues() throws Exception {
        JSONObject type = extension("QF.defineType({project(data,state){return {stem:data.stem,...(state.submitted?{key:data.key}:{})};},grade(){return {gradingStatus:'pending',score:null,maxScore:2,correct:null,feedback:null};},review(data,answer,review){return {gradingStatus:'graded',score:review.score,maxScore:2,correct:review.score===2,feedback:'reviewed'};},getScore(data,state){return {score:state.submitted?state.result.score:0,maxScore:2};}});");
        JSONObject data = new JSONObject().put("stem", "Question").put("key", "secret");
        assertFalse(runtime.run(type, project(data)).getJSONObject("projected").has("key"));
        JSONObject submitted = runtime.run(type, new JSONObject().put("op", "submit").put("data", data).put("answer", new JSONObject()));
        JSONObject result = submitted.getJSONObject("result");
        assertEquals("pending", result.getString("gradingStatus")); assertTrue(result.isNull("score"));
        assertEquals("secret", submitted.getJSONObject("projected").getString("key"));
        JSONObject reviewed = runtime.run(type, new JSONObject().put("op", "review").put("data", data).put("answer", new JSONObject())
                .put("state", new JSONObject().put("submitted", true).put("result", result)).put("review", new JSONObject().put("score", 1)));
        assertEquals(1, reviewed.getJSONObject("result").getInt("score"));
    }

    @Test public void infiniteRuleTimesOutAndNextIsolateRecovers() throws Exception {
        JSONObject infinite = extension("QF.defineType({project(){while(true){}},grade(){return {score:0,maxScore:1,correct:false,feedback:null};}});");
        long began = System.nanoTime();
        try { runtime.run(infinite, project(new JSONObject())); fail("Infinite extension must time out"); }
        catch (StorageException exception) { assertEquals("RULE_TIMEOUT", exception.code); }
        assertTrue("Deadline did not bound execution", (System.nanoTime() - began) / 1000000 < 12000);
        JSONObject good = extension("QF.defineType({project(){return {recovered:true};},grade(){return {score:0,maxScore:1,correct:false,feedback:null};}});");
        assertTrue(runtime.run(good, project(new JSONObject())).getJSONObject("projected").getBoolean("recovered"));
    }

    @Test public void packagedDemoImportsThroughRealSchemaAndRulesValidation() throws Exception {
        testRoot = new File(context.getCacheDir(), "rule-native-" + UUID.randomUUID());
        assertTrue(testRoot.mkdirs());
        Context isolated = new ContextWrapper(context) { @Override public File getFilesDir() { return testRoot; } };
        BankRepository repository = new BankRepository(isolated);
        repository.setImportValidator((type, questions) -> runtime.run(type, new JSONObject().put("op", "validateBank").put("questions", questions)));
        try (InputStream input = context.getAssets().open("demo.qbank")) { repository.importPackage(input, "基础题型体验.qbank"); }
        JSONArray banks = repository.listBanks(); assertTrue(banks.length() > 0);
        int questions = 0;
        for (int i = 0; i < banks.length(); i++) {
            String id = banks.getJSONObject(i).getString("id");
            JSONObject bank = repository.readBank(id).getJSONObject("bank");
            JSONArray rows = bank.getJSONArray("questions"); questions += rows.length();
            for (int q = 0; q < rows.length(); q++) {
                JSONObject row = rows.getJSONObject(q);
                JSONObject binding = row.optJSONObject("extension"); if (binding == null) binding = bank.getJSONObject("extension");
                JSONObject type = repository.readExtension(id, binding.getString("path"));
                assertTrue(runtime.run(type, project(row.getJSONObject("data"))).has("projected"));
            }
        }
        assertTrue(questions >= 4);
    }
}
