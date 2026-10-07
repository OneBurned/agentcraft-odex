package dev.agentcraft.client.studio;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.HashSet;
import java.util.Set;

/** Editor data and bounds, independent of Minecraft rendering. Unedited pools keep their exact values. */
public final class PersonaDraft {
    public static final String[] EVENTS = {"task_started", "task_finished", "error", "review_started", "review_pass",
        "review_changes", "question", "pause", "stop", "rest", "dance", "peer"};
    public static final String[] TITLES = {"Характер", "Начало задачи", "Задача завершена", "Ошибка", "Начало ревью", "Ревью принято",
        "Нужны исправления", "Вопрос игроку", "Пауза", "Остановка", "Отдых", "Танец", "Встреча с коллегой"};
    private final JsonObject original;
    private final String[] initial = new String[TITLES.length];
    private final String[] values = new String[TITLES.length];

    public PersonaDraft(JsonObject response) {
        original = response.deepCopy();
        initial[0] = response.get("description").getAsString();
        for (int i = 0; i < EVENTS.length; i++) {
            var phrases = response.getAsJsonObject("events").getAsJsonArray(EVENTS[i]);
            var lines = new java.util.ArrayList<String>();
            phrases.forEach(value -> lines.add(value.getAsString())); initial[i + 1] = String.join("\n", lines);
        }
        System.arraycopy(initial, 0, values, 0, initial.length);
    }
    public String value(int page) { return values[page]; }
    public void set(int page, String value) { values[page] = value; }
    public boolean dirty() { return !java.util.Arrays.equals(initial, values); }
    public int firstInvalidPage() {
        for (int page = 0; page < values.length; page++) {
            try { validate(page); } catch (IllegalArgumentException e) { return page; }
        }
        return -1;
    }
    private void validate(int page) {
        if (page == 0) {
            if (values[0].isBlank() || values[0].strip().length() > 2500) throw new IllegalArgumentException("Характер: от 1 до 2500 символов.");
        } else if (!values[page].equals(initial[page])) phrases(page);
    }
    private JsonArray phrases(int page) {
        String[] lines = values[page].strip().split("\\R", -1);
        String name = TITLES[page] + ": ";
        if (lines.length < 2 || lines.length > 20) throw new IllegalArgumentException(name + "нужно от 2 до 20 фраз, по одной на строку.");
        var result = new JsonArray(); Set<String> seen = new HashSet<>();
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].strip();
            if (line.isEmpty() || line.length() > 160) throw new IllegalArgumentException(name + "строка " + (i + 1) + " — от 1 до 160 символов.");
            if (!seen.add(line)) throw new IllegalArgumentException(name + "строка " + (i + 1) + " повторяется.");
            result.add(line);
        }
        return result;
    }
    public JsonObject payload() {
        for (int i = 0; i < values.length; i++) validate(i);
        var result = new JsonObject();
        result.add("agentId", original.get("agentId")); result.add("revision", original.get("revision"));
        result.addProperty("description", values[0].strip());
        var events = original.getAsJsonObject("events").deepCopy();
        for (int i = 0; i < EVENTS.length; i++) if (!values[i + 1].equals(initial[i + 1])) events.add(EVENTS[i], phrases(i + 1));
        result.add("events", events); return result;
    }

    /** Full editor panel with a scrollable field; fits the minimum normal GUI size (320x240). */
    public record Layout(int x, int width, int fieldY, int fieldHeight, int buttonsY, int statusY) {
        public static Layout at(int screenWidth, int screenHeight) {
            int w = Math.min(600, screenWidth - 24);
            return new Layout((screenWidth - w) / 2, w, 76, Math.max(24, screenHeight - 142), screenHeight - 56, screenHeight - 28);
        }
    }
}
