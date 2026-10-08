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
        apply(state, "agent.remove", "{\"agentId\":\"agent_abc\"}");
        assertNull(state.agent("agent_abc"));
        assertEquals("Original · claude", state.task("t1").assigneeLabel());
        apply(state, "agent.upsert", agent.replace("Original", "Renamed"));
        assertEquals("Renamed", state.agent("agent_abc").name());
        assertEquals("Original · claude", state.task("t1").assigneeLabel());
    }
    @Test public void mismatchedProtocolGivesActionableError() {
        assertEquals(2, Protocol.VERSION);
        assertNull(ForemanJson.protocolError(JsonParser.parseString("{\"v\":2}").getAsJsonObject()));
        for (String json : new String[]{"{\"v\":1}", "{\"v\":3}", "{\"v\":2.5}", "{\"v\":\"2\"}", "{}", "{\"v\":null}"})
            assertTrue(ForemanJson.protocolError(JsonParser.parseString(json).getAsJsonObject()).contains("Обнови мод и мост"));
    }
}
