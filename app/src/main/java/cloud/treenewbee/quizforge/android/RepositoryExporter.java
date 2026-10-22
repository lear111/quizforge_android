package cloud.treenewbee.quizforge.android;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Format-3 exchange contains authored banks and exact extension bytes only. */
final class RepositoryExporter {
    private final BankRepository repository;
    private final File content;
    private final String group;
    private long copiedBytes;

    private RepositoryExporter(BankRepository repository, File content, String group) {
        this.repository = repository; this.content = content; this.group = group;
    }

    static String name(BankRepository repository, String bankId, String group) throws Exception {
        List<JSONObject> records = selection(repository, bankId, group);
        return (bankId != null ? records.get(0).getString("title") : group) + ".qbank";
    }

    static JSONObject export(BankRepository repository, String bankId, String group, OutputStream output) throws Exception {
        if (output == null) throw failure("INVALID_REQUEST", "没有可写入的导出目标");
        List<JSONObject> records = selection(repository, bankId, group);
        String packageName = RepositoryManagement.folder(bankId != null ? records.get(0).getString("title") : group);
        File base = new File(repository.getDataRoot(), "export-staging"); mkdir(base);
        File work = new File(base, UUID.randomUUID().toString()); mkdir(work);
        try {
            File content = new File(work, "content"); mkdir(content);
            RepositoryExporter exporter = new RepositoryExporter(repository, content, packageName);
            int extensionCount = exporter.prepare(records);
            exporter.write(new File(content, "quizforge-package.json"), RepositoryManagement.json(new JSONObject()
                    .put("format", "quizforge-bank-group").put("formatVersion", 3).put("group", packageName)
                    .put("scope", bankId != null ? "bank" : "group")));
            File archive = new File(work, "package.qbank"); exporter.zip(archive);
            if (archive.length() > BankRepository.MAX_UPLOAD) throw failure("LIBRARY_ARCHIVE_LIMIT", "导出的题库包超过 64 MiB，请分别导出单个题库");
            // Validation and ZIP construction finish before touching the SAF stream.
            try (InputStream input = new FileInputStream(archive)) {
                byte[] buffer = new byte[32768]; int size;
                while ((size = input.read(buffer)) != -1) output.write(buffer, 0, size);
                output.flush();
            }
            return new JSONObject().put("name", packageName + ".qbank").put("scope", bankId != null ? "bank" : "group")
                    .put("exportedBanks", records.size()).put("exportedExtensions", extensionCount).put("size", archive.length());
        } finally {
            if (!work.getCanonicalFile().getParentFile().equals(base.getCanonicalFile()) || !work.getName().matches("[a-f0-9-]{36}")) throw new IOException("拒绝清理未知导出目录");
            remove(work);
        }
    }

