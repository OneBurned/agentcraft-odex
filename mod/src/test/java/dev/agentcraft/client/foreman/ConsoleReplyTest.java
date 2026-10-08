package dev.agentcraft.client.foreman;

import com.google.gson.JsonParser;
import dev.agentcraft.client.console.ConsoleCommands;
import org.junit.Test;
import static org.junit.Assert.*;

public class ConsoleReplyTest {
    private ForemanState state() {
        ForemanState s = new ForemanState(new LinkStatus(LinkStatus.Phase.SYNCED, "test", 0, null, 0, 0, true));
        apply(s, "snapshot", "{\"foreman\":{\"backend\":\"observer\"},\"agents\":[{\"id\":\"marlow\",\"name\":\"Каден\",\"state\":\"idle\"},{\"id\":\"wren\",\"name\":\"Клава\",\"state\":\"idle\"}]}");
        return s;
    }
    private void apply(ForemanState s, String type, String json) { s.inject(type, JsonParser.parseString(json).getAsJsonObject()); }
    private void feed(ForemanState s, String kind, String from, String to) {
        apply(s, "feed.add", "{\"item\":{\"ts\":42,\"kind\":\"" + kind + "\",\"agentId\":\"" + from + "\",\"to\":\"" + to + "\",\"text\":\"Ответ\"}}");
    }
    private ConsoleCommands.Message message(ForemanState s, String text) {
        return (ConsoleCommands.Message) ConsoleCommands.parse(text, s);
    }
    @Test public void latestUserDirectedAnswerOrQuestionWinsEvenAtSameTimestamp() {
        ForemanState s = state();
        assertTrue(ConsoleCommands.parse("Привет", s) instanceof ConsoleCommands.Invalid);
        feed(s, "message", "wren", "user");
        assertEquals("wren", message(s, "Привет").to());
        assertEquals("ответ: Клава", ConsoleCommands.describe(message(s, "Привет"), s));
        feed(s, "user", "user", "marlow");
        feed(s, "task", "marlow", "user");
        feed(s, "message", "marlow", "wren");
        feed(s, "message", "kit", "user");
        assertEquals("wren", message(s, "Привет").to()); // unknown historical author cannot become the reply target
        feed(s, "decision", "marlow", "user");
        assertEquals("marlow", message(s, "Да").to());
        feed(s, "message", "wren", "user"); // review conclusion uses this same envelope
        assertEquals("wren", message(s, "Спасибо").to());
    }
    @Test public void explicitTargetsAndCommandsKeepTheirPriority() {
        ForemanState s = state(); feed(s, "message", "wren", "user");
        assertEquals("marlow", message(s, "@marlow задача").to());
        assertEquals("wren", message(s, "@wren вопрос").to());
        assertEquals("wren", message(s, "@Клава вопрос").to());
        assertTrue(ConsoleCommands.parse("@all вопрос", s) instanceof ConsoleCommands.Invalid);
        assertFalse(message(s, "@marlow задача").reply());
        for (String cmd : new String[]{"pause", "resume", "stop"}) {
            var action = (ConsoleCommands.AgentAction) ConsoleCommands.parse("/" + cmd, s);
            assertEquals(java.util.List.of("wren"), action.agentIds());
        }
        assertTrue(ConsoleCommands.parse("/goal задача", s) instanceof ConsoleCommands.Goal);
    }
    @Test public void renamedHiddenAgentKeepsIdentityAndUnavailableRecipientNeverFallsBack() {
        ForemanState s = state(); feed(s, "message", "wren", "user");
        apply(s, "agent.upsert", "{\"agent\":{\"id\":\"wren\",\"name\":\"Ревьюер\",\"active\":false,\"state\":\"idle\",\"controls\":{\"message\":true,\"hint\":\"Готова\"}}}");
        assertEquals("wren", message(s, "Да").to());
        assertEquals("ответ: Ревьюер", ConsoleCommands.describe(message(s, "Да"), s));
        assertNull(ConsoleCommands.replyError(message(s, "Да"), s));
        for (String fields : new String[]{"\"paused\":true", "\"state\":\"thinking\"", "\"active\":false"}) {
            apply(s, "agent.upsert", "{\"agent\":{\"id\":\"wren\",\"name\":\"Ревьюер\"," + fields + "}}");
            assertEquals("wren", message(s, "Мой полный\nтекст").to());
            assertEquals("Мой полный\nтекст", message(s, "Мой полный\nтекст").text());
            assertNotNull(ConsoleCommands.replyError(message(s, "Да"), s));
            assertNull(ConsoleCommands.replyError(message(s, "@marlow Да"), s));
        }
    }
    @Test public void snapshotsRestorePersistedChoiceOrDeriveLegacyHistoryAndResetOtherProfile() {
        ForemanState s = state();
        apply(s, "snapshot", "{\"agents\":[{\"id\":\"wren\"},{\"id\":\"marlow\"}],\"replyAgentId\":\"wren\",\"feed\":[]}");
        assertEquals("wren", s.replyAgentId());
        apply(s, "snapshot", "{\"agents\":[{\"id\":\"wren\"},{\"id\":\"marlow\"}],\"feed\":[{\"kind\":\"message\",\"agentId\":\"marlow\",\"to\":\"user\",\"text\":\"Ответ\"}]}");
        assertEquals("marlow", s.replyAgentId());
        feed(s, "message", "wren", "user");
        for (int i = 0; i < 205; i++) feed(s, "task", "marlow", "user");
        assertEquals("wren", s.replyAgentId());
        apply(s, "snapshot", "{}");
        assertEquals("", s.replyAgentId());
    }
}
