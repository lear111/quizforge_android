package cloud.treenewbee.quizforge.android;

import android.content.Context;
import android.util.AtomicFile;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * App-private banks, imported extension sources, practice state, and image bytes.
 * Each import has an independent root. Imports never replace or deduplicate an
 * existing library item, and executable files are validated before publication.
 */
public final class BankRepository {
    public static final long MAX_UPLOAD = 64L * 1024 * 1024;
    public static final long MAX_EXPANDED = 128L * 1024 * 1024;
    public static final int MAX_FILE = 8 * 1024 * 1024;
    public static final int MAX_IMAGE = 4 * 1024 * 1024;
    public static final int MAX_STATE = 32 * 1024 * 1024;
    private static final int MAX_ENTRIES = 10000;
    private static final int MAX_SOURCE = 1024 * 1024;
    private static final String[] REQUIRED = {"entry", "script", "style", "rules", "questionSchema", "answerSchema", "examples"};
    private static final Set<String> API_CAPABILITIES = new HashSet<>(Arrays.asList(
            "practice", "editor", "editor-drafts", "score", "manual-review", "ai-grading",
            "resources", "richtext", "navigation", "lifecycle", "outline-items", "answer-state",
            "appearance", "answer-areas"));
    private static final Map<String, String> IMAGE_EXTENSIONS = new LinkedHashMap<>();
    static {
        IMAGE_EXTENSIONS.put("image/png", "png");
        IMAGE_EXTENSIONS.put("image/jpeg", "jpg");
        IMAGE_EXTENSIONS.put("image/webp", "webp");
        IMAGE_EXTENSIONS.put("image/gif", "gif");
    }

    public interface ImportValidator {
        /** Runs schema and synchronous rules against the supplied private questions. */
        void validate(JSONObject extension, JSONArray questions) throws Exception;
    }

    private final File dataRoot;
    final File libraryRoot;
    private final File stagingRoot;
    final File stateRoot;
    final File catalogFile;
    final RepositoryTransaction transactions;
    private final RepositoryManagement management;
    private final RepositoryEditor editor;
    private final Map<String, Map<String, File>> resourceIndexes = new HashMap<>();
    private ImportValidator validator;

    public BankRepository(Context context) throws Exception {
        RepositoryBackup.recoverPending(context);
        dataRoot = context.getFilesDir().getCanonicalFile();
        libraryRoot = directory(new File(dataRoot, "library"));
        stagingRoot = directory(new File(dataRoot, "import-staging"));
        stateRoot = directory(new File(dataRoot, "practice"));
        catalogFile = new File(dataRoot, "library-catalog.json");
        transactions = new RepositoryTransaction(dataRoot);
        transactions.recover();
        management = new RepositoryManagement(this);
        editor = new RepositoryEditor(this);
        readCatalog(); // Corrupt existing data is never silently replaced by an empty library.
    }

    public synchronized void setImportValidator(ImportValidator validator) {
        this.validator = validator;
    }

    ImportValidator importValidator() { return validator; }

    /** Complete restore validation, including archived banks and authored resources. */
    synchronized JSONObject validateBackupRoot() throws Exception {
        if (validator == null) throw new StorageException("ENGINE_UNAVAILABLE", "恢复验证需要本地题型执行器");
        JSONObject catalog = readCatalog();
        Map<String, JSONObject> rows = new LinkedHashMap<>();
        JSONArray active = catalog.getJSONArray("banks");
        for (int i = 0; i < active.length(); i++) rows.put(active.getJSONObject(i).getString("id"), active.getJSONObject(i));
        JSONArray trash = catalog.getJSONArray("trash");
        for (int i = 0; i < trash.length(); i++) {
            JSONArray archived = trash.getJSONObject(i).getJSONArray("records");
            for (int j = 0; j < archived.length(); j++) {
                JSONObject record = archived.getJSONObject(j); String id = record.getString("id");
                if (!uuid(id) || rows.containsKey(id)) throw new StorageException("INVALID_BACKUP", "备份中的回收题库身份重复或无效");
                rows.put(id, record);
            }
        }
        Map<String, File> resources = resourceIndex(dataRoot);
        Map<String, Map<String, JSONObject>> importExtensions = new HashMap<>();
        for (JSONObject record : rows.values()) {
            File root = importRoot(record); String importId = record.getString("importId");
            Map<String, JSONObject> extensions = importExtensions.get(importId);
            if (extensions == null) {
                JSONObject marker = readJson(safeFile(root, "quizforge-package.json"), 256 * 1024);
                if (!marker.optString("format").equals("quizforge-bank-group") || integer(marker, "formatVersion") != 3)
                    throw new StorageException("INVALID_BACKUP", "备份包含无效的已安装题库包");
                extensions = extensionPackages(root, marker.getString("group"));
                for (Map.Entry<String, JSONObject> extension : extensions.entrySet()) {
                    validator.validate(extension.getValue(), new JSONArray());
                    validateBank(extension.getValue().getJSONObject("examples"), extensions, resources, extension.getKey());
                }
                importExtensions.put(importId, extensions);
            }
            JSONObject bank = readJson(safeFile(root, record.getString("bankPath")), MAX_FILE);
            validateBank(bank, extensions, resources, null);
            if (!RepositoryEditor.canonical(normalizedFeatures(bank.optJSONObject("features"))).equals(RepositoryEditor.canonical(record.getJSONObject("features"))))
                throw new StorageException("INVALID_BACKUP", "备份题库功能开关与目录记录不一致");
            File stateFile = new File(stateRoot, record.getString("id") + ".json");
            if (stateFile.exists()) {
                JSONObject state = readAtomicJson(stateFile, MAX_STATE);
                if (state.optInt("schemaVersion") != 1 || state.optLong("revision", -1) < 0 || state.optJSONObject("questions") == null
                        || state.optJSONObject("ink") == null || state.optJSONArray("history") == null)
                    throw new StorageException("INVALID_BACKUP", "备份的练习或历史记录格式无效");
                if (!record.getJSONObject("features").optBoolean("history", true))
                    throw new StorageException("INVALID_BACKUP", "关闭练习保存的题库不能携带持久练习状态");
                validateImageReferences(state, resources, 0);
            }
        }
        File exams = new File(dataRoot, "local-services/exam");
        if (exams.isDirectory()) for (File file : sortedFiles(exams)) {
            if (!file.getName().matches("[A-Za-z0-9_-]{1,96}\\.json")) throw new StorageException("INVALID_BACKUP", "考试记录名称无效");
            JSONObject document = readJson(file, 128 * 1024 * 1024);
            if (document.optInt("schemaVersion") != 1 || document.optLong("revision", -1) < 1)
                throw new StorageException("INVALID_BACKUP", "考试记录格式无效");
        }
        return new JSONObject().put("banks", active.length()).put("groups", catalog.getJSONArray("groups"))
                .put("trashCount", trash.length()).put("archivedBanks", rows.size() - active.length());
    }

    public File getDataRoot() { return dataRoot; }

