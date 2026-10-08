package dev.agentcraft.client.studio;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class PersonaDraftTest {
    private JsonObject profile(String id) {
        var p = new JsonObject(); p.addProperty("agentId", id); p.addProperty("revision", "revision-value"); p.addProperty("description", "Исходный характер");
        var events = new JsonObject();
        for (String event : PersonaDraft.EVENTS) {
            var phrases = new JsonArray(); phrases.add("Первая реплика"); phrases.add("Вторая реплика"); events.add(event, phrases);
        }
        p.add("events", events); return p;
    }
    @Test public void editsAllAgentsWithoutDroppingOtherEventPoolsOrTheRevision() {
        for (String agent : new String[]{"marlow", "wren", "agent_third"}) {
            var source = profile(agent); var draft = new PersonaDraft(source);
            assertFalse(draft.dirty()); draft.set(0, "Новый\nхарактер"); draft.set(1, " Первый вариант \n Второй вариант \n");
            assertTrue(draft.dirty()); assertEquals(-1, draft.firstInvalidPage());
            var sent = draft.payload(); assertEquals(agent, sent.get("agentId").getAsString());
            assertEquals("revision-value", sent.get("revision").getAsString());
            assertEquals("Новый\nхарактер", sent.get("description").getAsString());
            assertEquals("Первый вариант", sent.getAsJsonObject("events").getAsJsonArray("task_started").get(0).getAsString());
            assertEquals(source.getAsJsonObject("events").get("rest"), sent.getAsJsonObject("events").get("rest"));
            assertEquals("Исходный характер", source.get("description").getAsString());
        }
    }
    @Test public void reportsTheInvalidPageAndRetainsInvalidInputForCorrection() {
        var draft = new PersonaDraft(profile("wren"));
        for (String invalid : new String[]{"Одна фраза", "Повтор\n Повтор ", "Первая\n\nТретья", "д".repeat(161) + "\nВторая", ""}) {
            draft.set(4, invalid); assertEquals(4, draft.firstInvalidPage());
            assertThrows(IllegalArgumentException.class, draft::payload); assertEquals(invalid, draft.value(4));
        }
        draft.set(4, "Один\nДва"); draft.set(0, " "); assertEquals(0, draft.firstInvalidPage());
        draft.set(0, "x".repeat(2501)); assertThrows(IllegalArgumentException.class, draft::payload);
    }
    @Test public void enforcesPhraseCountAndAcceptsBoundaryLengths() {
        var draft = new PersonaDraft(profile("marlow"));
        String twenty = java.util.stream.IntStream.range(0, 20).mapToObj(i -> i + " " + "я".repeat(157)).collect(java.util.stream.Collectors.joining("\n"));
        draft.set(0, "я".repeat(2500)); draft.set(12, twenty);
        assertEquals(20, draft.payload().getAsJsonObject("events").getAsJsonArray("peer").size());
        draft.set(12, twenty + "\nЕщё одна"); assertThrows(IllegalArgumentException.class, draft::payload);
    }
    @Test public void uneditedMultilineLegacyPhrasesAreNotSplitByOpeningTheEditor() {
        var source = profile("marlow"); var phrases = new JsonArray(); phrases.add("Первая\nчасть"); phrases.add("Вторая");
        source.getAsJsonObject("events").add("rest", phrases);
        var draft = new PersonaDraft(source); draft.set(0, "Изменено только описание");
        assertEquals(phrases, draft.payload().getAsJsonObject("events").get("rest"));
    }
    @Test public void fieldAndFooterFitNormalGuiSizesWithoutOverlap() {
        for (int[] size : new int[][]{{320,240}, {427,240}, {480,270}, {640,360}, {960,540}}) {
            var l = PersonaDraft.Layout.at(size[0], size[1]);
            assertTrue(l.x() >= 0); assertTrue(l.x() + l.width() <= size[0]);
            assertTrue(l.fieldY() > 61 + 9); assertTrue(l.fieldHeight() >= 24);
            assertTrue(l.fieldY() + l.fieldHeight() <= l.buttonsY() - 4);
            assertTrue(l.buttonsY() + 20 <= l.statusY()); assertTrue(l.statusY() + 20 <= size[1]);
        }
    }
}
