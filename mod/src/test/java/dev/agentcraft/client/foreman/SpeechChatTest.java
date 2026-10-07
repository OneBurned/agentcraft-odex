package dev.agentcraft.client.foreman;

import com.google.gson.Gson;
import com.google.gson.JsonParser;
import dev.agentcraft.client.agents.SpeechChat;
import dev.agentcraft.client.studio.StudioPreferences;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.network.chat.Component;
import org.junit.Test;
import static org.junit.Assert.*;

public class SpeechChatTest {
    private final Gson gson = new Gson();
    private Protocol.Agent profile(String id, String name, String color) {
        return new Protocol.Agent(id, name, null, null, color, null, id, null, "", null,
            null, null, null, false, true, null);
    }

    @Test public void formatsCurrentProfileNameAndColourAsLiteralLocalChatText() {
        Component line = SpeechChat.format(profile("wren", "Клава", "#D78E65"), " Привет\n  тебе! ");
        assertEquals("<Клава> Привет тебе!", line.getString());
        assertEquals(0xD78E65, line.getStyle().getColor().getValue());
        assertNull(line.getStyle().getClickEvent());
        Component renamed = SpeechChat.format(profile("wren", "Анна", "#123456"), "/help");
        assertEquals("<Анна> /help", renamed.getString()); // literal text, never a command
        assertEquals(0x123456, renamed.getStyle().getColor().getValue());
        assertEquals(0x9C9488, SpeechChat.format(profile("marlow", "Кадеин", "bad"), "Привет").getStyle().getColor().getValue());
    }

    @Test public void mutesWithoutReplayingAndDeduplicatesByEventNotByPhrase() {
        SpeechChat chat = new SpeechChat(); List<Component> lines = new ArrayList<>();
        var agent = profile("wren", "Клава", "#D78E65");
        var muted = new Protocol.AgentSay("wren", "Перерыв", "user", 100);
        chat.shown(muted, agent, false, lines::add);
        chat.shown(muted, agent, true, lines::add);
        assertTrue(lines.isEmpty());
        var first = new Protocol.AgentSay("wren", "Привет", "user", 200);
        chat.shown(first, agent, true, lines::add);
        chat.shown(new Protocol.AgentSay("wren", "Привет", "user", 200), agent, true, lines::add);
        chat.shown(new Protocol.AgentSay("wren", "Привет", "user", 201), agent, true, lines::add);
        chat.shown(new Protocol.AgentSay("wren", "Другая фраза", "user", 201), agent, true, lines::add);
        chat.shown(first, profile("wren", "Новое имя", "#123456"), true, lines::add);
        assertEquals(3, lines.size());
        chat.shown(new Protocol.AgentSay("marlow", "Привет", "user", 200), profile("marlow", "Кадеин", "#858ED1"), true, lines::add);
        assertEquals(4, lines.size());
    }

    @Test public void ignoresEmptyPhrasesAndWrongProfiles() {
        SpeechChat chat = new SpeechChat(); List<Component> lines = new ArrayList<>();
        var agent = profile("wren", "Клава", "#D78E65");
        chat.shown(new Protocol.AgentSay("wren", " \n ", null, 1), agent, true, lines::add);
        chat.shown(new Protocol.AgentSay("marlow", "Привет", null, 2), agent, true, lines::add);
        assertTrue(lines.isEmpty());
    }

    @Test public void preferencesDefaultOnForOldFilesAndRoundTripTheDisabledSetting() {
        assertTrue(new StudioPreferences().speechInMinecraftChat);
        assertTrue(gson.fromJson("{}", StudioPreferences.class).speechInMinecraftChat);
        StudioPreferences preferences = gson.fromJson("{\"speechInMinecraftChat\":false,\"consoleTextScale\":0.6}", StudioPreferences.class);
        assertFalse(preferences.speechInMinecraftChat);
        var restored = gson.fromJson(gson.toJson(preferences), StudioPreferences.class);
        assertFalse(restored.speechInMinecraftChat);
        assertEquals(0.6f, restored.consoleTextScale, 0.001f);
    }

    @Test public void repeatDeliveryAcrossSnapshotsDoesNotDuplicateChatOrTouchFeedAndLogs() {
        ForemanState state = new ForemanState(new LinkStatus(LinkStatus.Phase.SYNCED, "test", 0, null, 0, 0, true));
        String snapshot = "{\"agents\":[{\"id\":\"wren\",\"name\":\"Клава\",\"color\":\"#D78E65\"}]}";
        state.apply("snapshot", JsonParser.parseString(snapshot).getAsJsonObject());
        SpeechChat chat = new SpeechChat(); List<Component> lines = new ArrayList<>();
        state.addListener(new ForemanListener() {
            @Override public void onSay(Protocol.AgentSay say) {
                chat.shown(say, state.agent(say.agentId()), true, lines::add);
            }
        });
        var event = JsonParser.parseString("{\"agentId\":\"wren\",\"text\":\"Привет\",\"to\":\"marlow\",\"ts\":42}").getAsJsonObject();
        state.apply("agent.say", event);
        state.apply("snapshot", JsonParser.parseString(snapshot).getAsJsonObject());
        state.apply("agent.say", event);
        assertEquals(1, lines.size());
        assertEquals(0, state.logCount("wren"));
        assertTrue(state.feed().isEmpty());
    }
}
