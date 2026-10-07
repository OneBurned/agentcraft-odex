package dev.agentcraft.client.foreman;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.agentcraft.client.diff.ReviewStationCard;
import dev.agentcraft.client.diff.ReviewStationCard.Kind;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public class ReviewStationCardTest {
    private ForemanState state() {
        var s = new ForemanState(new LinkStatus(LinkStatus.Phase.SYNCED, "test", 0, null, 0, 0, true));
        s.inject("snapshot", JsonParser.parseString("{\"tasks\":[]}").getAsJsonObject());
        return s;
    }
    private JsonObject task(String id, String phase, String verdict, long start) {
        var t = new JsonObject(); t.addProperty("id", id); t.addProperty("title", "Проверка кириллицы");
        if (phase != null) {
            var r = new JsonObject(); r.addProperty("head", "123456789abcdef"); r.addProperty("phase", phase);
            r.addProperty("startedAt", start); r.addProperty("step", "Читаю\n файл");
            r.addProperty("summary", "Краткое замечание");
            if (verdict != null) r.addProperty("verdict", verdict);
            r.addProperty("waitingForUser", "question".equals(verdict)); t.add("studioReview", r);
        }
        return t;
    }
    private void upsert(ForemanState s, JsonObject task) {
        var msg = new JsonObject(); msg.add("task", task); s.inject("task.upsert", msg);
    }
    private ReviewStationCard card(ForemanState s, int index) {
        return ReviewStationCard.select(s.tasks().values(), List.of(), index);
    }

    @Test public void legacySnapshotWithoutReviewShowsAllClearOnlyAtFirstStation() {
        var s = state(); upsert(s, task("t1", null, null, 0));
        assertNull(s.task("t1").studioReview());
        assertEquals(Kind.EMPTY, card(s, 0).kind());
        assertEquals(Kind.HIDDEN, card(s, 1).kind());
        assertEquals(Kind.HIDDEN, card(s, -1).kind());
    }

    @Test public void realSnapshotAndUpdatesReplaceStepAndVerdict() {
        var s = state();
        var tasks = new com.google.gson.JsonArray(); tasks.add(task("t35", "running", null, 100));
        var snap = new JsonObject(); snap.add("tasks", tasks); s.inject("snapshot", snap);
        var card = card(s, 0);
        assertEquals(Kind.REVIEW, card.kind());
        assertEquals("t35", card.task().id()); assertEquals("Проверка кириллицы", card.task().title());
        assertEquals("123456789abcdef", card.task().studioReview().head());
        assertEquals("Идёт ревью", card.status(false)); assertEquals("Читаю файл", card.detail());
        assertEquals("Нет связи", card.status(true));
        for (String verdict : List.of("pass", "changes", "question")) {
            upsert(s, task("t35", "finished", verdict, 100)); card = card(s, 0);
            assertEquals(verdict, card.status(false)); assertEquals("Краткое замечание", card.detail());
            assertEquals("question".equals(verdict), card.task().studioReview().waitingForUser());
        }
    }

    @Test public void newAttemptWinsWithoutBeingOvertakenByUnrelatedTaskEdits() {
        var s = state(); upsert(s, task("t1", "finished", "changes", 100));
        upsert(s, task("t2", "running", null, 200)); assertEquals("t2", card(s, 0).task().id());
        var old = task("t1", "finished", "pass", 100); old.addProperty("updatedAt", 999999);
        upsert(s, old); assertEquals("t2", card(s, 0).task().id());
        upsert(s, task("t2", "finished", "pass", 200)); assertEquals("t2", card(s, 0).task().id());
        upsert(s, task("t1", "running", null, 300)); assertEquals("t1", card(s, 0).task().id());
    }

    @Test public void waitingMergeDecisionsKeepTheirExistingRowEvenDuringStudioReview() {
        var s = state(); upsert(s, task("t35", "running", null, 100));
        for (String id : List.of("d1", "d2")) {
            var msg = JsonParser.parseString("{\"decision\":{\"id\":\"" + id + "\",\"agentId\":\"marlow\",\"kind\":\"merge\",\"status\":\"open\",\"question\":\"Merge?\"}}").getAsJsonObject();
            s.inject("decision.upsert", msg);
        }
        var merges = s.openDecisions();
        for (int i = 0; i < 2; i++) {
            var card = ReviewStationCard.select(s.tasks().values(), merges, i);
            assertEquals(Kind.MERGE, card.kind()); assertEquals(merges.get(i), card.decision());
        }
        assertEquals(Kind.HIDDEN, ReviewStationCard.select(s.tasks().values(), merges, 2).kind());
        assertEquals(Kind.REVIEW, card(s, 0).kind());
    }

    @Test public void pausedErrorAndFuturePhasesAreNotPresentedAsSuccessfulReview() {
        var s = state();
        for (String phase : List.of("paused", "error", "future")) {
            upsert(s, task("t35", phase, null, 100));
            assertNotEquals("Идёт ревью", card(s, 0).status(false));
            assertNotEquals("pass", card(s, 0).status(false));
            assertNull(card(s, 0).task().studioReview().verdict());
        }
    }
}