    public synchronized JSONObject libraryCatalog() throws Exception { return management.catalog(); }
    public synchronized JSONObject changeLibrary(JSONObject request) throws Exception { return management.change(request); }
    public synchronized JSONArray listTrash() throws Exception { return management.listTrash(); }
    public synchronized JSONObject restoreTrash(String id) throws Exception { return management.restore(id); }
    public synchronized String exportName(String bankId, String group) throws Exception { return RepositoryExporter.name(this, bankId, group); }
    public synchronized JSONObject exportPackage(String bankId, String group, OutputStream output) throws Exception { return RepositoryExporter.export(this, bankId, group, output); }
    public synchronized JSONObject readEditor(String bankId, String questionId) throws Exception { return editor.read(bankId, questionId); }
    public synchronized JSONObject editQuestion(String bankId, String questionId, JSONObject request) throws Exception { return editor.save(bankId, questionId, request); }
    public synchronized JSONObject readEditorDraft(String bankId, String questionId) throws Exception { return editor.getDraft(bankId, questionId); }
    public synchronized JSONObject putEditorDraft(String bankId, String questionId, JSONObject request) throws Exception { return editor.putDraft(bankId, questionId, request); }
    public synchronized JSONObject deleteEditorDraft(String bankId, String questionId) throws Exception { return editor.deleteDraft(bankId, questionId); }

    public synchronized JSONArray listBanks() throws Exception {
        JSONArray records = readCatalog().getJSONArray("banks"), result = new JSONArray();
        for (int i = 0; i < records.length(); i++) result.put(descriptor(records.getJSONObject(i)));
        return result;
    }

    public synchronized JSONObject readBank(String bankId) throws Exception {
        JSONObject record = record(bankId);
        JSONObject bank = readJson(safeFile(importRoot(record), record.getString("bankPath")), MAX_FILE);
        JSONObject versions = editor.versions(record, bank);
        return new JSONObject().put("id", bankId).put("title", record.getString("title"))
                .put("group", record.optString("group", "")).put("bank", bank)
                .put("sourceVersion", versions.get("sourceVersion")).put("questionVersions", versions.get("questionVersions"));
    }

    public synchronized JSONObject readExtension(String bankId, String path) throws Exception {
        JSONObject record = record(bankId);
        // The caller must name an extension that actually belongs to this bank.
        JSONObject bank = readJson(safeFile(importRoot(record), record.getString("bankPath")), MAX_FILE);
        Set<String> references = new HashSet<>();
        JSONArray questions = bank.getJSONArray("questions");
        for (int i = 0; i < questions.length(); i++) references.add(extensionReference(questions.getJSONObject(i), bank));
        if (!references.contains(path)) throw invalid("题库没有绑定此拓展");
        return readExtensionFromRoot(importRoot(record), path);
    }

    public synchronized JSONObject importPackage(InputStream input, String filename) throws Exception {
        if (validator == null) throw new StorageException("ENGINE_UNAVAILABLE", "规则执行器尚未就绪，请稍后重试导入");
        if (input == null) throw invalid("没有可读取的题库文件");
        if (filename != null && (filename.length() > 1000 || !filename.toLowerCase(Locale.ROOT).endsWith(".qbank")))
            throw invalid("请选择 .qbank 题库文件");
        String importId = UUID.randomUUID().toString();
        File work = new File(stagingRoot, importId);
        directory(work);
        Exception importFailure = null;
        JSONObject importResult = null;
        try {
            File archive = new File(work, "upload.qbank");
            try (FileOutputStream output = new FileOutputStream(archive)) {
                copyBounded(input, output, MAX_UPLOAD, "题库包超过 64 MiB");
                output.getFD().sync();
            }
            File content = directory(new File(work, "content"));
            unzip(archive, content);
            JSONObject marker = readJson(safeFile(content, "quizforge-package.json"), 256 * 1024);
            if (!"quizforge-bank-group".equals(marker.optString("format")) || !marker.has("formatVersion") || integer(marker, "formatVersion") != 3)
                throw new StorageException("UNSUPPORTED_LIBRARY_ARCHIVE", "只支持格式 3 的 QuizForge 题库包，请先由制作者升级");
            String scope = marker.optString("scope", "group");
            if (!scope.equals("group") && !scope.equals("bank")) throw invalid("题库包 scope 无效");
            String sourceGroup = requiredText(marker, "group", 240);
            validSegment(sourceGroup);
            List<String> bankPaths = bankPaths(content, sourceGroup);
            if (bankPaths.isEmpty() || scope.equals("bank") && bankPaths.size() != 1)
                throw invalid("题库包没有题库，或单题库包包含多本题库");
            Map<String, JSONObject> extensions = extensionPackages(content, sourceGroup);
            if (extensions.isEmpty()) throw invalid("题库包没有配套拓展");
            validatePrivatePaths(content, extensions);
            Map<String, File> resources = resourceIndex(content);
            // Validate every bundled example, including extensions not referenced by a bank.
            for (Map.Entry<String, JSONObject> entry : extensions.entrySet()) {
                JSONObject extension = entry.getValue(), examples = extension.getJSONObject("examples");
                validator.validate(extension, new JSONArray());
                validateBank(examples, extensions, resources, entry.getKey());
            }

            JSONObject catalog = readCatalog();
            JSONArray records = catalog.getJSONArray("banks"), imported = new JSONArray();
            String displayName = importName(filename, sourceGroup);
            String displayGroup = scope.equals("group") ? uniqueGroup(displayName, records) : "";
            for (String bankPath : bankPaths) {
                JSONObject bank = readJson(safeFile(content, bankPath), MAX_FILE);
                validateBank(bank, extensions, resources, null);
                String leaf = bankPath.split("/")[2];
                String title = scope.equals("bank") ? uniqueTitle(displayName, records) : leaf;
                if (scope.equals("bank")) {
                    bank.put("title", title);
                    atomicWrite(safeFile(content, bankPath), bank.toString().getBytes(StandardCharsets.UTF_8));
                }
                JSONObject item = new JSONObject().put("id", UUID.randomUUID().toString())
                        .put("importId", importId).put("bankPath", bankPath).put("title", title)
                        .put("group", displayGroup).put("questionCount", bank.getJSONArray("questions").length())
                        .put("features", normalizedFeatures(bank.optJSONObject("features")))
                        .put("importedAt", System.currentTimeMillis());
                records.put(item);
                imported.put(descriptor(item));
            }
            File installed = new File(libraryRoot, importId);
            if (installed.exists() || !content.renameTo(installed)) throw new IOException("无法提交已校验的题库文件");
            // A catalog-write failure preserves the installed tree for diagnosis/recovery.
            // It must never cause cleanup of an unrelated or previously installed bank.
            management.normalize(catalog);
            catalog.put("revision", catalog.getLong("revision") + 1);
            atomicWrite(catalogFile, catalog.toString().getBytes(StandardCharsets.UTF_8));
            Map<String, File> installedResources = new HashMap<>();
            for (Map.Entry<String, File> resource : resources.entrySet()) {
                String relative = content.toPath().relativize(resource.getValue().toPath()).toString();
                installedResources.put(resource.getKey(), new File(installed, relative));
            }
            resourceIndexes.put(importId, installedResources);
            importResult = new JSONObject().put("banks", imported).put("importId", importId).put("scope", scope);
            return importResult;
        } catch (Exception failure) {
            importFailure = failure;
            throw failure;
        } finally {
            try { removeOwnStaging(work); }
            catch (Exception cleanupFailure) {
                if (importFailure != null) importFailure.addSuppressed(cleanupFailure);
                else if (importResult != null) importResult.put("cleanupWarning", "题库已导入；本次暂存文件未能全部清理");
                else throw cleanupFailure;
            }
        }
    }

