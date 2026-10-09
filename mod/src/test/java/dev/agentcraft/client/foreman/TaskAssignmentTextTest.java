package dev.agentcraft.client.foreman;

import com.google.gson.JsonParser;
import dev.agentcraft.client.taskwall.TaskAssignmentText;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public class TaskAssignmentTextTest {
    private ForemanState state() {
        var state = new ForemanState(new LinkStatus(LinkStatus.Phase.SYNCED, "test", 0, null, 0, 0, true));
        state.inject("snapshot", JsonParser.parseString("""
            {"agents":[{"id":"dev","name":"Разработчик один"},{"id":"review","name":"Ревьюер два"}],
             "tasks":[{"id":"t1","queueStage":"queued","queueAssignment":{"developerId":"dev","reviewerId":"review","noReview":false}}]}
            """).getAsJsonObject());
        return state;
    }

    @Test public void queuedTaskShowsBothRolesWithoutAnExecutionAssignee() {
        var state = state();
        assertNull(state.task("t1").assignee());
        assertEquals(List.of("Разработчик: Разработчик один", "Ревьюер: Ревьюер два"), TaskAssignmentText.lines(state, state.task("t1")));
        state.inject("task.upsert", JsonParser.parseString("""
            {"task":{"id":"t1","queueAssignment":{"noReview":true}}}
            """).getAsJsonObject());
        assertEquals(List.of("Разработчик: Не назначен", "Без ревью"), TaskAssignmentText.lines(state, state.task("t1")));
    }

    @Test public void legacyIdentityAndMissingAgentsRemainReadable() {
        var state = state();
        state.inject("task.upsert", JsonParser.parseString("""
            {"task":{"id":"old","assignee":"archived","assigneeIdentity":{"id":"archived","name":"Прежнее имя","provider":"codex"}}}
            """).getAsJsonObject());
        assertEquals(List.of("Исполнитель: Прежнее имя · codex"), TaskAssignmentText.lines(state, state.task("old")));
        state.inject("agent.remove", JsonParser.parseString("{\"agentId\":\"review\"}").getAsJsonObject());
        assertEquals("Ревьюер: review", TaskAssignmentText.lines(state, state.task("t1")).get(1));
    }
}
