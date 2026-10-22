package cloud.treenewbee.quizforge.android;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.ContextWrapper;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.nio.file.Files;
import java.util.UUID;

@RunWith(AndroidJUnit4.class)
public final class AppDocumentStoreTest {
    private File work; private Context context; private AppDocumentStore store;
    @Before public void setup() throws Exception {
        Context app=ApplicationProvider.getApplicationContext();
        work=new File(app.getCacheDir(),"service-document-test-"+UUID.randomUUID());assertTrue(work.mkdir());
        context=new ContextWrapper(app){@Override public File getFilesDir(){return work;}};
        store=new AppDocumentStore(context);
    }
    @After public void cleanup() throws Exception { assertTrue(work.getName().startsWith("service-document-test-"));remove(work); }
    @Test public void confirmedRecordSurvivesRecreationAndStaleWriteCannotReplaceIt() throws Exception {
        JSONObject first=store.write("exam","fixture",new JSONObject().put("answer",4),0);assertEquals(1,first.getInt("revision"));
        AppDocumentStore reloaded=new AppDocumentStore(context);assertEquals(4,reloaded.read("exam","fixture").getInt("answer"));
        try{reloaded.write("exam","fixture",new JSONObject().put("answer",9),0);fail();}catch(StorageException exception){assertEquals("REVISION_CONFLICT",exception.code);}
        assertEquals(4,store.read("exam","fixture").getInt("answer"));
        assertEquals("fixture",store.list("exam").getString(0));
    }
    @Test public void unknownNamespacesAndTraversalNeverEscapeOwnedDirectory() throws Exception {
        for(String namespace:new String[]{"../exam","credentials","ai-profile"})try{store.read(namespace,"fixture");fail();}catch(StorageException exception){assertEquals("INVALID_DOCUMENT",exception.code);}
        for(String key:new String[]{"../fixture","a/b",".","a.b"})try{store.write("exam",key,new JSONObject(),0);fail();}catch(StorageException exception){assertEquals("INVALID_DOCUMENT",exception.code);}
        assertEquals(0,store.list("exam").length());
    }
    @Test public void corruptSavedRecordIsReportedWithoutReplacingIt() throws Exception {
        File source=new File(work,"local-services/exam/fixture.json");assertTrue(source.getParentFile().mkdirs());
        Files.write(source.toPath(),"{\"schemaVersion\":99,\"revision\":1}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        try{store.read("exam","fixture");fail();}catch(StorageException exception){assertEquals("DOCUMENT_UNAVAILABLE",exception.code);}
        assertTrue(new String(Files.readAllBytes(source.toPath()),java.nio.charset.StandardCharsets.UTF_8).contains("99"));
    }
    private void remove(File file) throws Exception {
        assertTrue(file.getCanonicalPath().startsWith(work.getCanonicalPath()));
        File[] children=file.listFiles();if(children!=null)for(File child:children)remove(child);assertTrue(file.delete());
    }
}
