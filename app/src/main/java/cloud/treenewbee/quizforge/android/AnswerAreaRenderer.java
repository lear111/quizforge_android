package cloud.treenewbee.quizforge.android;

import android.content.Context;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.HashMap;
import java.util.Map;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Pure, memory-only renderer. This WebView never loads question HTML or exposes
 * the normal native bridge. Public methods are called on the host work thread. */
public final class AnswerAreaRenderer {
    private static final String ORIGIN="https://appassets.androidplatform.net";
    private static final String HOME=ORIGIN+"/assets/answer-area-renderer.html";
    private static final int MAX_IMAGE=4*1024*1024,MAX_BASE64=((MAX_IMAGE+2)/3)*4;
    private static final long JOB_TTL=60000,READY_TIMEOUT=20000,RENDER_TIMEOUT=30000;
    private static final Set<String> ASSETS=new HashSet<>(Arrays.asList(
            "/assets/answer-area-renderer.html","/assets/answer-area-renderer.js",
            "/assets/web/vendor/shared/answer-area/1.4.0/model.js",
            "/assets/web/vendor/shared/ink/1.0.0/renderer.js"));
    private final Context context;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final Object lock=new Object();
    private final CountDownLatch ready=new CountDownLatch(1);
    private volatile boolean destroyed,initializing;
    private volatile StorageException unavailable;
    private WebView view;
    private Job active;
    private static final class Pending {
        final String id=UUID.randomUUID().toString();final CountDownLatch done=new CountDownLatch(1);
        JSONObject result;StorageException failure;
    }
    private static final class Job {
        final String id=UUID.randomUUID().toString();final long deadline=SystemClock.elapsedRealtime()+JOB_TTL;
        final JSONObject document;final Set<String> expected=new LinkedHashSet<>();final Map<String,int[]> added=new HashMap<>();final int remainingWork;
        long decodedPixels;Pending pending;Runnable expiry;
        Job(JSONObject document,int remainingWork)throws JSONException{this.document=document;this.remainingWork=remainingWork;JSONArray images=document.optJSONArray("images");if(images!=null)for(int i=0;i<images.length();i++)expected.add(images.getJSONObject(i).getJSONObject("attrs").getString("assetId"));}
    }
    public AnswerAreaRenderer(Context context){this.context=context.getApplicationContext();}
    public JSONObject begin(JSONObject args)throws Exception{
        worker();JSONObject document=normalizeDocument(args.getJSONObject("document"));Object work=args.has("remainingWork")?args.opt("remainingWork"):8000000;
        if(!integral(work,0,8000000))throw fail("ANSWER_AREA_RENDER_LIMIT","答案绘制预算无效");ensureReady();Job job=new Job(document,((Number)work).intValue());
        synchronized(lock){expire();if(destroyed)throw unavailable();if(active!=null)throw fail("ANSWER_AREA_RENDER_BUSY","请等待当前答案图片完成");active=job;}
        job.expiry=()->expireJob(job);main.postDelayed(job.expiry,JOB_TTL);
        try{command(job,new JSONObject().put("action","begin").put("document",document).put("remainingWork",job.remainingWork));}
        catch(Exception exception){discardJob(job);throw exception;}
        return new JSONObject().put("jobId",job.id).put("imageIds",new JSONArray(job.expected));
    }
    public JSONObject addImage(JSONObject args)throws Exception{
        worker();Job job=job(args);String id=args.getString("assetId"),mime=args.getString("mime");
        if(!job.expected.contains(id))throw fail("ANSWER_IMAGE_UNAVAILABLE","图片不属于当前答题区");
        byte[] bytes=decode(args.getString("data"));if(!mime.equals(mime(bytes)))throw fail("IMAGE_TYPE_MISMATCH","图片内容与格式不一致");
        if(!id.equals(hash(bytes)))throw fail("ANSWER_IMAGE_HASH_MISMATCH","答案图片摘要不一致，原答案仍保留");
        synchronized(lock){int[] dimensions=job.added.get(id);if(dimensions!=null)return new JSONObject().put("confirmed",true).put("width",dimensions[0]).put("height",dimensions[1]).put("decodedPixels",job.decodedPixels);}
        BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(bytes,0,bytes.length,bounds);
        long pixels=(long)bounds.outWidth*bounds.outHeight;
        if(bounds.outWidth<=0||bounds.outHeight<=0||pixels>16000000||job.decodedPixels+pixels>16000000)throw fail("ANSWER_IMAGE_LIMIT","答案图片总分辨率过大或无法解码，原答案仍保留");
        JSONObject result=command(job,new JSONObject().put("action","image").put("assetId",id).put("mime",mime).put("data",args.getString("data")));
        long actual=(long)result.getInt("width")*result.getInt("height");
        if(result.getInt("width")<=0||result.getInt("height")<=0||actual>16000000||job.decodedPixels+actual>16000000){discardJob(job);throw fail("ANSWER_IMAGE_LIMIT","答案图片解码尺寸超过限制");}
        synchronized(lock){job.added.put(id,new int[]{result.getInt("width"),result.getInt("height")});job.decodedPixels+=actual;}
        return new JSONObject().put("confirmed",true).put("width",result.getInt("width")).put("height",result.getInt("height")).put("decodedPixels",job.decodedPixels);
    }
    public JSONObject render(JSONObject args)throws Exception{
        worker();Job job=job(args);if(!job.added.keySet().containsAll(job.expected))throw fail("ANSWER_IMAGE_UNAVAILABLE","答案图片尚未完成解码，原答案仍保留");
        try{
            JSONObject result=command(job,new JSONObject().put("action","render"));byte[] bytes=decode(result.getString("data"));
            int scale=!job.document.optString("text").trim().isEmpty()||job.document.optString("inkSource").equals("draft")||job.document.optJSONArray("images")!=null&&job.document.getJSONArray("images").length()>0?2:1;
            int width=job.document.getInt("width")*scale,height=job.document.getInt("height")*scale;
            if(!mime(bytes).equals("image/png")||result.getInt("width")!=width||result.getInt("height")!=height)throw fail("ANSWER_AREA_RENDER_FAILED","答案图片尺寸或格式异常，原答案仍保留");
            BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(bytes,0,bytes.length,bounds);
            if(bounds.outWidth!=width||bounds.outHeight!=height)throw fail("ANSWER_AREA_RENDER_FAILED","答案图片编码尺寸异常");
            if(!integral(result.opt("usedWork"),0,job.remainingWork))throw fail("ANSWER_AREA_RENDER_FAILED","答案绘制预算回复异常");
            return result.put("id",hash(bytes)).put("size",bytes.length).put("mime","image/png");
        }finally{discardJob(job);}
    }
    public JSONObject discard(JSONObject args)throws Exception{
        worker();String id=args.getString("jobId");Job job;synchronized(lock){job=active;}
        if(job==null||!job.id.equals(id))return new JSONObject().put("discarded",false);discardJob(job);return new JSONObject().put("discarded",true);
    }
    public void destroy(){destroyed=true;Job job;synchronized(lock){job=active;}if(job!=null)discardJob(job);ready.countDown();main.post(()->{if(view!=null){view.stopLoading();view.destroy();view=null;}});}
    private void worker()throws StorageException{if(Looper.myLooper()==Looper.getMainLooper())throw fail("ANSWER_AREA_RENDER_THREAD","答案图片必须在后台任务生成");if(destroyed)throw unavailable();}
    private Job job(JSONObject args)throws Exception{synchronized(lock){expire();if(active==null||!active.id.equals(args.getString("jobId")))throw fail("ANSWER_AREA_JOB_EXPIRED","答案图片任务已过期，请重试");return active;}}
    private void expire(){if(active!=null&&SystemClock.elapsedRealtime()>=active.deadline)discardJob(active);}
    private void expireJob(Job job){synchronized(lock){if(active==job&&SystemClock.elapsedRealtime()>=job.deadline)discardJob(job);}}
    private void discardJob(Job job){if(job.expiry!=null)main.removeCallbacks(job.expiry);synchronized(lock){if(active==job)active=null;if(job.pending!=null){job.pending.failure=fail("ANSWER_AREA_JOB_EXPIRED","答案图片任务已取消或过期，原答案仍保留");job.pending.done.countDown();job.pending=null;}}
        main.post(()->{if(view!=null)view.evaluateJavascript("window.__qfDiscardAnswerRender&&window.__qfDiscardAnswerRender("+JSONObject.quote(job.id)+")",null);});}
    private JSONObject command(Job job,JSONObject payload)throws Exception{
        Pending pending=new Pending();synchronized(lock){if(active!=job||destroyed)throw fail("ANSWER_AREA_JOB_EXPIRED","答案图片任务已过期，请重试");if(job.pending!=null)throw fail("ANSWER_AREA_RENDER_BUSY","答案图片正在处理");job.pending=pending;}
        payload.put("requestId",pending.id).put("jobId",job.id);String wire=payload.toString();
        main.post(()->{try{if(view==null||destroyed)throw unavailable();view.evaluateJavascript("window.__qfAnswerRenderCommand(JSON.parse("+JSONObject.quote(wire)+"))",null);}catch(Exception exception){pending.failure=exception instanceof StorageException?(StorageException)exception:fail("ANSWER_AREA_RENDER_UNAVAILABLE","答案图片组件不可用");pending.done.countDown();}});
        try{if(!pending.done.await(RENDER_TIMEOUT,TimeUnit.MILLISECONDS)){discardJob(job);throw fail("ANSWER_AREA_RENDER_TIMEOUT","答案图片生成超时，原答案仍保留，请重试");}}
        catch(InterruptedException exception){Thread.currentThread().interrupt();discardJob(job);throw fail("ANSWER_AREA_RENDER_INTERRUPTED","答案图片生成已中断，原答案仍保留");}
        finally{synchronized(lock){if(job.pending==pending)job.pending=null;}}
        if(pending.failure!=null)throw pending.failure;if(pending.result==null)throw fail("ANSWER_AREA_RENDER_FAILED","答案图片没有确认结果");return pending.result;
    }
    private void ensureReady()throws Exception{
        synchronized(lock){if(!initializing){initializing=true;main.post(this::initialize);}}
        try{if(!ready.await(READY_TIMEOUT,TimeUnit.MILLISECONDS))throw fail("ANSWER_AREA_RENDER_TIMEOUT","答案图片组件加载超时，请重试");}
        catch(InterruptedException exception){Thread.currentThread().interrupt();throw fail("ANSWER_AREA_RENDER_INTERRUPTED","答案图片组件加载已中断");}
        if(unavailable!=null)throw unavailable;if(destroyed)throw unavailable();
    }
    private void initialize(){
        if(destroyed){ready.countDown();return;}
        try{
            if(!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))throw unavailable();
            view=new WebView(context);WebSettings settings=view.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(false);settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setBlockNetworkLoads(true);settings.setCacheMode(WebSettings.LOAD_NO_CACHE);settings.setJavaScriptCanOpenWindowsAutomatically(false);settings.setSupportMultipleWindows(false);
            WebViewAssetLoader loader=new WebViewAssetLoader.Builder().addPathHandler("/assets/",new WebViewAssetLoader.AssetsPathHandler(context)).build();
            view.setWebViewClient(new WebViewClient(){
                @Override public WebResourceResponse shouldInterceptRequest(WebView web,WebResourceRequest request){Uri uri=request.getUrl();if(trusted(uri))return loader.shouldInterceptRequest(uri);return new WebResourceResponse("text/plain","UTF-8",403,"Forbidden",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
                @Override public boolean shouldOverrideUrlLoading(WebView web,WebResourceRequest request){return !HOME.equals(request.getUrl().toString());}
                @Override public void onReceivedError(WebView web,WebResourceRequest request,WebResourceError error){unavailable=fail("ANSWER_AREA_RENDER_UNAVAILABLE","答案图片组件不完整，请更新应用");ready.countDown();}
                @Override public boolean onRenderProcessGone(WebView web,RenderProcessGoneDetail detail){unavailable=fail("ANSWER_AREA_RENDER_UNAVAILABLE","答案图片进程已停止，原答案仍保留");ready.countDown();Job job;synchronized(lock){job=active;}if(job!=null)discardJob(job);web.destroy();if(view==web)view=null;return true;}
            });
            WebViewCompat.addWebMessageListener(view,"qfAnswerRenderer",Collections.singleton(ORIGIN),(web,message,origin,isMainFrame,proxy)->{
                if(!isMainFrame||!ORIGIN.equals(origin.toString())||!HOME.equals(web.getUrl()))return;
                try{String data=message.getData();if(data==null||data.length()>MAX_BASE64+8192)throw fail("ANSWER_AREA_RENDER_FAILED","答案图片回复超过限制");JSONObject value=new JSONObject(data);
                    if(value.optString("type").equals("ready")){ready.countDown();return;}
                    synchronized(lock){Job job=active;if(job==null||job.pending==null||!job.id.equals(value.optString("jobId"))||!job.pending.id.equals(value.optString("requestId")))return;
                        if(value.optBoolean("ok"))job.pending.result=value.getJSONObject("result");else{JSONObject error=value.optJSONObject("error");job.pending.failure=fail(error==null?"ANSWER_AREA_RENDER_FAILED":error.optString("code","ANSWER_AREA_RENDER_FAILED"),error==null?"答案图片生成失败，原答案仍保留":error.optString("message","答案图片生成失败，原答案仍保留"));}job.pending.done.countDown();}
                }catch(Exception exception){synchronized(lock){if(active!=null&&active.pending!=null){active.pending.failure=fail("ANSWER_AREA_RENDER_FAILED","答案图片回复无效，原答案仍保留");active.pending.done.countDown();}}}
            });view.loadUrl(HOME);
        }catch(Exception exception){unavailable=exception instanceof StorageException?(StorageException)exception:fail("ANSWER_AREA_RENDER_UNAVAILABLE","答案图片组件不可用，请更新系统 WebView");ready.countDown();}
    }
    private static boolean trusted(Uri uri){return "https".equals(uri.getScheme())&&"appassets.androidplatform.net".equals(uri.getHost())&&uri.getPort()==-1&&uri.getUserInfo()==null&&uri.getQuery()==null&&uri.getFragment()==null&&ASSETS.contains(uri.getPath());}
    private static StorageException unavailable(){return fail("ANSWER_AREA_RENDER_UNAVAILABLE","答案图片组件不可用，原答案仍保留");}
    private static StorageException fail(String code,String message){return new StorageException(code,message);}
    private static boolean object(Object value){return value instanceof JSONObject;}
    private static boolean finite(Object value,double min,double max){return value instanceof Number&&Double.isFinite(((Number)value).doubleValue())&&((Number)value).doubleValue()>=min&&((Number)value).doubleValue()<=max;}
    private static boolean integral(Object value,int min,int max){return finite(value,min,max)&&((Number)value).doubleValue()==Math.rint(((Number)value).doubleValue());}
    private static boolean id(Object value){return value instanceof String&&((String)value).matches("[A-Za-z0-9][A-Za-z0-9._-]{0,119}");}
    private static boolean keys(JSONObject value,String...allowed){Set<String> names=new HashSet<>(Arrays.asList(allowed));Iterator<String> fields=value.keys();while(fields.hasNext())if(!names.contains(fields.next()))return false;return true;}
    private static void valid(boolean condition)throws StorageException{if(!condition)throw fail("INVALID_ANSWER_AREA","手写答题区数据无效或超出限制，原答案仍保留");}
    static JSONObject normalizeDocument(JSONObject value)throws Exception{
        valid(value!=null&&keys(value,"type","formatVersion","id","targetId","width","height","strokes","snapshot","text","inkSource","anchor","images")&&"qf-answer-area".equals(value.opt("type"))&&integral(value.opt("formatVersion"),1,1)&&id(value.opt("id"))&&integral(value.opt("width"),160,1600)&&integral(value.opt("height"),120,3200));
        int width=value.getInt("width"),height=value.getInt("height");valid((long)width*height<=4000000&&(!value.has("targetId")||id(value.opt("targetId")))&&(!value.has("text")||value.opt("text") instanceof String&&value.getString("text").length()<=20000)&&(!value.has("inkSource")||"draft".equals(value.opt("inkSource"))));boolean shared=value.optString("inkSource").equals("draft");
        JSONObject result=new JSONObject().put("type","qf-answer-area").put("formatVersion",1).put("id",value.getString("id")).put("width",width).put("height",height);for(String name:new String[]{"targetId","text","inkSource"})if(value.has(name))result.put(name,value.get(name));
        JSONArray source=value.optJSONArray("strokes"),strokes=new JSONArray();valid(source!=null&&source.length()<=1000);Set<String> seen=new HashSet<>();int count=0;
        for(int i=0;i<source.length();i++){JSONObject stroke=source.optJSONObject(i);valid(stroke!=null&&keys(stroke,"id","color","width","points")&&id(stroke.opt("id"))&&seen.add(stroke.getString("id"))&&stroke.opt("color") instanceof String&&stroke.getString("color").matches("#[0-9a-fA-F]{6}")&&finite(stroke.opt("width"),shared?.05:.5,shared?64:16));JSONArray points=stroke.optJSONArray("points"),normalized=new JSONArray();valid(points!=null&&points.length()>0&&points.length()<=10000&&(count+=points.length())<=20000);
            for(int j=0;j<points.length();j++){JSONObject point=points.optJSONObject(j);valid(point!=null&&keys(point,"x","y","pressure")&&finite(point.opt("x"),shared?-2000000:0,shared?2000000:width)&&finite(point.opt("y"),shared?-2000000:0,shared?2000000:height)&&finite(point.opt("pressure"),0,1));normalized.put(new JSONObject().put("x",point.get("x")).put("y",point.get("y")).put("pressure",point.get("pressure")));}
            strokes.put(new JSONObject().put("id",stroke.getString("id")).put("color",stroke.getString("color").toLowerCase(Locale.ROOT)).put("width",stroke.get("width")).put("points",normalized));}
        result.put("strokes",strokes);
        if(value.has("anchor")){JSONObject anchor=value.optJSONObject("anchor");valid(anchor!=null&&keys(anchor,"x","y","width","height")&&finite(anchor.opt("x"),-1000000,1000000)&&finite(anchor.opt("y"),-1000000,1000000)&&finite(anchor.opt("width"),1,10000)&&finite(anchor.opt("height"),1,20000));result.put("anchor",new JSONObject(anchor.toString()));}
        if(value.has("images")){JSONArray images=value.optJSONArray("images"),normalized=new JSONArray();valid(images!=null&&images.length()<=8);seen.clear();for(int i=0;i<images.length();i++){JSONObject image=images.optJSONObject(i),attrs=image==null?null:image.optJSONObject("attrs");valid(image!=null&&keys(image,"type","id","attrs","x","y","width","height")&&"image".equals(image.opt("type"))&&id(image.opt("id"))&&seen.add(image.getString("id"))&&asset(attrs)&&finite(image.opt("x"),0,width)&&finite(image.opt("y"),0,height)&&finite(image.opt("width"),1,width)&&finite(image.opt("height"),1,height));valid(image.getDouble("x")+image.getDouble("width")<=width+.01&&image.getDouble("y")+image.getDouble("height")<=height+.01);normalized.put(new JSONObject(image.toString()));}result.put("images",normalized);}
        if(value.has("snapshot")){JSONObject snapshot=value.optJSONObject("snapshot");valid(snapshot!=null&&keys(snapshot,"type","attrs")&&"image".equals(snapshot.opt("type"))&&asset(snapshot.optJSONObject("attrs")));}
        valid(result.toString().length()<=2000000);return result;
    }
    private static boolean asset(JSONObject attrs){return attrs!=null&&keys(attrs,"assetId")&&attrs.opt("assetId") instanceof String&&attrs.optString("assetId").matches("[a-f0-9]{64}");}
    private static byte[] decode(String data)throws StorageException{if(data==null||data.isEmpty()||data.length()>MAX_BASE64||data.length()%4!=0||!data.matches("[A-Za-z0-9+/]*={0,2}"))throw fail("IMAGE_SIZE_LIMIT","图片编码无效或超过 4 MiB");try{byte[] bytes=Base64.decode(data,Base64.NO_WRAP);if(bytes.length==0||bytes.length>MAX_IMAGE||!Base64.encodeToString(bytes,Base64.NO_WRAP).equals(data))throw fail("IMAGE_SIZE_LIMIT","图片编码无效或超过 4 MiB");return bytes;}catch(IllegalArgumentException exception){throw fail("IMAGE_SIZE_LIMIT","图片编码无效");}}
    private static String hash(byte[] bytes)throws Exception{byte[] digest=MessageDigest.getInstance("SHA-256").digest(bytes);StringBuilder value=new StringBuilder(64);for(byte item:digest)value.append(String.format(Locale.ROOT,"%02x",item&255));return value.toString();}
    private static String ascii(byte[] bytes,int offset,int length){return new String(bytes,offset,length,StandardCharsets.US_ASCII);}
    private static String mime(byte[] bytes){if(bytes.length>=24&&Arrays.equals(Arrays.copyOfRange(bytes,0,8),new byte[]{(byte)137,80,78,71,13,10,26,10})&&ascii(bytes,12,4).equals("IHDR"))return "image/png";if(bytes.length>=4&&(bytes[0]&255)==255&&(bytes[1]&255)==216&&(bytes[bytes.length-2]&255)==255&&(bytes[bytes.length-1]&255)==217)return "image/jpeg";if(bytes.length>=12&&ascii(bytes,0,4).equals("RIFF")&&ascii(bytes,8,4).equals("WEBP"))return "image/webp";if(bytes.length>=10&&(ascii(bytes,0,6).equals("GIF87a")||ascii(bytes,0,6).equals("GIF89a")))return "image/gif";return "";}
}
