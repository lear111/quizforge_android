package cloud.treenewbee.quizforge.android;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

/** Library labels are app-private metadata; bank IDs and extension bindings stay fixed. */
final class RepositoryManagement {
    private final BankRepository repository;
    RepositoryManagement(BankRepository repository) { this.repository = repository; }

    JSONObject catalog() throws Exception {
        JSONObject stored = repository.readCatalog(); normalize(stored);
        JSONArray banks = new JSONArray();
        for (int i = 0; i < stored.getJSONArray("banks").length(); i++) banks.put(BankRepository.descriptor(stored.getJSONArray("banks").getJSONObject(i)));
        return new JSONObject().put("banks", banks).put("groups", stored.getJSONArray("groups"))
                .put("trash", trash(stored)).put("revision", stored.getLong("revision"));
    }

    JSONObject change(JSONObject request) throws Exception {
        fields(request, "kind", "action", "target", "path", "bankId", "name", "group", "expectedRevision");
        if (!"bank".equals(request.optString("kind"))) throw failure("EXTENSION_STRUCTURE_READ_ONLY", "题型拓展按准确路径绑定，不能在应用内改名、移动或删除");
        String action = request.optString("action"), target = request.optString("target");
        if (!Arrays.asList("create", "update", "delete").contains(action) || !Arrays.asList("group", "item").contains(target)) throw invalid("无效的题库管理操作");
        JSONObject catalog = repository.readCatalog(); normalize(catalog);
        if (request.has("expectedRevision") && exactLong(request, "expectedRevision") != catalog.getLong("revision")) throw failure("REVISION_CONFLICT", "题库目录已变化，请刷新后重试");
        String before = fileDigest(repository.catalogFile);
        JSONArray banks = catalog.getJSONArray("banks");
        Set<String> groups = groupNames(catalog);
        Map<File, byte[]> writes = new LinkedHashMap<>();
        Map<File, String> expected = new LinkedHashMap<>();
        expected.put(repository.catalogFile, before);
        JSONObject result = new JSONObject();
        if (target.equals("group")) {
            if (request.has("bankId") || !request.optString("group", "").isEmpty()) throw invalid("分组仅支持一层");
            String source = action.equals("create") ? "" : folder(BankRepository.requiredText(request, "path", 120));
            if (!action.equals("create") && !groups.contains(source)) throw failure("GROUP_NOT_FOUND", "分组不存在，请刷新列表");
            if (action.equals("delete")) {
                JSONArray removed = new JSONArray(), kept = new JSONArray();
                for (int i = 0; i < banks.length(); i++) {
                    JSONObject row = banks.getJSONObject(i);
                    (row.optString("group").equals(source) ? removed : kept).put(row);
                }
                String receipt = archive(catalog, "group", source, removed);
                catalog.put("banks", kept); groups.remove(source);
                result.put("trashId", receipt).put("archivedTo", "回收站/" + receipt).put("removedBanks", removed.length());
            } else {
                String name = folder(BankRepository.requiredText(request, "name", 300).trim());
                if (groupCollision(name, source, groups, banks)) throw failure("GROUP_NAME_CONFLICT", "已有同名题库或分组");
                if (action.equals("create")) {
                    if (groups.size() >= 1000) throw invalid("分组数量已达到上限");
                    groups.add(name);
                } else {
                    groups.remove(source); groups.add(name);
                    for (int i = 0; i < banks.length(); i++) if (banks.getJSONObject(i).optString("group").equals(source)) banks.getJSONObject(i).put("group", name);
                }
                result.put("group", name).put("path", name);
            }
        } else {
            if (action.equals("create")) throw invalid("此入口只创建分组，请导入完整题库包");
            JSONObject row = find(banks, request);
            String bankId = row.getString("id");
            if (action.equals("delete")) {
                JSONArray removed = new JSONArray().put(new JSONObject(row.toString())), kept = new JSONArray();
                for (int i = 0; i < banks.length(); i++) if (!banks.getJSONObject(i).getString("id").equals(bankId)) kept.put(banks.getJSONObject(i));
                String receipt = archive(catalog, "item", row.getString("title"), removed);
                catalog.put("banks", kept);
                result.put("bankId", bankId).put("trashId", receipt).put("archivedTo", "回收站/" + receipt).put("removedBanks", 1);
            } else {
                String name = folder(request.has("name") ? BankRepository.requiredText(request, "name", 300).trim() : row.getString("title"));
                String group = request.has("group") ? string(request, "group") : row.optString("group");
                if (!group.isEmpty() && !groups.contains(group)) throw failure("GROUP_NOT_FOUND", "请选择已有分组");
                requireAvailable(name, group, bankId, banks, groups);
                if (!name.equals(row.getString("title"))) {
                    File source = source(row);
                    byte[] raw = BankRepository.readBytes(source, BankRepository.MAX_FILE);
                    JSONObject bank = new JSONObject(new String(raw, StandardCharsets.UTF_8)); bank.put("title", name);
                    writes.put(source, json(bank)); expected.put(source, BankRepository.sha256(raw));
                }
                row.put("title", name).put("group", group);
                result.put("bankId", bankId).put("bank", BankRepository.descriptor(row)).put("path", (group.isEmpty() ? "" : group + "/") + name);
            }
        }
        catalog.put("groups", new JSONArray(new TreeSet<>(groups))).put("revision", catalog.getLong("revision") + 1);
        writes.put(repository.catalogFile, json(catalog));
        repository.transactions.commit(writes, expected);
        return result.put("revision", catalog.getLong("revision")).put("catalog", catalog());
    }