    private int prepare(List<JSONObject> records) throws Exception {
        Map<String, String> paths = new LinkedHashMap<>();
        Map<String, JSONObject> owners = new LinkedHashMap<>();
        Map<String, JSONObject> documents = new LinkedHashMap<>();
        Set<String> extensionNames = new HashSet<>(), bankNames = new HashSet<>();
        for (JSONObject record : records) {
            JSONObject bank = BankRepository.readJson(BankRepository.safeFile(repository.importRoot(record), record.getString("bankPath")), BankRepository.MAX_FILE);
            documents.put(record.getString("id"), bank);
            JSONArray questions = bank.getJSONArray("questions");
            for (int i = 0; i < questions.length(); i++) {
                String path = BankRepository.extensionReference(questions.getJSONObject(i), bank), key = key(record, path);
                if (paths.containsKey(key)) continue;
                String leaf = unique(path.substring(path.lastIndexOf('/') + 1), extensionNames);
                paths.put(key, "extensions/" + group + "/" + leaf); owners.put(key, record);
            }
        }
        for (Map.Entry<String, String> entry : paths.entrySet()) {
            JSONObject record = owners.get(entry.getKey());
            String originalPath = entry.getKey().substring(entry.getKey().indexOf('|') + 1), destinationPath = entry.getValue();
            File source = BankRepository.safeFile(repository.importRoot(record), originalPath), destination = local(destinationPath); mkdir(destination);
            JSONObject extension = BankRepository.readExtensionFromRoot(repository.importRoot(record), originalPath), manifest = extension.getJSONObject("manifest");
            write(new File(destination, "manifest.json"), RepositoryManagement.json(manifest));
            for (String field : new String[]{"entry", "script", "style", "rules", "questionSchema", "answerSchema"})
                copyDeclaration(source, destination, manifest.getString(field));
            JSONArray assets = manifest.optJSONArray("assets");
            if (assets != null) for (int i = 0; i < assets.length(); i++) copyDeclaration(source, destination, assets.getString(i));
            File editor = new File(source, "editor.json");
            if (editor.isFile()) {
                JSONObject config = BankRepository.readJson(editor, 256 * 1024); write(new File(destination, "editor.json"), RepositoryManagement.json(config));
                for (String field : new String[]{"entry", "script", "style"}) copyDeclaration(source, destination, config.getString(field));
            }
            JSONObject examples = new JSONObject(extension.getJSONObject("examples").toString());
            examples.put("extension", new JSONObject().put("path", destinationPath));
            JSONArray questions = examples.getJSONArray("questions");
            for (int i = 0; i < questions.length(); i++) if (questions.getJSONObject(i).has("extension")) questions.getJSONObject(i).put("extension", new JSONObject().put("path", destinationPath));
            File exampleFile = localWithin(destination, manifest.getString("examples"));
            write(exampleFile, RepositoryManagement.json(examples));
            images(record.getString("id"), examples, new File(exampleFile.getParentFile(), "assets"), 0);
        }
        for (JSONObject record : records) {
            JSONObject bank = new JSONObject(documents.get(record.getString("id")).toString());
            String name = unique(record.getString("title"), bankNames);
            File destination = local("question-banks/" + group + "/" + name); mkdir(destination);
            bank.put("title", name); if (!bank.has("id")) bank.put("id", "bank");
            if (bank.has("extension")) bank.put("extension", rewritten(record, bank.getJSONObject("extension"), paths));
            JSONArray questions = bank.getJSONArray("questions");
            for (int i = 0; i < questions.length(); i++) {
                JSONObject question = questions.getJSONObject(i);
                if (question.has("extension")) question.put("extension", rewritten(record, question.getJSONObject("extension"), paths));
            }
            write(new File(destination, "bank.json"), RepositoryManagement.json(bank));
            images(record.getString("id"), bank, new File(destination, "assets"), 0);
        }
        return paths.size();
    }

    private JSONObject rewritten(JSONObject record, JSONObject reference, Map<String, String> paths) throws Exception {
        String path = paths.get(key(record, reference.getString("path")));
        if (path == null) throw failure("INVALID_LIBRARY_ARCHIVE", "题库包含未收集的拓展引用");
        return new JSONObject().put("path", path);
    }

