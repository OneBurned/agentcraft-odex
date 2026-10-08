package dev.agentcraft.client.foreman;

import com.google.gson.JsonParser;
import org.junit.Test;
import static org.junit.Assert.*;

public class TeamProtocolTest {
    private void apply(ForemanState state, String type, String json) {
        state.inject(type, JsonParser.parseString(json).getAsJsonObject());
    }
    @Test public void archiveRemovesRosterButKeepsTaskIdentityAndRestoreReusesId() {
        var state = new ForemanState(new LinkStatus(LinkStatus.Phase.SYNCED, "test", 0, null, 0, 0, true));
        String agent = "{\"agent\":{\"id\":\"agent_abc\",\"name\":\"Original\",\"provider\":\"claude\",\"visible\":true,\"enabled\":false,\"active\":false}}";
        apply(state, "agent.upsert", agent);
        assertTrue(state.agent("agent_abc").isVisible());
        assertFalse(state.agent("agent_abc").isActive());
        apply(state, "task.upsert", "{\"task\":{\"id\":\"t1\",\"assignee\":\"agent_abc\",\"assigneeIdentity\":{\"id\":\"agent_abc\",\"name\":\"Original\",\"provider\":\"claude\"}}}");
        long revision = state.revision();
        var removed = new java.util.ArrayList<String>();
        var changes = new java.util.ArrayList<Long>();
        state.addListener(new ForemanListener() {
            @Override public void onAgentRemoved(Protocol.Agent previous) {
                assertNull(state.agent(previous.id()));
                removed.add(previous.id());
            }
            @Override public void onChange(long value) { changes.add(value); }
        });
        apply(state, "agent.remove", "{\"agentId\":\"agent_abc\"}");
        assertEquals(revision + 1, state.revision());
        assertEquals(java.util.List.of("agent_abc"), removed);
        assertEquals(java.util.List.of(revision + 1), changes);
        assertNull(state.agent("agent_abc"));
        assertEquals("Original · claude", state.task("t1").assigneeLabel());
        apply(state, "agent.remove", "{\"agentId\":\"agent_abc\"}");
        assertEquals(revision + 1, state.revision());
        apply(state, "agent.upsert", agent.replace("Original", "Renamed"));
        assertEquals("Renamed", state.agent("agent_abc").name());
        assertEquals("Original · claude", state.task("t1").assigneeLabel());
    }
    @Test public void snapshotNeverPicksARecipientFromRosterOrder() {
        var state = new ForemanState(new LinkStatus(LinkStatus.Phase.SYNCED, "test", 0, null, 0, 0, true));
        String roster = "\"agents\":[{\"id\":\"disabled\",\"enabled\":false},{\"id\":\"enabled\",\"enabled\":true}]";
        apply(state, "snapshot", "{" + roster + "}");
        assertEquals("", state.replyAgentId());
        apply(state, "snapshot", "{" + roster + ",\"replyAgentId\":\"enabled\"}");
        assertEquals("enabled", state.replyAgentId());
        apply(state, "snapshot", "{" + roster + ",\"feed\":[{\"kind\":\"message\",\"agentId\":\"enabled\",\"to\":\"user\",\"text\":\"Reply\"}]}");
        assertEquals("enabled", state.replyAgentId());
        apply(state, "snapshot", "{" + roster + "}");
        assertEquals("", state.replyAgentId());
    }
    @Test public void mismatchedProtocolGivesActionableError() {
        assertEquals(2, Protocol.VERSION);
        assertNull(ForemanJson.protocolError(JsonParser.parseString("{\"v\":2}").getAsJsonObject()));
        for (String json : new String[]{"{\"v\":1}", "{\"v\":3}", "{\"v\":2.5}", "{\"v\":\"2\"}", "{}", "{\"v\":null}"})
            assertTrue(ForemanJson.protocolError(JsonParser.parseString(json).getAsJsonObject()).contains("Обнови мод и мост"));
    }
}