    JSONArray listTrash() throws Exception { return trash(repository.readCatalog()); }

    JSONObject restore(String id) throws Exception {
        if (id == null || !id.matches("[a-f0-9-]{36}")) throw invalid("回收记录标识无效");
        JSONObject catalog = repository.readCatalog(); normalize(catalog);
        JSONArray archived = catalog.getJSONArray("trash"), remaining = new JSONArray();
        JSONObject receipt = null;
        for (int i = 0; i < archived.length(); i++) {
            JSONObject row = archived.getJSONObject(i);
            if (row.getString("id").equals(id)) receipt = row; else remaining.put(row);
        }
        if (receipt == null) throw failure("TRASH_NOT_FOUND", "回收记录不存在");
        Map<File, byte[]> writes = new LinkedHashMap<>();
        Map<File, String> expected = new LinkedHashMap<>(); expected.put(repository.catalogFile, fileDigest(repository.catalogFile));
        JSONArray banks = catalog.getJSONArray("banks"), restored = new JSONArray();
        Set<String> groups = groupNames(catalog);
        String restoredGroup = receipt.optString("group");
        if (receipt.getString("target").equals("group")) {
            restoredGroup = uniqueGroup(receipt.getString("name"), groups, banks);
            groups.add(restoredGroup);
        }
        JSONArray records = receipt.getJSONArray("records");
        for (int i = 0; i < records.length(); i++) {
            JSONObject row = new JSONObject(records.getJSONObject(i).toString());
            for (int j = 0; j < banks.length(); j++) if (banks.getJSONObject(j).getString("id").equals(row.getString("id"))) throw failure("TRASH_CONFLICT", "回收题库的本地标识已被占用");
            // Verify source is present before exposing the bank again. Practice and
            // frozen history were never removed or rewritten by deletion.
            source(row);
            String group = receipt.getString("target").equals("group") ? restoredGroup : row.optString("group");
            if (!group.isEmpty()) {
                if (!groups.contains(group) && groupCollision(group, "", groups, banks)) group = uniqueGroup(group, groups, banks);
                groups.add(group);
            }
            String oldName = row.getString("title"), name = uniqueBank(oldName, group, banks, groups);
            if (!name.equals(oldName)) {
                File source = source(row); byte[] before = BankRepository.readBytes(source, BankRepository.MAX_FILE);
                JSONObject bank = new JSONObject(new String(before, StandardCharsets.UTF_8)).put("title", name);
                writes.put(source, json(bank)); expected.put(source, BankRepository.sha256(before));
            }
            row.put("group", group).put("title", name); banks.put(row); restored.put(BankRepository.descriptor(row));
        }
        catalog.put("groups", new JSONArray(new TreeSet<>(groups))).put("trash", remaining).put("revision", catalog.getLong("revision") + 1);
        writes.put(repository.catalogFile, json(catalog)); repository.transactions.commit(writes, expected);
        return new JSONObject().put("restored", restored).put("group", restoredGroup).put("catalog", catalog());
    }

    void normalize(JSONObject catalog) throws Exception {
        Set<String> groups = groupNames(catalog);
        JSONArray banks = catalog.getJSONArray("banks");
        for (int i = 0; i < banks.length(); i++) if (!banks.getJSONObject(i).optString("group").isEmpty()) groups.add(banks.getJSONObject(i).getString("group"));
        catalog.put("groups", new JSONArray(new TreeSet<>(groups)));
    }

    private String archive(JSONObject catalog, String target, String name, JSONArray records) throws Exception {
        JSONArray trash = catalog.getJSONArray("trash");
        if (trash.length() >= 2000) throw failure("TRASH_LIMIT", "回收记录达到上限，原题库未删除");
        String id = UUID.randomUUID().toString();
        String group = target.equals("group") ? name : records.getJSONObject(0).optString("group");
        trash.put(new JSONObject().put("id", id).put("target", target).put("name", name).put("group", group)
                .put("deletedAt", System.currentTimeMillis()).put("records", records));
        return id;
    }

