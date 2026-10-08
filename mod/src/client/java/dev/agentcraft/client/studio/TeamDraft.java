package dev.agentcraft.client.studio;

import com.google.gson.*;
import java.util.*;

/** Pure editor model. Role availability comes from the bridge that will execute the work. */
public final class TeamDraft {
    public static final String[] ROLES = {"planner", "developer", "reviewer"};
    private final JsonArray capabilities;
    private final JsonObject original;
    public String name;
    public String transport;
    public final Set<String> roles = new LinkedHashSet<>();
    public TeamDraft(JsonArray capabilities, JsonObject agent, String transport) {
        this.capabilities = capabilities.deepCopy(); this.original = agent.deepCopy();
        name = text(agent, "name");
        this.transport = transport.isEmpty() ? (text(agent, "provider").equals("claude") ? "claude-code" : "codex-desktop") : transport;
        if (agent.has("roles")) agent.getAsJsonArray("roles").forEach(r -> roles.add(r.getAsString())); else roles.add("developer");
    }
    public static String text(JsonObject o, String key) { return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsString() : ""; }
    public static boolean flag(JsonObject o, String key) { return o.has(key) && o.get(key).getAsBoolean(); }
    public static String roleName(String role) { return switch (role) { case "planner" -> "Планировщик"; case "developer" -> "Разработчик"; case "reviewer" -> "Ревьюер"; default -> role; }; }
    public JsonObject capability() {
        for (var v : capabilities) if (text(v.getAsJsonObject(), "transport").equals(transport)) return v.getAsJsonObject();
        return new JsonObject();
    }
    public String provider() { return text(capability(), "provider"); }
    public boolean supports(String role) { var c = capability(); return c.has("roles") && c.getAsJsonArray("roles").contains(new JsonPrimitive(role)); }
    public String reason(String role) {
        var c = capability(); return c.has("unavailable") ? text(c.getAsJsonObject("unavailable"), role) : "Обнови мост: нет таблицы возможностей.";
    }
    public void nextTransport() {
        if (capabilities.isEmpty()) return;
        int index = -1; for (int i = 0; i < capabilities.size(); i++) if (text(capabilities.get(i).getAsJsonObject(), "transport").equals(transport)) index = i;
        transport = text(capabilities.get((index + 1) % capabilities.size()).getAsJsonObject(), "transport");
        roles.removeIf(r -> !supports(r));
    }
    public JsonObject payload(int revision) {
        if (name.isBlank() || name.strip().length() > 28) throw new IllegalArgumentException("Имя: от 1 до 28 символов.");
        if (provider().isEmpty() || roles.isEmpty()) throw new IllegalArgumentException("Выбери провайдера и хотя бы одну роль.");
        boolean sameRoles = original.has("roles") && new HashSet<>(roles).equals(roleSet(original.getAsJsonArray("roles")));
        for (String r : roles) if (!supports(r) && !(provider().equals(text(original, "provider")) && sameRoles)) throw new IllegalArgumentException(reason(r));
        JsonObject value = new JsonObject(); value.addProperty("name", name.strip()); value.addProperty("provider", provider());
        JsonArray list = new JsonArray(); roles.forEach(list::add); value.add("roles", list);
        JsonObject out = new JsonObject(); out.addProperty("revision", revision);
        if (text(original, "id").isEmpty()) {
            value.addProperty("enabled", false); value.addProperty("visible", true);
            JsonObject look = new JsonObject(); look.addProperty("skin", "marlow"); look.addProperty("color", "#DFC185"); look.addProperty("slim", false); value.add("appearance", look);
            out.add("agent", value);
        } else { out.addProperty("id", text(original, "id")); out.add("patch", value); }
        return out;
    }
    private static Set<String> roleSet(JsonArray list) { Set<String> set = new HashSet<>(); list.forEach(v -> set.add(v.getAsString())); return set; }
    public static List<JsonObject> agents(JsonObject team, boolean archived) {
        List<JsonObject> list = new ArrayList<>();
        for (var v : team.getAsJsonArray("agents")) if (flag(v.getAsJsonObject(), "archived") == archived) list.add(v.getAsJsonObject());
        return list;
    }
    public record Layout(int x, int width, int contentY, int backY, int statusY) {
        public static Layout at(int width, int height) { int w = Math.min(600, width - 24); return new Layout((width - w) / 2, w, 64, height - 54, height - 28); }
    }
}
