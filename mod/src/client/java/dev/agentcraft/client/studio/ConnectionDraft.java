package dev.agentcraft.client.studio;

import com.google.gson.*;
import java.util.*;
import static dev.agentcraft.client.studio.TeamDraft.text;

/** Typed connection fields; never accepts credentials or shell commands. */
public final class ConnectionDraft {
    public final String transport;
    public final String[] keys, labels;
    public final Map<String, String> values = new LinkedHashMap<>();
    private Map<String, String> saved;
    private boolean savedConnection;
    public ConnectionDraft(String transport, JsonObject connection) {
        this.transport = transport;
        switch (transport) {
            case "codex-desktop" -> { keys = new String[]{"threadId", "title", "pipePath"}; labels = new String[]{"ID отдельного чата Codex (UUID)", "Название чата", "Адрес канала Codex (pipePath из подключения)"}; }
            case "codex-cli" -> { keys = new String[]{"workspace", "sessionId", "executable", "sandbox"}; labels = new String[]{"Полный путь к проекту Codex CLI", "ID подключения (новый UUID, отдельный для агента)", "Полный путь к codex.exe (не .cmd)", "Права: read-only или workspace-write"}; }
            case "claude-code" -> { keys = new String[]{"workspace", "sessionId", "executable"}; labels = new String[]{"Полный путь к рабочему пространству Claude", "sessionId из conversation.json этого пространства", "Полный путь к claude.exe (можно оставить пустым)"}; }
            default -> throw new IllegalArgumentException("Неизвестное подключение");
        }
        boolean same = transport.equals(text(connection, "transport"));
        savedConnection = same;
        for (String key : keys) values.put(key, same ? text(connection, key) : "");
        if (transport.equals("codex-cli")) { if (values.get("sessionId").isEmpty()) values.put("sessionId", UUID.randomUUID().toString()); if (values.get("sandbox").isEmpty()) values.put("sandbox", "read-only"); }
        saved = new LinkedHashMap<>(values);
    }
    public boolean dirty() { return !saved.equals(values); }
    public boolean canCheck() { return savedConnection && !dirty(); }
    public void markSaved() { saved = new LinkedHashMap<>(values); savedConnection = true; }
    public JsonObject payload(String id, int revision) {
        JsonObject c = new JsonObject(); c.addProperty("provider", transport.equals("claude-code") ? "claude" : "codex"); c.addProperty("transport", transport);
        for (String key : keys) { String v = values.get(key).strip();
            if (v.isEmpty() && (key.equals("title") || key.equals("executable") && transport.equals("claude-code"))) { if (key.equals("title")) c.addProperty(key, ""); continue; }
            if (v.isEmpty()) throw new IllegalArgumentException("Заполни поле: " + labels[Arrays.asList(keys).indexOf(key)]);
            if (key.equals("threadId") || key.equals("sessionId")) { try { if (!UUID.fromString(v).toString().equalsIgnoreCase(v)) throw new IllegalArgumentException(); } catch (IllegalArgumentException e) { throw new IllegalArgumentException("Нужен полный ID в формате UUID."); } }
            if (key.equals("sandbox") && !v.equals("read-only") && !v.equals("workspace-write")) throw new IllegalArgumentException("Права: read-only или workspace-write.");
            c.addProperty(key, v);
        }
        if (transport.equals("codex-desktop")) c.addProperty("hostId", "local");
        JsonObject out = new JsonObject(); out.addProperty("id", id); out.addProperty("revision", revision); out.add("connection", c); return out;
    }
}
