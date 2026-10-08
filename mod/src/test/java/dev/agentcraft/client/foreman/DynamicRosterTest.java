package dev.agentcraft.client.foreman;

import com.google.gson.JsonParser;
import dev.agentcraft.client.console.ConsoleCommands;
import dev.agentcraft.client.agents.StationAssigner;
import dev.agentcraft.client.diff.ReviewStationCard;
import dev.agentcraft.layout.*;
import dev.agentcraft.workspace.WorkspaceAssignments;
import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class DynamicRosterTest {
    private ForemanState state() {
        var s = new ForemanState(new LinkStatus(LinkStatus.Phase.SYNCED, "test", 0, null, 0, 0, true));
        put(s, "snapshot", "{\"foreman\":{\"backend\":\"observer\"},\"agents\":["
            + "{\"id\":\"coder_a\",\"name\":\"Первый Кодер\",\"provider\":\"codex\",\"station\":\"desk\"},"
            + "{\"id\":\"coder_b\",\"name\":\"Второй Кодер\",\"provider\":\"codex\",\"station\":\"desk\",\"visible\":false},"
            + "{\"id\":\"review_c\",\"name\":\"Клава\",\"provider\":\"claude\",\"station\":\"desk\"}]}");
        return s;
    }
    private void put(ForemanState s, String type, String json) { s.inject(type, JsonParser.parseString(json).getAsJsonObject()); }
    private ConsoleCommands.Message message(ForemanState s, String text) { return (ConsoleCommands.Message) ConsoleCommands.parse(text, s); }
    @Test public void arbitraryNamesAndTwoSameProvidersHaveDistinctRecipientsAndControls() {
        var s = state();
        assertEquals("coder_a", message(s, "@Первый Кодер исправь\nошибку").to());
        assertEquals("исправь\nошибку", message(s, "@Первый Кодер исправь\nошибку").text());
        assertEquals("coder_b", message(s, "@coder_b проверь").to());
        assertTrue(ConsoleCommands.parse("@Codex задача", s) instanceof ConsoleCommands.Invalid);
        assertTrue(ConsoleCommands.parse("Без адресата", s) instanceof ConsoleCommands.Invalid);
        assertTrue(ConsoleCommands.parse("/pause", s) instanceof ConsoleCommands.Invalid);
        for (String op : List.of("pause", "resume", "stop")) {
            var intent = (ConsoleCommands.AgentAction) ConsoleCommands.parse("/" + op + " @Второй Кодер", s);
            assertEquals(List.of("coder_b"), intent.agentIds());
        }
        put(s, "agent.upsert", "{\"agent\":{\"id\":\"copy\",\"name\":\"Клава\"}}");
        assertTrue(ConsoleCommands.parse("@Клава привет", s) instanceof ConsoleCommands.Invalid);
        assertEquals("review_c", message(s, "@review_c привет").to());
        for (var completion : ConsoleCommands.complete("@", 1, s))
            assertEquals(completion.agentId(), message(s, completion.replacement() + "привет").to());
    }
    @Test public void removingOrRestoringAgentChangesSelectorsWithoutRevivingOldReplyAuthor() {
        var s = state();
        String feed = "{\"item\":{\"kind\":\"message\",\"agentId\":\"review_c\",\"to\":\"user\",\"text\":\"Ответ\"}}";
        put(s, "feed.add", feed); assertEquals("review_c", s.replyAgentId());
        put(s, "agent.remove", "{\"agentId\":\"review_c\"}"); put(s, "feed.add", feed);
        assertEquals("", s.replyAgentId());
        var ids = List.copyOf(s.agents().keySet());
        assertEquals("coder_a", AgentSelection.keepOrFirst("review_c", ids));
        assertEquals("coder_b", AgentSelection.next("coder_a", ids));
        assertEquals("", AgentSelection.next("coder_a", List.of()));
        assertNull(AgentSelection.binding("review_c", s));
        assertNull(AgentSelection.binding("slot:3", s));
        put(s, "agent.upsert", "{\"agent\":{\"id\":\"review_c\",\"name\":\"Новое имя\"}}");
        assertEquals("review_c", AgentSelection.binding("agent:slot:3", s));
        assertEquals("", s.replyAgentId());
        put(s, "snapshot", "{\"replyAgentId\":\"archived\",\"feed\":[{\"kind\":\"message\",\"agentId\":\"archived\",\"to\":\"user\",\"text\":\"Old\"}]}");
        assertTrue(s.agents().isEmpty()); assertEquals("", s.replyAgentId());
    }
    @Test public void commonDesksMatchMonitorSlotsEvenWithHiddenAgentsAndPersonalPlacesWin() {
        var s = state(); var roster = List.copyOf(s.agents().keySet());
        var a = new Anchor(AnchorNames.SHARED_DESK, 1, 66, 1, 180, 0);
        var b = new Anchor(AnchorNames.slot(AnchorNames.SHARED_DESK, 2), 4, 66, 1, 180, 0);
        var c = new Anchor(AnchorNames.slot(AnchorNames.SHARED_DESK, 3), 7, 66, 1, 180, 0);
        var layout = new Anchors.Layout("test", 1, null, Map.of(a.name(), a, b.name(), b, c.name(), c));
        var visible = List.of(s.agent("coder_a"), s.agent("review_c"));
        var assigner = new StationAssigner();
        var assigned = assigner.assign(visible, layout, roster);
        assertEquals(a, assigned.get("coder_a")); assertEquals(c, assigned.get("review_c"));
        assertEquals("review_c", AgentSelection.binding("slot:3", s));
        var personal = new Anchor(AnchorNames.desk("review_c"), 10, 66, 1, 0, 0);
        var anchors = new HashMap<>(layout.anchors()); anchors.put(personal.name(), personal);
        assertEquals(personal, assigner.assign(visible, new Anchors.Layout("test", 2, null, anchors), roster).get("review_c"));
        assertEquals(2, assigner.assign(visible, new Anchors.Layout("small", 3, null, Map.of(a.name(), a)), roster).size());
        assertTrue(assigner.assign(List.of(), layout, List.of()).isEmpty());
        var spots = WorkspaceAssignments.with(Map.of(), "review_c", "mergestation", personal, new Anchors.Bounds(-20, 50, -20, 20, 80, 20));
        assertEquals(10, spots.get("review_c/mergestation").x(), 0);
    }
    @Test public void reviewStationUsesTheAssignedReviewerNotDeveloperOrProvider() {
        var s = state();
        put(s, "task.upsert", "{\"task\":{\"id\":\"t1\",\"assignee\":\"coder_a\",\"studioReview\":{\"reviewerId\":\"coder_b\",\"phase\":\"running\",\"startedAt\":1}}}");
        var card = ReviewStationCard.select(s.tasks().values(), List.of(), 0);
        assertEquals("coder_b", card.reviewerId());
        put(s, "agent.remove", "{\"agentId\":\"coder_b\"}");
        assertEquals("coder_b", ReviewStationCard.select(s.tasks().values(), List.of(), 0).reviewerId());
        put(s, "task.upsert", "{\"task\":{\"id\":\"t1\",\"studioReview\":{\"phase\":\"finished\",\"startedAt\":1}}}");
        assertEquals("", ReviewStationCard.select(s.tasks().values(), List.of(), 0).reviewerId());
    }
}
