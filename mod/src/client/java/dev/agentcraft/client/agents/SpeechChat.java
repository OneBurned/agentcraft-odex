package dev.agentcraft.client.agents;

import dev.agentcraft.Cast;
import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.foreman.Protocol.AgentSay;
import java.util.HashSet;
import java.util.Set;
import java.util.function.Consumer;
import net.minecraft.network.chat.Component;

/** Client-session deduplication for speech that actually reached a character's bubble. */
public final class SpeechChat {
    private final Set<AgentSay> seen = new HashSet<>();

    public void shown(AgentSay say, Agent profile, boolean enabled, Consumer<Component> localChat) {
        if (say.text() == null || say.text().isBlank() || !say.agentId().equals(profile.id())) return;
        // Remember muted events too: enabling the option must not replay past phrases.
        if (!seen.add(say) || !enabled) return;
        localChat.accept(format(profile, say.text()));
    }

    public static Component format(Agent profile, String text) {
        return Component.literal("<" + profile.name() + "> ")
            .withColor(Cast.parseColor(profile.color(), 0x9C9488))
            .append(Component.literal(text.replaceAll("\\s+", " ").trim()).withColor(0xFFFFFF));
    }
}