    private void images(String bankId, Object value, File assets, int depth) throws Exception {
        if (depth > 128) throw failure("INVALID_LIBRARY_ARCHIVE", "题库内容嵌套过深");
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject)value;
            if (object.optString("type").equals("image") && object.optJSONObject("attrs") != null && object.getJSONObject("attrs").has("assetId")) {
                String id = object.getJSONObject("attrs").getString("assetId");
                JSONObject resource = repository.getResource(bankId, id);
                String suffix;
                switch (resource.getString("mime")) {
                    case "image/png": suffix = "png"; break;
                    case "image/jpeg": suffix = "jpg"; break;
                    case "image/webp": suffix = "webp"; break;
                    case "image/gif": suffix = "gif"; break;
                    default: throw failure("IMAGE_TYPE_UNSUPPORTED", "导出图片类型不受支持");
                }
                write(new File(assets, id + "." + suffix), Base64.decode(resource.getString("data"), Base64.NO_WRAP));
            }
            Iterator<String> keys = object.keys(); while (keys.hasNext()) images(bankId, object.get(keys.next()), assets, depth + 1);
        } else if (value instanceof JSONArray) { JSONArray array = (JSONArray)value; for (int i = 0; i < array.length(); i++) images(bankId, array.get(i), assets, depth + 1); }
    }

    private void copyDeclaration(File source, File destination, String relative) throws Exception {
        write(localWithin(destination, relative), BankRepository.readBytes(BankRepository.declaredFile(source, relative), BankRepository.MAX_FILE));
    }

    private void write(File file, byte[] bytes) throws Exception {
        if (bytes.length > BankRepository.MAX_FILE) throw failure("LIBRARY_ARCHIVE_LIMIT", "导出单个文件超过 8 MiB");
        if (file.exists()) {
            if (!Arrays.equals(BankRepository.readBytes(file, BankRepository.MAX_FILE), bytes)) throw failure("LIBRARY_EXPORT_CONFLICT", "拓展声明文件发生路径冲突，未导出不完整题库");
            return;
        }
        if ((copiedBytes += bytes.length) > BankRepository.MAX_EXPANDED) throw failure("LIBRARY_ARCHIVE_LIMIT", "导出内容超过 128 MiB");
        mkdir(file.getParentFile());
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes); output.getFD().sync(); }
    }

    private File local(String relative) throws Exception { return localWithin(content, relative); }
    private static File localWithin(File root, String relative) throws Exception {
        if (relative.startsWith("/") || relative.contains("\\") || relative.contains(":") || relative.contains("\0")) throw failure("INVALID_LIBRARY_ARCHIVE", "导出文件路径无效");
        File base = root.getCanonicalFile(), target = new File(base, relative).getCanonicalFile();
        if (!target.getPath().startsWith(base.getPath() + File.separator)) throw failure("INVALID_LIBRARY_ARCHIVE", "导出文件路径越界");
        return target;
    }

    private void zip(File archive) throws Exception {
        List<File> files = new ArrayList<>(); collect(content, files);
        if (files.size() > 10000) throw failure("LIBRARY_ARCHIVE_LIMIT", "导出文件数量超过 10000");
        try (FileOutputStream output = new FileOutputStream(archive); ZipOutputStream zip = new ZipOutputStream(output, StandardCharsets.UTF_8)) {
            for (File file : files) {
                String name = content.toPath().relativize(file.toPath()).toString().replace(File.separatorChar, '/') + (file.isDirectory() ? "/" : "");
                zip.putNextEntry(new ZipEntry(name));
                if (file.isFile()) try (InputStream input = new FileInputStream(file)) { byte[] buffer = new byte[32768]; int size; while ((size = input.read(buffer)) != -1) zip.write(buffer, 0, size); }
                zip.closeEntry();
            }
            zip.finish(); zip.flush(); output.getFD().sync();
        }
    }

    private static List<JSONObject> selection(BankRepository repository, String bankId, String group) throws Exception {
        if (bankId != null && group != null || bankId == null && group == null) throw failure("INVALID_REQUEST", "请选择一个题库或分组导出");
        List<JSONObject> selected = new ArrayList<>();
        if (bankId != null) selected.add(repository.record(bankId));
        else {
            RepositoryManagement.folder(group);
            JSONArray banks = repository.readCatalog().getJSONArray("banks");
            for (int i = 0; i < banks.length(); i++) if (banks.getJSONObject(i).optString("group").equals(group)) selected.add(banks.getJSONObject(i));
            if (selected.isEmpty()) throw failure("EMPTY_GROUP", "所选分组没有可导出的题库");
        }
        return selected;
    }
    private static String key(JSONObject record, String path) throws Exception { return record.getString("importId") + "|" + path; }
    private static String unique(String name, Set<String> used) throws Exception {
        RepositoryManagement.folder(name); String value = name; int suffix = 2;
        while (!used.add(value.toLowerCase(Locale.ROOT))) value = name.substring(0, Math.min(105, name.length())) + "（" + suffix++ + "）";
        return value;
    }
    private static void collect(File root, List<File> files) throws Exception {
        File[] children = root.listFiles(); if (children == null) throw new IOException("无法读取导出暂存目录"); Arrays.sort(children, (a,b)->a.getName().compareTo(b.getName()));
        for (File child : children) {
            if (Files.isSymbolicLink(child.toPath())) throw new IOException("导出目录含有链接");
            files.add(child); if (files.size() > 10000) throw failure("LIBRARY_ARCHIVE_LIMIT", "导出条目超过 10000");
            if (child.isDirectory()) collect(child, files);
        }
    }
    private static void mkdir(File file) throws IOException { if (!file.isDirectory() && !file.mkdirs()) throw new IOException("无法创建导出暂存目录"); }
    private static void remove(File file) throws IOException { if (!file.exists()) return; if (file.isDirectory() && !Files.isSymbolicLink(file.toPath())) { File[] children = file.listFiles(); if (children == null) throw new IOException("无法读取导出暂存目录"); for (File child : children) remove(child); } if (!file.delete()) throw new IOException("无法清理导出暂存文件"); }
    private static StorageException failure(String code, String message) { return new StorageException(code, message); }
}
