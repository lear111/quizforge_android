package cloud.treenewbee.quizforge.android;

import static org.junit.Assert.*;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayOutputStream;

/** Actual isolated WebView canvas; synthetic images only, no app data or model. */
@RunWith(AndroidJUnit4.class)
public final class AnswerAreaRendererTest {
    private AnswerAreaRenderer renderer;
    @Before public void setup(){renderer=new AnswerAreaRenderer(InstrumentationRegistry.getInstrumentation().getTargetContext());}
    @After public void cleanup(){renderer.destroy();}
    private interface Attempt {void run() throws Exception;}
    private static void rejects(String code,Attempt attempt)throws Exception{try{attempt.run();fail("Expected "+code);}catch(StorageException error){assertEquals(code,error.code);}}
    private static JSONObject doc(boolean shared)throws Exception{
        JSONObject value=new JSONObject().put("type","qf-answer-area").put("formatVersion",1).put("id","response").put("width",160).put("height",1800).put("strokes",new JSONArray());
        if(shared)value.put("inkSource","draft");return value;
    }
    private static JSONObject stroke(double x,double y)throws Exception{return new JSONObject().put("id","stroke-1").put("color","#123456").put("width",8)
        .put("points",new JSONArray().put(new JSONObject().put("x",x).put("y",y).put("pressure",1)));}
    private JSONObject begin(JSONObject document)throws Exception{return renderer.begin(new JSONObject().put("document",document));}
    private JSONObject render(JSONObject job)throws Exception{return renderer.render(new JSONObject().put("jobId",job.getString("jobId")));}
    private static Bitmap bitmap(JSONObject result)throws Exception{byte[] bytes=Base64.decode(result.getString("data"),Base64.NO_WRAP);assertEquals(bytes.length,result.getInt("size"));assertEquals(BankRepository.sha256(bytes),result.getString("id"));Bitmap bitmap=BitmapFactory.decodeByteArray(bytes,0,bytes.length);assertNotNull(bitmap);assertEquals(result.getInt("width"),bitmap.getWidth());assertEquals(result.getInt("height"),bitmap.getHeight());return bitmap;}

    @Test public void sharedInkRendersEntireLogicalRangeIncludingOffscreenBottom()throws Exception{
        JSONObject document=doc(true);document.getJSONArray("strokes").put(stroke(80,1600));
        JSONObject result=render(begin(document));assertEquals(320,result.getInt("width"));assertEquals(3600,result.getInt("height"));assertEquals(16,result.getInt("usedWork"));
        Bitmap image=bitmap(result);try{assertEquals(Color.WHITE,image.getPixel(5,5));assertEquals(Color.rgb(18,52,86),image.getPixel(160,3200));}finally{image.recycle();}
    }
    @Test public void legacyInkKeepsOneTimesRasterAndMixedTextUsesTwoTimes()throws Exception{
        JSONObject legacy=doc(false);legacy.getJSONArray("strokes").put(stroke(80,1600));JSONObject result=render(begin(legacy));assertEquals(160,result.getInt("width"));assertEquals(1800,result.getInt("height"));assertTrue(result.getInt("usedWork")>0);
        Bitmap image=bitmap(result);try{assertEquals(Color.rgb(18,52,86),image.getPixel(80,1600));}finally{image.recycle();}
        legacy.put("text","中文 typed answer");JSONObject mixed=render(begin(legacy));assertEquals(320,mixed.getInt("width"));assertEquals(3600,mixed.getInt("height"));
        image=bitmap(mixed);try{int dark=0;for(int y=20;y<85;y++)for(int x=30;x<300;x++)if(image.getPixel(x,y)!=Color.WHITE)dark++;assertTrue("Text must be in the full answer image",dark>10);}finally{image.recycle();}
    }
    @Test public void imagesAreDecodedVerifiedAndPaintedBelowTheViewport()throws Exception{
        Bitmap source=Bitmap.createBitmap(20,10,Bitmap.Config.ARGB_8888);source.eraseColor(Color.RED);ByteArrayOutputStream output=new ByteArrayOutputStream();assertTrue(source.compress(Bitmap.CompressFormat.PNG,100,output));source.recycle();byte[] bytes=output.toByteArray();String id=BankRepository.sha256(bytes);
        JSONObject document=doc(true).put("images",new JSONArray().put(new JSONObject().put("type","image").put("id","photo-1").put("attrs",new JSONObject().put("assetId",id)).put("x",20).put("y",1400).put("width",100).put("height",50)));
        JSONObject job=begin(document),args=new JSONObject().put("jobId",job.getString("jobId")).put("assetId",id).put("mime","image/png").put("data",Base64.encodeToString(bytes,Base64.NO_WRAP));
        rejects("ANSWER_IMAGE_UNAVAILABLE",()->render(job));JSONObject decoded=renderer.addImage(args);assertEquals(20,decoded.getInt("width"));assertEquals(10,decoded.getInt("height"));Bitmap image=bitmap(render(job));try{assertEquals(Color.RED,image.getPixel(100,2850));assertEquals(Color.WHITE,image.getPixel(5,5));}finally{image.recycle();}
    }
    @Test public void callerSnapshotsAreRemovedAndInvalidDocumentsRejectedBeforeRendering()throws Exception{
        JSONObject document=doc(true).put("snapshot",new JSONObject().put("type","image").put("attrs",new JSONObject().put("assetId",new String(new char[64]).replace('\0','a'))));
        assertFalse(AnswerAreaRenderer.normalizeDocument(document).has("snapshot"));
        document.put("unknown",true);rejects("INVALID_ANSWER_AREA",()->begin(document));
        rejects("INVALID_ANSWER_AREA",()->begin(doc(true).put("width",1601)));
    }
    @Test public void workLimitAndDiscardNeverYieldPartialImagesAndAllowRetry()throws Exception{
        JSONObject document=doc(true);document.getJSONArray("strokes").put(stroke(80,1600));
        JSONObject job=renderer.begin(new JSONObject().put("document",document).put("remainingWork",0));rejects("ANSWER_AREA_RENDER_LIMIT",()->render(job));
        JSONObject retry=begin(document);assertTrue(renderer.discard(new JSONObject().put("jobId",retry.getString("jobId"))).getBoolean("discarded"));rejects("ANSWER_AREA_JOB_EXPIRED",()->render(retry));
        assertEquals("image/png",render(begin(document)).getString("mime"));
    }
}
