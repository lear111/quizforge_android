package cloud.treenewbee.quizforge.android;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Controlled question authoring; private source and current state commit together. */
final class RepositoryEditor {
    private final BankRepository repository;
    private final byte[] versionKey;
    private final Map<String, String> extensionFingerprints = new HashMap<>();
    RepositoryEditor(BankRepository repository) throws Exception {
        this.repository = repository;
        File file = new File(repository.getDataRoot(), "version-key.bin");
        if (file.exists()) {
            versionKey = BankRepository.readBytes(file, 32);
            if (versionKey.length != 32) throw failure("VERSION_KEY_UNAVAILABLE", "内容版本密钥异常，原记录已保留");
        } else {
            versionKey = new byte[32]; new SecureRandom().nextBytes(versionKey); BankRepository.atomicWrite(file, versionKey);
        }
    }

    JSONObject versions(JSONObject record, JSONObject bank) throws Exception {
        JSONObject questions = new JSONObject(); JSONArray rows = bank.getJSONArray("questions");
        for (int i = 0; i < rows.length(); i++) {
            JSONObject question = rows.getJSONObject(i);
            String value = version(record, bank, question);
            questions.put(question.getString("id"), new JSONObject().put("contentVersion", value).put("draftVersion", value));
        }
        return new JSONObject().put("sourceVersion", sourceVersion(record, BankRepository.readBytes(source(record), BankRepository.MAX_FILE))).put("questionVersions", questions);
    }

    JSONObject read(String bankId, String questionId) throws Exception {
        JSONObject record = editable(bankId), bank = bank(record), question = question(bank, questionId);
        JSONObject extension = BankRepository.readExtensionFromRoot(repository.importRoot(record), BankRepository.extensionReference(question, bank));
        String version = version(record, bank, question);
        JSONObject state = repository.readState(bankId);
        JSONObject current = state == null || state.optJSONObject("questions") == null ? null : state.getJSONObject("questions").optJSONObject(questionId);
        return new JSONObject().put("bankId", bankId).put("questionId", questionId).put("question", copy(question))
                .put("contentVersion", version).put("draftVersion", version).put("sourceVersion", sourceVersion(record, BankRepository.readBytes(source(record), BankRepository.MAX_FILE)))
                .put("revision", current == null ? 0 : current.optLong("revision", 0))
                .put("stateRevision", state == null ? 0 : state.getLong("revision"))
                .put("extension", new JSONObject().put("path", extension.getString("path")).put("id", extension.getJSONObject("manifest").getString("id"))
                        .put("version", extension.getJSONObject("manifest").getString("version")).put("name", extension.getJSONObject("manifest").getString("name")))
                .put("questionSchema", extension.get("questionSchema")).put("answerSchema", extension.get("answerSchema"))
                .put("editor", extension.opt("editor")).put("editorDraft", getDraft(bankId, questionId));
    }

    JSONObject save(String bankId, String questionId, JSONObject request) throws Exception {
        JSONObject record = editable(bankId);
        RepositoryManagement.fields(request, "requestId", "revision", "contentVersion", "sourceVersion", "question", "title", "data");
        String requestId = BankRepository.requiredText(request, "requestId", 120);
        if (!requestId.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,119}")) throw invalid("编辑请求标识无效");
        String requestHash = digest(canonical(request));
        File receiptsFile = new File(repository.getDataRoot(), "editor-receipts/" + bankId + ".json");
        JSONObject receipts = receipts(receiptsFile); JSONArray entries = receipts.getJSONArray("entries");
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.getJSONObject(i);
            if (!entry.getString("id").equals(requestId)) continue;
            if (!entry.getString("questionId").equals(questionId) || !entry.getString("requestHash").equals(requestHash)) throw failure("REQUEST_ID_REUSED", "同一编辑请求标识不能用于不同内容");
            return copy(entry.getJSONObject("response")).put("replayed", true);
        }
        String expectedVersion = hash(request, "contentVersion");
        long expectedRevision = RepositoryManagement.exactLong(request, "revision");
        File source = source(record);
        byte[] before = BankRepository.readBytes(source, BankRepository.MAX_FILE);
        String beforeDigest = BankRepository.sha256(before), previousSourceVersion = sourceVersion(record, before);
        JSONObject bank = new JSONObject(new String(before, StandardCharsets.UTF_8)), oldQuestion = question(bank, questionId);
        String currentVersion = version(record, bank, oldQuestion);
        if (!expectedVersion.equals(currentVersion) || request.has("sourceVersion") && !hash(request, "sourceVersion").equals(previousSourceVersion))
            throw failure("CONTENT_CONFLICT", "题目或同题库内容已变化，请重新打开编辑器；当前输入未覆盖");
        JSONObject supplied;
        if (request.has("question")) {
            if (request.has("title") || request.has("data")) throw invalid("编辑请求不能混用整题和独立题目字段");
            supplied = request.optJSONObject("question");
            if (supplied == null) throw invalid("编辑内容需要题目对象");
            RepositoryManagement.fields(supplied, "id", "title", "data", "extension", "outline");
            if (!questionId.equals(supplied.optString("id"))) throw invalid("编辑不能修改题目 ID");
            for (String field : new String[]{"extension", "outline"}) if (supplied.has(field) && !equal(supplied.get(field), oldQuestion.opt(field)))
                throw invalid("普通题目编辑不能修改题型绑定或目录 ID");
        } else {
            supplied = new JSONObject().put("id", questionId).put("title", request.opt("title"));
            if (request.has("data")) supplied.put("data", request.get("data"));
        }
        String title = BankRepository.requiredText(supplied, "title", 300);
        if (!supplied.has("data")) throw invalid("编辑内容缺少题目 data");
        JSONObject nextQuestion = copy(oldQuestion).put("title", title).put("data", supplied.get("data"));
        JSONObject extension = BankRepository.readExtensionFromRoot(repository.importRoot(record), BankRepository.extensionReference(oldQuestion, bank));
        repository.validateEditedData(extension, supplied.get("data"));
        imageReferences(bankId, supplied.get("data"), 0);
        boolean dataChanged = !equal(oldQuestion.get("data"), supplied.get("data"));
        boolean changed = dataChanged || !oldQuestion.getString("title").equals(title);