    public synchronized JSONObject readState(String bankId) throws Exception {
        if (!record(bankId).getJSONObject("features").optBoolean("history", true)) return null;
        File file = new File(stateRoot, bankId + ".json");
        if (!file.exists() && !new File(file.getPath() + ".bak").exists()) return null;
        JSONObject state = readAtomicJson(file, MAX_STATE);
        if (state.optInt("schemaVersion", -1) != 1 || state.optLong("revision", -1) < 0)
            throw new StorageException("STATE_CORRUPT", "练习记录格式异常，已保留原文件");
        return state;
    }

    public synchronized JSONObject writeState(String bankId, JSONObject state, long expectedRevision) throws Exception {
        requirePersistence(bankId);
        if (state == null || state.optInt("schemaVersion", -1) != 1)
            throw new StorageException("INVALID_STATE", "练习记录格式无效");
        JSONObject old = readState(bankId);
        long current = old == null ? 0 : old.getLong("revision");
        if (expectedRevision != current) throw new StorageException("REVISION_CONFLICT", "练习记录已变化，请重新读取后保存");
        if (current == Long.MAX_VALUE) throw new StorageException("STATE_LIMIT", "练习记录版本已达到上限");
        JSONObject copy = new JSONObject(state.toString()).put("revision", current + 1);
        byte[] bytes = copy.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_STATE) throw new StorageException("STATE_LIMIT", "本题库记录超过 32 MiB，请先导出备份；旧记录已保留");
        atomicWrite(new File(stateRoot, bankId + ".json"), bytes);
        return copy;
    }

    public synchronized JSONObject putResource(String bankId, String mime, String base64) throws Exception {
        requirePersistence(bankId);
        return storeResource(directory(new File(stateRoot, "resources/" + bankId)), mime, base64);
    }

    public synchronized JSONObject putEditorResource(String bankId, String mime, String base64) throws Exception {
        if (!record(bankId).getJSONObject("features").optBoolean("editing", true))
            throw new StorageException("EDITING_DISABLED", "此题库已关闭编辑");
        return storeResource(directory(new File(dataRoot, "author-resources/" + bankId)), mime, base64);
    }

    private JSONObject storeResource(File root, String mime, String base64) throws Exception {
        if (!IMAGE_EXTENSIONS.containsKey(mime)) throw new StorageException("IMAGE_TYPE_UNSUPPORTED", "仅支持 PNG、JPEG、WebP、GIF 图片");
        if (base64 == null || base64.isEmpty() || base64.length() > ((MAX_IMAGE + 2L) / 3L) * 4L || !validBase64(base64))
            throw new StorageException("IMAGE_SIZE_LIMIT", "图片编码无效或超过 4 MiB");
        byte[] bytes;
        try { bytes = Base64.decode(base64, Base64.NO_WRAP); }
        catch (IllegalArgumentException e) { throw invalid("图片 Base64 编码无效"); }
        checkImage(bytes, mime);
        String id = sha256(bytes);
        File file = new File(root, id + "." + IMAGE_EXTENSIONS.get(mime));
        if (!file.exists()) atomicWrite(file, bytes);
        else if (!Arrays.equals(readBytes(file, MAX_IMAGE), bytes))
            throw new StorageException("RESOURCE_UNAVAILABLE", "已有图片校验失败，原件已保留");
        return new JSONObject().put("id", id).put("mime", mime).put("size", bytes.length);
    }

    public synchronized JSONObject getResource(String bankId, String id) throws Exception {
        JSONObject record = record(bankId);
        if (id == null || !id.matches("[a-f0-9]{64}")) throw invalid("图片资源标识无效");
        for (File uploaded : new File[]{new File(dataRoot, "author-resources/" + bankId), new File(stateRoot, "resources/" + bankId)}) {
            for (Map.Entry<String, String> type : IMAGE_EXTENSIONS.entrySet()) {
                File file = new File(uploaded, id + "." + type.getValue());
                if (file.exists()) return resourceReply(file, id);
            }
        }
        String importId = record.getString("importId");
        Map<String, File> index = resourceIndexes.get(importId);
        if (index == null) {
            index = resourceIndex(importRoot(record));
            resourceIndexes.put(importId, index);
        }
        File file = index.get(id);
        if (file == null) throw new StorageException("RESOURCE_NOT_FOUND", "图片资源不存在");
        return resourceReply(file, id);
    }

    private JSONObject resourceReply(File file, String id) throws Exception {
        byte[] bytes = readBytes(file, MAX_IMAGE);
        String mime = imageMime(bytes);
        if (mime == null || !sha256(bytes).equals(id))
            throw new StorageException("RESOURCE_UNAVAILABLE", "图片资源校验失败，原件已保留");
        return new JSONObject().put("id", id).put("mime", mime).put("size", bytes.length)
                .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
    }

    JSONObject readCatalog() throws Exception {
        transactions.recover();
        if (!catalogFile.exists() && !new File(catalogFile.getPath() + ".bak").exists())
            return new JSONObject().put("schemaVersion", 1).put("banks", new JSONArray()).put("groups", new JSONArray()).put("trash", new JSONArray()).put("revision", 0);
        JSONObject catalog = readAtomicJson(catalogFile, 4 * 1024 * 1024);
        if (catalog.optInt("schemaVersion", -1) != 1 || catalog.optJSONArray("banks") == null)
            throw new StorageException("CATALOG_CORRUPT", "题库目录记录异常，已保留原文件");
        Set<String> ids = new HashSet<>();
        JSONArray banks = catalog.getJSONArray("banks");
        for (int i = 0; i < banks.length(); i++) {
            JSONObject record = banks.getJSONObject(i);
            String id = record.optString("id"), importId = record.optString("importId");
            if (!uuid(id) || !uuid(importId) || !ids.add(id)) throw new StorageException("CATALOG_CORRUPT", "题库目录标识异常，已保留原文件");
            safeFile(new File(libraryRoot, importId), record.getString("bankPath"));
        }
        if (!catalog.has("groups")) {
            Set<String> names = new java.util.TreeSet<>();
            for (int i = 0; i < banks.length(); i++) if (!banks.getJSONObject(i).optString("group").isEmpty()) names.add(banks.getJSONObject(i).getString("group"));
            catalog.put("groups", new JSONArray(names));
        }
        if (!catalog.has("trash")) catalog.put("trash", new JSONArray());
        if (!catalog.has("revision")) catalog.put("revision", 0);
        return catalog;
    }

    JSONObject record(String bankId) throws Exception {
        if (!uuid(bankId)) throw new StorageException("BANK_NOT_FOUND", "题库不存在");
        JSONArray banks = readCatalog().getJSONArray("banks");
        for (int i = 0; i < banks.length(); i++) if (banks.getJSONObject(i).getString("id").equals(bankId)) return banks.getJSONObject(i);
        throw new StorageException("BANK_NOT_FOUND", "题库不存在");
    }

    private void requirePersistence(String bankId) throws Exception {
        if (!record(bankId).getJSONObject("features").optBoolean("history", true))
            throw new StorageException("PERSISTENCE_DISABLED", "此题库已关闭练习保存，答案和临时图片仅保留在当前页面");
    }

    File importRoot(JSONObject record) throws Exception {
        String importId = record.getString("importId");
        if (!uuid(importId)) throw new StorageException("CATALOG_CORRUPT", "题库目录标识无效");
        File root = safeFile(libraryRoot, importId);
        if (!root.isDirectory()) throw new StorageException("BANK_UNAVAILABLE", "题库文件缺失，请从原始题库包重新导入");
        return root;
    }

    static JSONObject descriptor(JSONObject record) throws JSONException {
        return new JSONObject().put("id", record.getString("id")).put("title", record.getString("title"))
                .put("group", record.optString("group", "")).put("questionCount", record.getInt("questionCount"))
                .put("features", record.getJSONObject("features")).put("importedAt", record.optLong("importedAt"))
                .put("path", (record.optString("group").isEmpty() ? "" : record.getString("group") + "/") + record.getString("title"));
    }

    private static List<String> bankPaths(File root, String group) throws Exception {
        File banks = safeFile(root, "question-banks");
        if (!banks.isDirectory()) throw invalid("题库包缺少 question-banks");
        File[] groups = sortedFiles(banks);
        if (groups.length != 1 || !groups[0].isDirectory() || !groups[0].getName().equals(group))
            throw invalid("题库包分组与清单不一致");
        List<String> paths = new ArrayList<>();
        for (File leaf : sortedFiles(groups[0])) {
            if (!leaf.isDirectory()) throw invalid("题库必须使用文件夹结构");
            File bank = new File(leaf, "bank.json");
            if (!bank.isFile()) throw invalid("题库文件夹缺少 bank.json");
            paths.add("question-banks/" + group + "/" + leaf.getName() + "/bank.json");
        }
        return paths;
    }

    private Map<String, JSONObject> extensionPackages(File root, String expectedGroup) throws Exception {
        File extensions = safeFile(root, "extensions");
        if (!extensions.isDirectory()) throw invalid("题库包缺少 extensions");
        File[] groups = sortedFiles(extensions);
        if (groups.length != 1 || !groups[0].isDirectory() || !groups[0].getName().equals(expectedGroup))
            throw invalid("题库与拓展必须各包含一个与清单一致的配套分组");
        Map<String, JSONObject> result = new LinkedHashMap<>();
        for (File group : groups) {
            if (!group.isDirectory()) throw invalid("拓展需要一层物理分组");
            for (File leaf : sortedFiles(group)) {
                if (!leaf.isDirectory()) throw invalid("拓展必须使用独立文件夹");
                String path = "extensions/" + group.getName() + "/" + leaf.getName();
                result.put(path, readExtensionFromRoot(root, path));
            }
        }
        return result;
    }

    static JSONObject readExtensionFromRoot(File root, String path) throws Exception {
        if (path == null || path.split("/", -1).length != 3 || !path.startsWith("extensions/")) throw invalid("拓展绑定路径无效");
        File leaf = safeFile(root, path);
        JSONObject manifest = readJson(safeFile(leaf, "manifest.json"), 256 * 1024);
        if (!manifest.has("id")) manifest.put("id", "extension");
        if (!manifest.has("version")) manifest.put("version", "0.0.0");
        manifest.put("name", leaf.getName());
        if (manifest.has("types") || manifest.has("packageFormatVersion")) throw invalid("每个拓展必须仅提供一个独立题型");
        for (String field : REQUIRED) requiredText(manifest, field, 240);
        validateApi(manifest);
        JSONObject result = new JSONObject().put("path", path).put("manifest", manifest)
                .put("entryPath", manifest.getString("entry")).put("stylePath", manifest.getString("style"));
        for (String field : new String[]{"entry", "script", "style", "rules"}) {
            String value = readText(declaredFile(leaf, manifest.getString(field)), MAX_SOURCE);
            result.put(field.equals("entry") ? "html" : field, value);
        }
        for (String field : new String[]{"questionSchema", "answerSchema"}) {
            String source = readText(declaredFile(leaf, manifest.getString(field)), MAX_SOURCE);
            Object schema = new org.json.JSONTokener(source).nextValue();
            if (!(schema instanceof JSONObject) && !(schema instanceof Boolean)) throw invalid("拓展 Schema 必须为对象或布尔值");
            result.put(field, schema);
        }
        result.put("examples", readJson(declaredFile(leaf, manifest.getString("examples")), MAX_FILE));
        JSONArray media = manifest.optJSONArray("assets"), assets = new JSONArray();
        if (manifest.has("assets") && media == null || media != null && media.length() > 100) throw invalid("拓展静态资源列表无效");
        Set<String> seen = new HashSet<>();
        long total = 0;
        if (media != null) for (int i = 0; i < media.length(); i++) {
            Object item = media.get(i);
            if (!(item instanceof String)) throw invalid("拓展静态资源路径无效");
            String relative = (String) item;
            if (!seen.add(relative)) throw invalid("拓展静态资源重复声明");
            byte[] bytes = readBytes(declaredFile(leaf, relative), MAX_SOURCE);
            if ((total += bytes.length) > MAX_FILE) throw invalid("拓展内联资源总大小超过 8 MiB");
            String mime = mediaMime(relative);
            if (mime == null) throw invalid("拓展静态资源仅支持图片和字体");
            String encoded = Base64.encodeToString(bytes, Base64.NO_WRAP);
            assets.put(new JSONObject().put("path", relative).put("mime", mime).put("base64", encoded)
                    .put("dataUrl", "data:" + mime + ";base64," + encoded));
        }
        result.put("assets", assets);
        File editorConfig = new File(leaf, "editor.json");
        if (editorConfig.isFile()) {
            JSONObject config = readJson(editorConfig, 256 * 1024);
            JSONObject page = new JSONObject().put("html", readText(declaredFile(leaf, requiredText(config, "entry", 240)), MAX_SOURCE))
                    .put("script", readText(declaredFile(leaf, requiredText(config, "script", 240)), MAX_SOURCE))
                    .put("style", readText(declaredFile(leaf, requiredText(config, "style", 240)), MAX_SOURCE))
                    .put("entryPath", config.getString("entry")).put("stylePath", config.getString("style"))
                    .put("assets", assets).put("manifest", manifest);
            result.put("editor", page);
        } else result.put("editor", JSONObject.NULL);
        return result;
    }

    void validateEditedData(JSONObject extension, Object data) throws Exception {
        if (validator == null) throw new StorageException("ENGINE_UNAVAILABLE", "规则执行器尚未就绪");
        validator.validate(extension, new JSONArray().put(data));
    }

    private void validateBank(JSONObject bank, Map<String, JSONObject> extensions, Map<String, File> resources, String selfReference) throws Exception {
        if (bank.has("formatVersion") && integer(bank, "formatVersion") != 1)
            throw invalid("题库 formatVersion 必须为 1");
        JSONArray questions = bank.optJSONArray("questions");
        if (questions == null || questions.length() == 0 || questions.length() > 10000) throw invalid("题库题目列表为空、无效或超过 10000 题");
        normalizedFeatures(bank.optJSONObject("features"));
        if (bank.has("features") && bank.optJSONObject("features") == null) throw invalid("题库功能开关格式无效");
        Set<String> ids = new HashSet<>();
        Map<String, JSONArray> byExtension = new LinkedHashMap<>();
        for (int i = 0; i < questions.length(); i++) {
            JSONObject question = questions.getJSONObject(i);
            String id = requiredText(question, "id", 120);
            if (!id.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,119}")) throw invalid("题目 ID 格式无效");
            if (!ids.add(id) || question.has("features")) throw invalid("题目 ID 重复或声明了题级功能开关");
            requiredText(question, "title", 300);
            String path = extensionReference(question, bank);
            if (selfReference != null && !selfReference.equals(path)) throw invalid("拓展样例必须准确绑定自身路径");
            JSONObject extension = extensions.get(path);
            if (extension == null) throw invalid("题目绑定的拓展不在题库包内");
            JSONObject reference = question.optJSONObject("extension");
            if (reference == null) reference = bank.optJSONObject("extension");
            if (reference != null && reference.has("id") && !reference.getString("id").equals(extension.getJSONObject("manifest").optString("id")))
                throw invalid("拓展路径与声明 ID 不一致");
            if (!question.has("data")) throw invalid("题目缺少 data");
            validateOutline(question.optJSONObject("outline"));
            if (question.has("outline") && question.optJSONObject("outline") == null) throw invalid("题目目录需要对象");
            if (question.optJSONObject("outline") != null && question.getJSONObject("outline").optString("level").equals("parts")) {
                JSONObject requirement = extension.getJSONObject("manifest").optJSONObject("requiresApi");
                JSONArray capabilities = requirement == null ? null : requirement.optJSONArray("capabilities");
                boolean declared = false;
                if (capabilities != null) for (int j = 0; j < capabilities.length(); j++)
                    if ("outline-items".equals(capabilities.get(j))) declared = true;
                if (!declared) throw invalid("显式小题目录需要拓展声明 outline-items 能力");
            }
            JSONArray raw = byExtension.get(path);
            if (raw == null) { raw = new JSONArray(); byExtension.put(path, raw); }
            raw.put(question.get("data"));
        }
        validateImageReferences(bank, resources, 0);
        for (Map.Entry<String, JSONArray> entry : byExtension.entrySet()) {
            // Bound each callback; rules are synchronous and should not allocate a
            // 10000-question script at once on a lower-memory tablet.
            JSONArray all = entry.getValue();
            for (int offset = 0; offset < all.length(); offset += 128) {
                JSONArray batch = new JSONArray();
                for (int j = offset; j < Math.min(offset + 128, all.length()); j++) batch.put(all.get(j));
                validator.validate(extensions.get(entry.getKey()), batch);
            }
        }
    }

    private static void validateApi(JSONObject manifest) throws Exception {
        JSONObject api = manifest.optJSONObject("requiresApi");
        if (manifest.has("requiresApi") && api == null) throw invalid("拓展 requiresApi 无效");
        if (api != null) {
            Iterator<String> fields = api.keys();
            while (fields.hasNext()) if (!Arrays.asList("major", "minMinor", "capabilities").contains(fields.next()))
                throw invalid("拓展 API 声明包含未知字段");
            if (integer(api, "major") != 1 || integer(api, "minMinor") < 0 || integer(api, "minMinor") > 5)
                throw new StorageException("UNSUPPORTED_API_VERSION", "拓展要求的 API 版本尚未支持");
            JSONArray capabilities = api.optJSONArray("capabilities");
            if (api.has("capabilities") && capabilities == null || capabilities != null && capabilities.length() > 100)
                throw invalid("拓展能力声明无效");
            Set<String> seen = new HashSet<>();
            if (capabilities != null) for (int i = 0; i < capabilities.length(); i++) {
                String cap = capabilities.getString(i);
                if (!API_CAPABILITIES.contains(cap) || !seen.add(cap)) throw invalid("拓展要求未知或重复能力");
                int min = cap.equals("outline-items") ? 1 : cap.equals("answer-state") ? 3 : cap.equals("appearance") ? 4 : cap.equals("answer-areas") ? 5 : 0;
                if (api.getInt("minMinor") < min) throw invalid("拓展能力与 API 版本不一致");
            }
        }
        JSONObject richtext = manifest.optJSONObject("requiresRichText");
        if (manifest.has("requiresRichText") && richtext == null) throw invalid("富文本服务声明无效");
        if (richtext != null && manifest.has("dependencies")) throw invalid("富文本需求与旧公共组件依赖不能同时声明");
        if (richtext != null && (integer(richtext, "major") != 1 || integer(richtext, "minMinor") < 0
                || integer(richtext, "minMinor") > 1 || integer(richtext, "documentFormat") != 1
                || !Arrays.asList("basic-v1", "advanced-v1").contains(richtext.optString("documentProfile"))))
            throw new StorageException("UNSUPPORTED_RICHTEXT", "拓展要求的富文本版本尚未支持");
        if (richtext != null) {
            Iterator<String> fields = richtext.keys();
            while (fields.hasNext()) if (!Arrays.asList("major", "minMinor", "documentFormat", "documentProfile", "capabilities").contains(fields.next()))
                throw invalid("富文本需求包含未知字段");
        }
        if (richtext != null && richtext.has("capabilities")) {
            JSONArray capabilities = richtext.optJSONArray("capabilities");
            if (capabilities == null || capabilities.length() > 100) throw invalid("富文本能力声明无效");
            Set<String> supported = new HashSet<>(Arrays.asList("basic-formatting", "images"));
            if (richtext.getString("documentProfile").equals("advanced-v1"))
                supported.addAll(Arrays.asList("advanced-formatting", "tables", "math", "image-resize", "camera-capture"));
            Set<String> seen = new HashSet<>();
            for (int i = 0; i < capabilities.length(); i++) {
                Object value = capabilities.get(i);
                if (!(value instanceof String) || !supported.contains((String) value) || !seen.add((String) value))
                    throw new StorageException("UNSUPPORTED_RICHTEXT", "拓展要求未知或重复的富文本能力");
            }
        }
        if (manifest.has("dependencies")) {
            JSONArray dependencies = manifest.optJSONArray("dependencies");
            if (dependencies == null || dependencies.length() > 16) throw invalid("拓展公共组件依赖声明无效");
            for (int i = 0; i < dependencies.length(); i++) {
                JSONObject dependency = dependencies.getJSONObject(i);
                if (!dependency.optString("id").equals("quizforge.richtext")
                        || !Arrays.asList("1.0.0", "1.1.0", "1.1.1", "1.1.2", "1.1.3").contains(dependency.optString("version")))
                    throw new StorageException("UNSUPPORTED_PUBLIC_SDK", "拓展依赖的公共组件尚未内置");
            }
        }
    }

    private static void validateOutline(JSONObject outline) throws Exception {
        if (outline == null) return;
        if (outline.length() != 2) throw invalid("题目目录字段无效");
        String level = outline.optString("level");
        if (level.equals("question")) { plainText(outline, "label", 80); return; }
        if (!level.equals("parts")) throw invalid("题目目录级别无效");
        JSONArray items = outline.optJSONArray("items");
        if (items == null || items.length() < 1 || items.length() > 100) throw invalid("题目目录列表无效");
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.getJSONObject(i);
            if (item.length() != 2) throw invalid("小题目录字段无效");
            String id = plainText(item, "id", 128);
            plainText(item, "label", 80);
            if (!seen.add(id)) throw invalid("题目目录 ID 重复");
        }
    }

    static String extensionReference(JSONObject question, JSONObject bank) throws Exception {
        JSONObject reference = question.optJSONObject("extension");
        if (question.has("extension") && reference == null) throw invalid("题目拓展绑定无效");
        if (reference == null) reference = bank.optJSONObject("extension");
        if (reference == null || !reference.has("path") || reference.has("development") || reference.has("version"))
            throw new StorageException("EXTENSION_REFERENCE_UPGRADE_REQUIRED", "题目需要通过准确的拓展路径绑定，请由制作者升级");
        String path = requiredText(reference, "path", 720);
        String[] parts = path.split("/", -1);
        if (parts.length != 3 || !parts[0].equals("extensions")) throw invalid("拓展路径需要一层分组和一个独立题型目录");
        for (String part : parts) validSegment(part);
        return path;
    }

    private static JSONObject normalizedFeatures(JSONObject source) throws Exception {
        JSONObject result = new JSONObject();
        Set<String> allowed = new HashSet<>(Arrays.asList("editing", "whiteboard", "history", "exam"));
        if (source != null) {
            Iterator<String> keys = source.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (!allowed.contains(key) || !(source.get(key) instanceof Boolean)) throw invalid("题库功能开关必须为已知布尔字段");
            }
        }
        for (String key : allowed) result.put(key, source == null || !source.has(key) || source.getBoolean(key));
        return result;
    }

    private static Map<String, File> resourceIndex(File root) throws Exception {
        Map<String, File> result = new HashMap<>();
        collectResources(root, result, 0, new int[]{0});
        return result;
    }

    private static void collectResources(File directory, Map<String, File> result, int depth, int[] count) throws Exception {
        if (depth > 32) throw invalid("资源目录过深");
        for (File file : sortedFiles(directory)) {
            if (++count[0] > 100000) throw invalid("资源条目超过上限");
            if (Files.isSymbolicLink(file.toPath())) throw invalid("资源目录包含链接");
            if (file.isDirectory()) { collectResources(file, result, depth + 1, count); continue; }
            String name = file.getName();
            if (!name.matches("[a-f0-9]{64}\\.(?:png|jpe?g|webp|gif)")) continue;
            byte[] bytes = readBytes(file, MAX_IMAGE);
            String id = name.substring(0, 64), mime = imageMime(bytes);
            if (mime == null || !sha256(bytes).equals(id)) throw invalid("题库图片格式或 SHA-256 校验失败");
            String suffix = name.substring(65);
            if (!(IMAGE_EXTENSIONS.get(mime).equals(suffix) || mime.equals("image/jpeg") && suffix.equals("jpeg")))
                throw invalid("题库图片扩展名与实际格式不一致");
            result.put(id, file);
        }
    }

    private static void validateImageReferences(Object node, Map<String, File> resources, int depth) throws Exception {
        if (depth > 128) throw invalid("题库内容嵌套过深");
        if (node instanceof JSONObject) {
            JSONObject object = (JSONObject) node;
            if (object.optString("type").equals("image") && object.optJSONObject("attrs") != null
                    && object.getJSONObject("attrs").has("assetId")) {
                String id = object.getJSONObject("attrs").optString("assetId");
                if (!id.matches("[a-f0-9]{64}") || !resources.containsKey(id)) throw invalid("题库引用的图片缺失或资源标识无效");
            }
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) validateImageReferences(object.get(keys.next()), resources, depth + 1);
        } else if (node instanceof JSONArray) {
            JSONArray array = (JSONArray) node;
            for (int i = 0; i < array.length(); i++) validateImageReferences(array.get(i), resources, depth + 1);
        }
    }

    private static void unzip(File archive, File destination) throws Exception {
        verifyZipDirectory(archive);
        long total = 0;
        int count = 0;
        Set<String> seen = new HashSet<>();
        try (ZipFile zip = new ZipFile(archive, StandardCharsets.UTF_8)) {
            Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                if (++count > MAX_ENTRIES) throw limit("压缩包文件数量超过 10000");
                String path = archivePath(entry.getName(), entry.isDirectory());
                if (!seen.add(path.toLowerCase(Locale.ROOT))) throw invalid("压缩包包含重复路径");
                File target = safeFile(destination, path);
                if (entry.isDirectory()) { directory(target); continue; }
                if (entry.getSize() < 0 || entry.getSize() > MAX_FILE) throw limit("压缩包单个文件超过 8 MiB");
                directory(target.getParentFile());
                if (!target.createNewFile()) throw invalid("压缩包路径发生冲突");
                CRC32 crc = new CRC32();
                long bytes = 0;
                try (InputStream input = zip.getInputStream(entry); FileOutputStream output = new FileOutputStream(target)) {
                    byte[] buffer = new byte[32 * 1024];
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        if (read == 0) continue;
                        bytes += read;
                        if (bytes > MAX_FILE || total + bytes > MAX_EXPANDED) throw limit("压缩包超过解压大小上限");
                        crc.update(buffer, 0, read);
                        output.write(buffer, 0, read);
                    }
                    output.getFD().sync();
                }
                if (bytes != entry.getSize() || crc.getValue() != entry.getCrc()) throw invalid("压缩包文件长度或 CRC 校验失败");
                total += bytes;
            }
        } catch (StorageException e) { throw e; }
        catch (IOException | IllegalArgumentException e) { throw new StorageException("INVALID_LIBRARY_ARCHIVE", "压缩包损坏或不是有效的 ZIP 文件", e); }
    }

    /** java.util.zip does not expose Unix file modes; inspect central records first. */
    private static void verifyZipDirectory(File file) throws Exception {
        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
            long length = input.length();
            if (length < 22) throw invalid("压缩包不完整");
            int tailSize = (int) Math.min(length, 65557);
            byte[] tail = new byte[tailSize];
            input.seek(length - tailSize); input.readFully(tail);
            int end = -1;
            for (int i = tail.length - 22; i >= 0; i--) {
                if (u32(tail, i) == 0x06054b50L && i + 22 + u16(tail, i + 20) == tail.length) { end = i; break; }
            }
            if (end < 0 || u16(tail, end + 4) != 0 || u16(tail, end + 6) != 0) throw invalid("不支持多卷或无效 ZIP");
            int entries = u16(tail, end + 10);
            if (entries != u16(tail, end + 8) || entries == 0xffff || entries > MAX_ENTRIES) throw limit("压缩包条目数量无效或过多");
            long size = u32(tail, end + 12), offset = u32(tail, end + 16), endOffset = length - tailSize + end;
            if (size == 0xffffffffL || offset == 0xffffffffL || offset + size != endOffset) throw invalid("不支持 ZIP64 或无效 ZIP 目录");
            input.seek(offset);
            for (int i = 0; i < entries; i++) {
                byte[] header = new byte[46]; input.readFully(header);
                if (u32(header, 0) != 0x02014b50L || (u16(header, 8) & 1) != 0 || u16(header, 34) != 0)
                    throw invalid("压缩包包含加密文件或无效目录项");
                int mode = (int) ((u32(header, 38) >>> 16) & 0xf000);
                if (mode != 0 && mode != 0x8000 && mode != 0x4000) throw invalid("压缩包包含符号链接或特殊文件");
                int names = u16(header, 28), extra = u16(header, 30), comments = u16(header, 32);
                if (names == 0 || names > 4096) throw invalid("压缩包路径长度无效");
                byte[] name = new byte[names]; input.readFully(name);
                boolean directory = name[name.length - 1] == '/';
                if (mode == 0x4000 && !directory || mode == 0x8000 && directory) throw invalid("压缩包文件类型与名称不一致");
                if (u32(header, 20) == 0xffffffffL || u32(header, 24) == 0xffffffffL || u32(header, 42) == 0xffffffffL)
                    throw invalid("不支持 ZIP64 文件");
                input.seek(input.getFilePointer() + extra + comments);
                if (input.getFilePointer() > offset + size) throw invalid("压缩包目录越界");
            }
            if (input.getFilePointer() != offset + size) throw invalid("压缩包目录条目数量不一致");
        }
    }

    private static String archivePath(String raw, boolean directory) throws Exception {
        String path = directory && raw.endsWith("/") ? raw.substring(0, raw.length() - 1) : raw;
        String[] parts = path.split("/", -1);
        if (parts.length > 32 || parts.length == 0) throw invalid("压缩包路径深度无效");
        for (String part : parts) validSegment(part);
        if (!parts[0].equals("question-banks") && !parts[0].equals("extensions")
                && !(parts.length == 1 && path.equals("quizforge-package.json") && !directory))
            throw invalid("题库包顶层仅允许格式清单、question-banks 和 extensions");
        // A manifest may deliberately declare a private source/media file. Those
        // are checked against exact declarations after extraction. Host identities
        // and persisted state are never accepted as part of an exchange package.
        for (String part : parts) if (part.equals(".state") || part.equals(".instance.json") || part.equals(".bundle.json"))
            throw invalid("题库包不能携带宿主状态或本地保存身份");
        return path;
    }

    private static void validatePrivatePaths(File root, Map<String, JSONObject> extensions) throws Exception {
        Set<String> declared = new HashSet<>();
        for (Map.Entry<String, JSONObject> entry : extensions.entrySet()) {
            File leaf = safeFile(root, entry.getKey());
            JSONObject manifest = entry.getValue().getJSONObject("manifest");
            for (String field : REQUIRED) declarePath(leaf, declaredFile(leaf, manifest.getString(field)), declared);
            JSONArray media = manifest.optJSONArray("assets");
            if (media != null) for (int i = 0; i < media.length(); i++) declarePath(leaf, declaredFile(leaf, media.getString(i)), declared);
            File editor = new File(leaf, "editor.json");
            if (editor.exists()) {
                JSONObject config = readJson(editor, 256 * 1024);
                for (String field : new String[]{"entry", "script", "style"})
                    declarePath(leaf, declaredFile(leaf, requiredText(config, field, 240)), declared);
            }
        }
        inspectPrivatePaths(root, root, declared, 0);
    }

    private static void declarePath(File leaf, File file, Set<String> declared) throws IOException {
        File base = leaf.getCanonicalFile(), cursor = file.getCanonicalFile();
        while (!cursor.equals(base)) {
            declared.add(cursor.getPath());
            cursor = cursor.getParentFile();
        }
    }

    private static void inspectPrivatePaths(File root, File directory, Set<String> declared, int depth) throws Exception {
        if (depth > 32) throw invalid("题库包目录过深");
        for (File file : sortedFiles(directory)) {
            String relative = root.toPath().relativize(file.toPath()).toString().replace(File.separatorChar, '/');
            String[] parts = relative.split("/");
            boolean isPrivate = false;
            // The physical group and leaf names identify the package layout;
            // privacy checks concern files and directories inside each leaf.
            for (int i = 3; i < parts.length; i++) if (parts[i].startsWith(".") || parts[i].equals("node_modules") || parts[i].equals("target"))
                isPrivate = true;
            if (isPrivate && !declared.contains(file.getCanonicalPath())) throw invalid("题库包包含未声明的私有文件或目录");
            if (file.isDirectory()) inspectPrivatePaths(root, file, declared, depth + 1);
        }
    }

    static File safeFile(File root, String relative) throws Exception {
        if (relative == null || relative.isEmpty() || relative.length() > 4096 || relative.startsWith("/")) throw invalid("文件路径无效");
        for (String part : relative.split("/", -1)) validSegment(part);
        File base = root.getCanonicalFile(), result = new File(base, relative).getCanonicalFile();
        if (!result.getPath().startsWith(base.getPath() + File.separator)) throw invalid("文件路径越界");
        return result;
    }

    static File declaredFile(File root, String relative) throws Exception {
        // Web manifests allow ordinary ./ and internal ../ normalization while
        // requiring that the resolved target stays inside the extension leaf.
        if (relative == null || relative.isEmpty() || relative.length() > 240 || relative.startsWith("/")
                || relative.indexOf('\\') >= 0 || relative.indexOf(':') >= 0 || relative.indexOf('\0') >= 0)
            throw invalid("拓展声明文件路径无效");
        File base = root.getCanonicalFile(), result = new File(base, relative).getCanonicalFile();
        if (!result.getPath().startsWith(base.getPath() + File.separator) || !result.isFile())
            throw invalid("拓展声明文件缺失或路径越界");
        return result;
    }

    static void validSegment(String part) throws StorageException {
        if (part == null || part.isEmpty() || !part.equals(part.trim()) || part.equals(".") || part.equals("..")
                || part.matches(".*[\\\\:*?\"<>|\\p{Cntrl}].*") || part.endsWith(".")
                || part.matches("(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\..*)?"))
            throw invalid("文件路径包含无效或越界名称");
    }

    private static File directory(File file) throws IOException {
        if (Files.isSymbolicLink(file.toPath())) throw new IOException("不允许链接目录");
        if (!file.isDirectory() && !file.mkdirs()) throw new IOException("无法创建本地数据目录");
        return file;
    }

    private void removeOwnStaging(File work) throws Exception {
        if (!work.getCanonicalFile().getParentFile().equals(stagingRoot.getCanonicalFile()) || !uuid(work.getName()))
            throw new IOException("拒绝清理非本次导入目录");
        removeStagingTree(work, work.getCanonicalFile());
    }

    private static void removeStagingTree(File file, File root) throws IOException {
        if (!file.exists() && !Files.isSymbolicLink(file.toPath())) return;
        if (Files.isSymbolicLink(file.toPath())) { if (!file.delete()) throw new IOException("无法清理导入暂存链接"); return; }
        File canonical = file.getCanonicalFile();
        if (!canonical.equals(root) && !canonical.getPath().startsWith(root.getPath() + File.separator)) throw new IOException("导入暂存路径越界");
        if (file.isDirectory()) for (File child : sortedFiles(file)) removeStagingTree(child, root);
        if (!file.delete()) throw new IOException("无法清理本次导入暂存文件");
    }

    static JSONObject readJson(File file, int max) throws Exception {
        try { return new JSONObject(readText(file, max)); }
        catch (JSONException e) { throw new StorageException("INVALID_JSON", "题库或记录不是有效的 JSON 对象", e); }
    }

    static JSONObject readAtomicJson(File file, int max) throws Exception {
        try (InputStream input = new AtomicFile(file).openRead()) {
            return new JSONObject(utf8(readBounded(input, max)));
        } catch (JSONException | CharacterCodingException e) {
            throw new StorageException("STORAGE_CORRUPT", "本地记录损坏，已保留原文件", e);
        }
    }

    static String readText(File file, int max) throws Exception { return utf8(readBytes(file, max)); }

    private static String utf8(byte[] bytes) throws CharacterCodingException {
        String value = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        return value.startsWith("\ufeff") ? value.substring(1) : value;
    }

    static byte[] readBytes(File file, int max) throws Exception {
        if (!file.isFile() || Files.isSymbolicLink(file.toPath()) || file.length() > max) throw invalid("文件缺失、过大或包含链接");
        try (InputStream input = new FileInputStream(file)) { return readBounded(input, max); }
    }

    private static byte[] readBounded(InputStream input, int max) throws IOException, StorageException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        copyBounded(input, output, max, "文件超过大小上限");
        return output.toByteArray();
    }

    private static long copyBounded(InputStream input, java.io.OutputStream output, long max, String message) throws IOException, StorageException {
        long count = 0;
        byte[] buffer = new byte[32 * 1024];
        int read;
        while ((read = input.read(buffer)) != -1) {
            if (read == 0) continue;
            if ((count += read) > max) throw limit(message);
            output.write(buffer, 0, read);
        }
        return count;
    }

    static void atomicWrite(File file, byte[] bytes) throws IOException {
        directory(file.getParentFile());
        AtomicFile atomic = new AtomicFile(file);
        FileOutputStream output = null;
        try {
            output = atomic.startWrite();
            output.write(bytes);
            output.getFD().sync();
            atomic.finishWrite(output);
        } catch (IOException | RuntimeException e) {
            if (output != null) atomic.failWrite(output);
            throw e;
        }
    }

    static String requiredText(JSONObject object, String key, int max) throws Exception {
        Object raw = object.opt(key);
        if (!(raw instanceof String)) throw invalid("缺少有效字段：" + key);
        String value = (String) raw;
        if (value.trim().isEmpty() || value.length() > max)
            throw invalid("字段内容无效：" + key);
        return value;
    }

    private static String plainText(JSONObject object, String key, int max) throws Exception {
        String value = requiredText(object, key, max);
        if (!value.equals(value.trim()) || value.matches(".*[\\p{Cntrl}<>].*")) throw invalid("目录需要纯文本字段：" + key);
        return value;
    }

    private static int integer(JSONObject object, String key) throws StorageException {
        Object raw = object.opt(key);
        if (!(raw instanceof Number)) throw invalid("版本声明需要整数：" + key);
        double value = ((Number) raw).doubleValue();
        if (!Double.isFinite(value) || value != Math.rint(value) || value < Integer.MIN_VALUE || value > Integer.MAX_VALUE)
            throw invalid("版本声明需要整数：" + key);
        return (int) value;
    }

    private static String importName(String filename, String fallback) {
        String value = filename == null ? fallback : filename.replaceFirst("(?i)\\.qbank$", "");
        value = value.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim().replaceAll("[ .]+$", "");
        if (value.isEmpty() || value.matches("(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\..*)?")) value = "导入题库";
        return value.length() > 120 ? value.substring(0, 120) : value;
    }

    private static String uniqueTitle(String name, JSONArray records) throws JSONException {
        Set<String> names = new HashSet<>();
        for (int i = 0; i < records.length(); i++) if (records.getJSONObject(i).optString("group").isEmpty()) names.add(records.getJSONObject(i).getString("title"));
        return distinct(name, names);
    }

    private static String uniqueGroup(String name, JSONArray records) throws JSONException {
        Set<String> names = new HashSet<>();
        for (int i = 0; i < records.length(); i++) names.add(records.getJSONObject(i).optString("group"));
        return distinct(name, names);
    }

    private static String distinct(String name, Set<String> names) {
        if (!names.contains(name)) return name;
        for (int i = 2; ; i++) if (!names.contains(name + "（" + i + "）")) return name + "（" + i + "）";
    }

    private static boolean uuid(String value) { return value != null && value.matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}"); }

    private static boolean validBase64(String value) {
        int padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
        int length = value.length() - padding;
        if (length % 4 == 1 || padding > 0 && value.length() % 4 != 0) return false;
        for (int i = 0; i < length; i++) {
            char ch = value.charAt(i);
            if (!(ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '+' || ch == '/')) return false;
        }
        return true;
    }

    static String sha256(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder hex = new StringBuilder(64);
        for (byte value : digest) hex.append(String.format(Locale.ROOT, "%02x", value & 255));
        return hex.toString();
    }

    private static void checkImage(byte[] bytes, String mime) throws StorageException {
        if (bytes.length == 0 || bytes.length > MAX_IMAGE) throw new StorageException("IMAGE_SIZE_LIMIT", "图片超过 4 MiB");
        if (!mime.equals(imageMime(bytes))) throw new StorageException("IMAGE_TYPE_MISMATCH", "图片内容与声明类型不一致");
    }

    private static String imageMime(byte[] bytes) {
        if (bytes.length >= 24 && Arrays.equals(Arrays.copyOfRange(bytes, 0, 8), new byte[]{(byte)137,80,78,71,13,10,26,10})
                && ascii(bytes, 12, 4).equals("IHDR")) return "image/png";
        if (bytes.length >= 4 && (bytes[0]&255) == 255 && (bytes[1]&255) == 216 && (bytes[bytes.length-2]&255) == 255 && (bytes[bytes.length-1]&255) == 217) return "image/jpeg";
        if (bytes.length >= 12 && ascii(bytes, 0, 4).equals("RIFF") && ascii(bytes, 8, 4).equals("WEBP")) return "image/webp";
        if (bytes.length >= 10 && (ascii(bytes, 0, 6).equals("GIF87a") || ascii(bytes, 0, 6).equals("GIF89a"))) return "image/gif";
        return null;
    }

    private static String ascii(byte[] bytes, int start, int length) { return new String(bytes, start, length, StandardCharsets.US_ASCII); }

    private static String mediaMime(String path) {
        String extension = path.substring(path.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        switch (extension) {
            case "png": return "image/png";
            case "jpg": case "jpeg": return "image/jpeg";
            case "gif": return "image/gif";
            case "webp": return "image/webp";
            case "svg": return "image/svg+xml";
            case "woff": return "font/woff";
            case "woff2": return "font/woff2";
            case "ttf": return "font/ttf";
            case "otf": return "font/otf";
            default: return null;
        }
    }

    private static File[] sortedFiles(File root) throws IOException {
        File[] files = root.listFiles();
        if (files == null) throw new IOException("无法读取目录");
        Arrays.sort(files, (a,b) -> a.getName().compareTo(b.getName()));
        return files;
    }

    private static int u16(byte[] bytes, int offset) { return (bytes[offset]&255) | (bytes[offset+1]&255)<<8; }
    private static long u32(byte[] bytes, int offset) { return ((long)u16(bytes, offset)) | ((long)u16(bytes, offset+2)<<16); }
    private static StorageException invalid(String message) { return new StorageException("INVALID_LIBRARY_ARCHIVE", message); }
    private static StorageException limit(String message) { return new StorageException("LIBRARY_ARCHIVE_LIMIT", message); }
}