    private static JSONArray trash(JSONObject catalog) throws Exception {
        JSONArray result = new JSONArray(), rows = catalog.getJSONArray("trash");
        for (int i = rows.length() - 1; i >= 0; i--) {
            JSONObject row = rows.getJSONObject(i);
            result.put(new JSONObject().put("id", row.getString("id")).put("target", row.getString("target"))
                    .put("name", row.getString("name")).put("group", row.optString("group"))
                    .put("deletedAt", row.getLong("deletedAt")).put("bankCount", row.getJSONArray("records").length()));
        }
        return result;
    }

    private JSONObject find(JSONArray banks, JSONObject request) throws Exception {
        String id = request.has("bankId") ? string(request, "bankId") : null;
        String path = request.has("path") ? string(request, "path") : null;
        if (id == null && path == null) throw invalid("需要题库本地标识或目录路径");
        for (int i = 0; i < banks.length(); i++) {
            JSONObject row = banks.getJSONObject(i);
            if (id != null ? row.getString("id").equals(id) : BankRepository.descriptor(row).getString("path").equals(path)) return row;
        }
        throw failure("BANK_NOT_FOUND", "题库不存在，请刷新列表");
    }

    private File source(JSONObject record) throws Exception {
        File file = BankRepository.safeFile(repository.importRoot(record), record.getString("bankPath"));
        if (!file.isFile()) throw failure("BANK_UNAVAILABLE", "题库源文件缺失，现有记录已保留");
        return file;
    }

    private static Set<String> groupNames(JSONObject catalog) throws Exception {
        Set<String> result = new HashSet<>(); JSONArray groups = catalog.getJSONArray("groups");
        for (int i = 0; i < groups.length(); i++) result.add(folder(groups.getString(i)));
        return result;
    }

    private static void requireAvailable(String name, String group, String exceptId, JSONArray banks, Set<String> groups) throws Exception {
        for (int i = 0; i < banks.length(); i++) {
            JSONObject row = banks.getJSONObject(i);
            if (!row.getString("id").equals(exceptId) && row.optString("group").equals(group) && row.getString("title").equalsIgnoreCase(name)) throw failure("BANK_NAME_CONFLICT", "目标分组内已有同名题库");
        }
        if (group.isEmpty()) for (String item : groups) if (item.equalsIgnoreCase(name)) throw failure("BANK_NAME_CONFLICT", "根目录已有同名分组");
    }

    private static boolean groupCollision(String name, String source, Set<String> groups, JSONArray banks) throws Exception {
        for (String group : groups) if (!group.equals(source) && group.equalsIgnoreCase(name)) return true;
        for (int i = 0; i < banks.length(); i++) if (banks.getJSONObject(i).optString("group").isEmpty() && banks.getJSONObject(i).getString("title").equalsIgnoreCase(name)) return true;
        return false;
    }

    private static String uniqueGroup(String name, Set<String> groups, JSONArray banks) throws Exception {
        String value = name; int suffix = 2;
        while (groupCollision(value, "", groups, banks)) value = name.substring(0, Math.min(105, name.length())) + "（" + suffix++ + "）";
        return value;
    }
    private static String uniqueBank(String name, String group, JSONArray banks, Set<String> groups) throws Exception {
        String value = name; int suffix = 2;
        while (true) {
            try { requireAvailable(value, group, "", banks, groups); return value; }
            catch (StorageException collision) { value = name.substring(0, Math.min(105, name.length())) + "（" + suffix++ + "）"; }
        }
    }

    static String folder(String name) throws Exception {
        BankRepository.validSegment(name);
        if (name.length() > 120 || name.startsWith(".") || Arrays.asList("bank.json", "manifest.json", "development.json").contains(name.toLowerCase(Locale.ROOT))) throw invalid("题库或分组名称无效");
        return name;
    }
    static String fileDigest(File file) throws Exception { return file.exists() ? BankRepository.sha256(BankRepository.readBytes(file, 40 * 1024 * 1024)) : "absent"; }
    static byte[] json(JSONObject value) { return value.toString().getBytes(StandardCharsets.UTF_8); }
    static String string(JSONObject value, String field) throws Exception { Object raw = value.opt(field); if (!(raw instanceof String)) throw invalid("无效字段：" + field); return (String) raw; }
    static long exactLong(JSONObject value, String field) throws Exception {
        Object raw = value.opt(field);
        if (!(raw instanceof Number) || !Double.isFinite(((Number)raw).doubleValue()) || ((Number)raw).doubleValue() != ((Number)raw).longValue() || ((Number)raw).longValue() < 0) throw invalid("需要非负整数：" + field);
        return ((Number) raw).longValue();
    }
    static void fields(JSONObject request, String... allowed) throws Exception {
        if (request == null) throw invalid("操作参数需要对象");
        List<String> keys = Arrays.asList(allowed); Iterator<String> actual = request.keys();
        while (actual.hasNext()) { String key = actual.next(); if (!keys.contains(key)) throw invalid("未知操作字段：" + key); }
    }
    private static StorageException invalid(String message) { return failure("INVALID_REQUEST", message); }
    private static StorageException failure(String code, String message) { return new StorageException(code, message); }
}
