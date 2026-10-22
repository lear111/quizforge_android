package cloud.treenewbee.quizforge.android;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.UUID;

/** Grants camera applications access to one random image, never a directory. */
public final class ImageFileProvider extends ContentProvider {
    static File directory(Context context) throws IOException {
        File root = new File(context.getCacheDir(), "camera-capture").getCanonicalFile();
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("无法创建拍照暂存目录");
        return root;
    }

    static Uri createCapture(Context context) throws IOException {
        File file = new File(directory(context), UUID.randomUUID() + ".jpg");
        if (!file.createNewFile()) throw new IOException("无法创建拍照暂存图片");
        return new Uri.Builder().scheme("content").authority(context.getPackageName() + ".images")
                .appendPath("capture").appendPath(file.getName()).build();
    }

    static File captureFile(Context context, Uri uri) throws IOException {
        if (uri == null || !"content".equals(uri.getScheme())
                || !(context.getPackageName() + ".images").equals(uri.getAuthority())
                || uri.getPathSegments().size() != 2 || !"capture".equals(uri.getPathSegments().get(0))
                || !uri.getPathSegments().get(1).matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.jpg")
                || uri.getQuery() != null || uri.getFragment() != null) throw new IOException("图片暂存地址无效");
        File root = directory(context), result = new File(root, uri.getLastPathSegment()).getCanonicalFile();
        if (!root.equals(result.getParentFile())) throw new IOException("图片暂存路径越界");
        return result;
    }

    @Override public boolean onCreate() { return true; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        try {
            File file = captureFile(getContext(), uri);
            if (!file.isFile()) throw new FileNotFoundException("图片暂存文件不存在");
            int flags;
            switch (mode) {
                case "r": flags = ParcelFileDescriptor.MODE_READ_ONLY; break;
                case "w": case "wt": flags = ParcelFileDescriptor.MODE_WRITE_ONLY | ParcelFileDescriptor.MODE_TRUNCATE; break;
                case "rw": flags = ParcelFileDescriptor.MODE_READ_WRITE; break;
                case "rwt": flags = ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_TRUNCATE; break;
                default: throw new FileNotFoundException("不支持此图片访问模式");
            }
            return ParcelFileDescriptor.open(file, flags);
        } catch (IOException exception) { throw new FileNotFoundException(exception.getMessage()); }
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        try {
            File file = captureFile(getContext(), uri);
            String[] names = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
            MatrixCursor result = new MatrixCursor(names, 1); Object[] values = new Object[names.length];
            for (int i = 0; i < names.length; i++) {
                if (OpenableColumns.DISPLAY_NAME.equals(names[i])) values[i] = "QuizForge拍照.jpg";
                else if (OpenableColumns.SIZE.equals(names[i])) values[i] = file.length();
            }
            result.addRow(values); return result;
        } catch (IOException exception) { throw new IllegalArgumentException("图片暂存地址无效"); }
    }

    @Override public String getType(Uri uri) {
        try { captureFile(getContext(), uri); return "image/jpeg"; }
        catch (IOException exception) { throw new IllegalArgumentException("图片暂存地址无效"); }
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { throw new UnsupportedOperationException(); }
}