        JSONObject state = repository.readState(bankId);
        boolean persistent = record.getJSONObject("features").optBoolean("history", true);
        JSONObject oldCurrent = state == null || state.optJSONObject("questions") == null ? null : state.getJSONObject("questions").optJSONObject(questionId);
        long actualRevision = oldCurrent == null ? 0 : oldCurrent.optLong("revision", 0);
        if (persistent && expectedRevision != actualRevision) throw failure("REVISION_CONFLICT", "本题作答已变化，请重新打开编辑器；当前输入未覆盖");
        if (actualRevision == Long.MAX_VALUE) throw invalid("题目保存版本达到上限");
        JSONObject nextState = persistent ? (state == null ? freshState() : copy(state)) : null;
        long nextQuestionRevision = persistent ? actualRevision + 1 : 0;
        if (nextState != null) {
            JSONObject questions = nextState.optJSONObject("questions");
            if (questions == null) throw failure("STATE_CORRUPT", "当前练习记录异常，原文件已保留");
            JSONObject current = oldCurrent == null ? new JSONObject().put("status", "unanswered").put("answer", JSONObject.NULL).put("result", JSONObject.NULL) : copy(oldCurrent);
            if (dataChanged) {
                current = new JSONObject().put("status", "unanswered").put("answer", JSONObject.NULL).put("result", JSONObject.NULL);
                JSONObject ink = nextState.optJSONObject("ink"); if (ink != null) ink.remove(questionId);
                if (nextState.optBoolean("finished")) nextState.put("roundId", UUID.randomUUID().toString());
                nextState.put("finished", false);
            }
            current.put("revision", nextQuestionRevision); questions.put(questionId, current);
            long stateRevision = state == null ? 0 : state.getLong("revision");
            if (stateRevision == Long.MAX_VALUE) throw invalid("练习记录版本达到上限");
            nextState.put("revision", stateRevision + 1);
        }
        JSONArray questions = bank.getJSONArray("questions");
        for (int i = 0; i < questions.length(); i++) if (questions.getJSONObject(i).getString("id").equals(questionId)) questions.put(i, nextQuestion);
        byte[] after = RepositoryManagement.json(bank);
        if (after.length > BankRepository.MAX_FILE) throw failure("BANK_SIZE_LIMIT", "编辑后的题库超过 8 MiB，原文件已保留");
        String nextVersion = version(record, bank, nextQuestion), sourceVersion = sourceVersion(record, after);
        JSONObject response = new JSONObject().put("saved", true).put("bankId", bankId).put("questionId", questionId)
                .put("previousSourceVersion", previousSourceVersion).put("sourceVersion", sourceVersion)
                .put("contentVersion", nextVersion).put("draftVersion", nextVersion).put("revision", nextQuestionRevision)
                .put("stateRevision", nextState == null ? 0 : nextState.getLong("revision"))
                .put("changed", changed).put("dataChanged", dataChanged).put("replayed", false);
        entries.put(new JSONObject().put("id", requestId).put("questionId", questionId).put("requestHash", requestHash).put("response", response));
        while (entries.length() > 200) entries.remove(0);
        Map<File, byte[]> writes = new LinkedHashMap<>(); Map<File, String> expected = new LinkedHashMap<>();
        writes.put(source, after); expected.put(source, beforeDigest);
        if (nextState != null) {
            File stateFile = new File(repository.stateRoot, bankId + ".json");
            writes.put(stateFile, RepositoryManagement.json(nextState)); expected.put(stateFile, RepositoryManagement.fileDigest(stateFile));
        }
        writes.put(receiptsFile, RepositoryManagement.json(receipts)); expected.put(receiptsFile, RepositoryManagement.fileDigest(receiptsFile));
        File draft = draftFile(bankId, questionId); if (draft.exists()) writes.put(draft, null);
        if (dataChanged) {
            JSONObject backup = new JSONObject().put("schemaVersion", 1).put("bankId", bankId).put("questionId", questionId)
                    .put("requestId", requestId).put("createdAt", System.currentTimeMillis()).put("question", oldQuestion)
                    .put("current", oldCurrent == null ? JSONObject.NULL : oldCurrent)
                    .put("ink", state == null || state.optJSONObject("ink") == null ? JSONObject.NULL : state.getJSONObject("ink").opt(questionId))
                    .put("roundId", state == null ? JSONObject.NULL : state.opt("roundId"));
            writes.put(new File(repository.getDataRoot(), "edit-backups/" + digest(bankId + ":" + requestId) + ".json"), RepositoryManagement.json(backup));
        }
        repository.transactions.commit(writes, expected);
        return response;
    }

    JSONObject getDraft(String bankId, String questionId) throws Exception {
        JSONObject record = editable(bankId), bank = bank(record), question = question(bank, questionId);
        String version = version(record, bank, question);
        JSONObject empty = new JSONObject().put("draft", JSONObject.NULL).put("changed", false).put("contentVersion", version);
        if (!record.getJSONObject("features").optBoolean("history", true)) return empty.put("memoryOnly", true);
        File file = draftFile(bankId, questionId);
        if (!file.exists() && !new File(file.getPath() + ".bak").exists()) return empty;
        JSONObject stored = BankRepository.readAtomicJson(file, 1024 * 1024);
        if (stored.optInt("schemaVersion") != 1 || !stored.optString("bankId").equals(bankId) || !stored.optString("questionId").equals(questionId))
            throw failure("EDITOR_DRAFT_UNAVAILABLE", "编辑草稿记录异常，原文件已保留");
        validateDraft(stored, false);
        return new JSONObject().put("draft", stored.get("draft")).put("changed", stored.getBoolean("changed")).put("contentVersion", stored.getString("contentVersion"));
    }

    JSONObject putDraft(String bankId, String questionId, JSONObject request) throws Exception {
        JSONObject record = editable(bankId); question(bank(record), questionId);
        validateDraft(request, true);
        if (!record.getJSONObject("features").optBoolean("history", true)) return new JSONObject().put("saved", false).put("memoryOnly", true);
        JSONObject stored = copy(request).put("schemaVersion", 1).put("bankId", bankId).put("questionId", questionId);
        byte[] bytes = RepositoryManagement.json(stored);
        if (bytes.length > 1024 * 1024) throw failure("EDITOR_DRAFT_SIZE_LIMIT", "编辑草稿超过 1 MiB，当前输入请保留在页面中");
        BankRepository.atomicWrite(draftFile(bankId, questionId), bytes);
        return new JSONObject().put("saved", true);
    }

    JSONObject deleteDraft(String bankId, String questionId) throws Exception {
        editable(bankId); question(bank(repository.record(bankId)), questionId);
        File file = draftFile(bankId, questionId);
        if (new File(file.getPath() + ".bak").exists()) getDraft(bankId, questionId);
        boolean present = file.exists();
        if (present) { Map<File, byte[]> changes = new LinkedHashMap<>(); changes.put(file, null); repository.transactions.commit(changes); }
        return new JSONObject().put("deleted", present);
    }

    private JSONObject editable(String bankId) throws Exception {
        JSONObject record = repository.record(bankId);
        if (!record.getJSONObject("features").optBoolean("editing", true)) throw failure("EDITING_DISABLED", "此题库已关闭编辑");
        return record;
    }
    private JSONObject bank(JSONObject record) throws Exception { return BankRepository.readJson(source(record), BankRepository.MAX_FILE); }
    private File source(JSONObject record) throws Exception { return BankRepository.safeFile(repository.importRoot(record), record.getString("bankPath")); }
    private static JSONObject question(JSONObject bank, String id) throws Exception {
        if (id == null || !id.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,119}")) throw invalid("题目 ID 无效");
        JSONArray questions = bank.getJSONArray("questions");
        for (int i = 0; i < questions.length(); i++) if (questions.getJSONObject(i).getString("id").equals(id)) return questions.getJSONObject(i);
        throw failure("QUESTION_NOT_FOUND", "题目不存在");
    }
    private String version(JSONObject record, JSONObject bank, JSONObject question) throws Exception {
        String path = BankRepository.extensionReference(question, bank), key = record.getString("importId") + "|" + path;
        String fingerprint = extensionFingerprints.get(key);
        if (fingerprint == null) {
            JSONObject extension = BankRepository.readExtensionFromRoot(repository.importRoot(record), path);
            extension.remove("examples"); extension.remove("editor");
            fingerprint = digest(canonical(extension)); extensionFingerprints.put(key, fingerprint);
        }
        return opaque("question:" + record.getString("id") + ":" + canonical(question) + ":" + fingerprint);
    }
    private String sourceVersion(JSONObject record, byte[] source) throws Exception {
        return opaque("bank:" + record.getString("id") + ":" + BankRepository.sha256(source));
    }
    private String opaque(String input) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(versionKey, "HmacSHA256"));
        byte[] bytes = mac.doFinal(input.getBytes(StandardCharsets.UTF_8));
        StringBuilder value = new StringBuilder(64); for (byte item : bytes) value.append(String.format(java.util.Locale.ROOT, "%02x", item & 255));
        return value.toString();
    }
    private File draftFile(String bankId, String questionId) throws Exception { return new File(repository.getDataRoot(), "editor-drafts/" + digest(bankId + ":" + questionId) + ".json"); }
    private static JSONObject receipts(File file) throws Exception {
        if (!file.exists() && !new File(file.getPath() + ".bak").exists()) return new JSONObject().put("schemaVersion", 1).put("entries", new JSONArray());
        JSONObject stored = BankRepository.readAtomicJson(file, 2 * 1024 * 1024);
        if (stored.optInt("schemaVersion") != 1 || stored.optJSONArray("entries") == null || stored.getJSONArray("entries").length() > 200)
            throw failure("EDITOR_RECEIPTS_UNAVAILABLE", "编辑请求记录异常，原文件已保留");
        return stored;
    }
    private static void validateDraft(JSONObject request, boolean strict) throws Exception {
        if (strict) RepositoryManagement.fields(request, "contentVersion", "draft", "changed");
        hash(request, "contentVersion");
        if (request.optJSONObject("draft") == null || !(request.opt("changed") instanceof Boolean)) throw invalid("编辑草稿需要 draft 对象和 changed 布尔值");
    }
    private void imageReferences(String bankId, Object value, int depth) throws Exception {
        if (depth > 128) throw invalid("题目嵌套过深");
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            if (object.optString("type").equals("image") && object.optJSONObject("attrs") != null && object.getJSONObject("attrs").has("assetId"))
                repository.getResource(bankId, object.getJSONObject("attrs").getString("assetId"));
            Iterator<String> keys = object.keys(); while (keys.hasNext()) imageReferences(bankId, object.get(keys.next()), depth + 1);
        } else if (value instanceof JSONArray) { JSONArray array = (JSONArray)value; for (int i = 0; i < array.length(); i++) imageReferences(bankId, array.get(i), depth + 1); }
    }
    static String canonical(Object value) throws Exception {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject)value; List<String> keys = new ArrayList<>(); Iterator<String> iterator = object.keys(); while (iterator.hasNext()) keys.add(iterator.next()); Collections.sort(keys);
            StringBuilder result = new StringBuilder("{"); for (String key : keys) { if (result.length() > 1) result.append(','); result.append(JSONObject.quote(key)).append(':').append(canonical(object.get(key))); } return result.append('}').toString();
        }
        if (value instanceof JSONArray) { JSONArray array = (JSONArray)value; StringBuilder result = new StringBuilder("["); for (int i = 0; i < array.length(); i++) { if (i > 0) result.append(','); result.append(canonical(array.get(i))); } return result.append(']').toString(); }
        if (value instanceof String) return JSONObject.quote((String)value);
        if (value instanceof Number) return JSONObject.numberToString((Number)value);
        return String.valueOf(value);
    }
    private static boolean equal(Object left, Object right) throws Exception { return canonical(left).equals(canonical(right)); }
    private static JSONObject copy(JSONObject value) throws Exception { return new JSONObject(value.toString()); }
    private static String digest(String value) throws Exception { return BankRepository.sha256(value.getBytes(StandardCharsets.UTF_8)); }
    private static String hash(JSONObject request, String field) throws Exception { String value = RepositoryManagement.string(request, field); if (!value.matches("[a-f0-9]{64}")) throw invalid("版本校验值无效：" + field); return value; }
    private static JSONObject freshState() throws Exception { return new JSONObject().put("schemaVersion", 1).put("revision", 0).put("roundId", UUID.randomUUID().toString()).put("questions", new JSONObject()).put("ink", new JSONObject()).put("history", new JSONArray()).put("finished", false); }
    private static StorageException invalid(String message) { return failure("INVALID_REQUEST", message); }
    private static StorageException failure(String code, String message) { return new StorageException(code, message); }
}
