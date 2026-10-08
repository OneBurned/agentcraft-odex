package dev.agentcraft.client.studio;

import com.google.gson.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class TeamDraftTest {
    private JsonArray capabilities() { return JsonParser.parseString("""
        [{"provider":"codex","transport":"codex-desktop","roles":["planner","developer","reviewer"],"unavailable":{}},
         {"provider":"codex","transport":"codex-cli","roles":["planner","developer","reviewer"],"unavailable":{}},
         {"provider":"claude","transport":"claude-code","roles":["developer","reviewer"],"unavailable":{"planner":"Пока не подключено"}}]
        """).getAsJsonArray(); }
    @Test public void buildsDisabledAgentWithBridgeRolesAndRejectsUnsupportedCombinations() {
        var draft = new TeamDraft(capabilities(), new JsonObject(), "codex-desktop"); draft.name = "Новый агент"; draft.roles.add("planner");
        var out = draft.payload(7); assertEquals(7, out.get("revision").getAsInt()); assertFalse(out.getAsJsonObject("agent").get("enabled").getAsBoolean());
        draft.nextTransport(); assertEquals("codex-cli", draft.transport); assertTrue(draft.roles.contains("planner"));
        draft.nextTransport(); assertEquals("claude", draft.provider()); assertFalse(draft.supports("planner")); assertFalse(draft.roles.contains("planner"));
        draft.roles.add("planner"); assertThrows(IllegalArgumentException.class, () -> draft.payload(7));
        assertEquals("Новый агент", draft.name); draft.roles.clear(); assertThrows(IllegalArgumentException.class, () -> draft.payload(7));
    }
    @Test public void editPreservesIdAndUnchangedMigratedRolesWithoutSendingStoredPaths() {
        var source = JsonParser.parseString("""
          {"id":"wren","name":"Клава","provider":"claude","roles":["planner","reviewer"],"memoryDir":"private/path"}
          """).getAsJsonObject();
        var draft = new TeamDraft(capabilities(), source, "claude-code"); draft.name = "Новое имя";
        var out = draft.payload(10); assertEquals("wren", out.get("id").getAsString()); assertFalse(out.getAsJsonObject("patch").has("memoryDir"));
        assertEquals(source.get("roles"), out.getAsJsonObject("patch").get("roles")); assertEquals("Клава", source.get("name").getAsString());
    }
    @Test public void separatesArchiveWithoutFixedAgentNames() {
        var team = JsonParser.parseString("""
          {"agents":[{"id":"one","archived":false},{"id":"two","archived":true},{"id":"three","archived":false}]}
          """).getAsJsonObject();
        assertEquals(2, TeamDraft.agents(team, false).size()); assertEquals("two", TeamDraft.text(TeamDraft.agents(team, true).getFirst(), "id"));
    }
    @Test public void connectionFieldsAreTypedAndKeepInvalidDraftsForCorrection() {
        var draft = new ConnectionDraft("codex-cli", new JsonObject());
        draft.values.put("workspace", "C:\\project"); draft.values.put("executable", "C:\\codex.exe");
        var out = draft.payload("third", 3); assertEquals("third", out.get("id").getAsString());
        assertEquals("read-only", out.getAsJsonObject("connection").get("sandbox").getAsString());
        draft.values.put("sessionId", "invalid"); assertThrows(IllegalArgumentException.class, () -> draft.payload("third", 3)); assertEquals("invalid", draft.values.get("sessionId"));
        var claude = new ConnectionDraft("claude-code", new JsonObject()); claude.values.put("workspace", "C:\\Claude"); claude.values.put("sessionId", java.util.UUID.randomUUID().toString());
        assertFalse(claude.payload("reviewer", 4).getAsJsonObject("connection").has("executable"));
        assertTrue(claude.dirty()); claude.markSaved(); assertFalse(claude.dirty());
    }
    @Test public void switchingTransportDoesNotSendFieldsFromAnotherTransport() {
        var c = JsonParser.parseString("""
          {"transport":"codex-desktop","threadId":"old","pipePath":"private","title":"Old"}
          """).getAsJsonObject();
        var draft = new ConnectionDraft("codex-cli", c); assertFalse(draft.canCheck());
        draft.values.put("workspace", "C:\\project"); draft.values.put("executable", "C:\\codex.exe");
        var connection = draft.payload("agent", 0).getAsJsonObject("connection"); assertFalse(connection.has("pipePath")); assertFalse(connection.has("threadId"));
        draft.markSaved(); assertTrue(draft.canCheck()); draft.values.put("workspace", "C:\\other"); assertFalse(draft.canCheck());
    }
    @Test public void editorFieldsAndFooterFitNormalGuiSizes() {
        for (int[] size : new int[][]{{320,240}, {427,240}, {480,270}, {640,360}, {960,540}}) {
            var l = TeamDraft.Layout.at(size[0], size[1]); assertTrue(l.x() >= 0); assertTrue(l.x() + l.width() <= size[0]);
            assertTrue(l.contentY() > 54); assertTrue(l.contentY() + 113 <= l.backY());
            assertTrue(l.backY() + 20 < l.statusY()); assertTrue(l.statusY() + 20 <= size[1]);
        }
    }
}
