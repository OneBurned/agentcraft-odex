package dev.agentcraft.client.foreman;

import java.util.List;
import org.jspecify.annotations.Nullable;

/** Roster selection shared by the pult, common equipment and tests. Never creates agents. */
public final class AgentSelection {
    private AgentSelection() {}
    public static String keepOrFirst(String selected, List<String> ids) {
        return ids.contains(selected) ? selected : ids.isEmpty() ? "" : ids.getFirst();
    }
    public static String next(String selected, List<String> ids) {
        return ids.isEmpty() ? "" : ids.get((ids.indexOf(selected) + 1) % ids.size());
    }
    /** Slots address positions in the bridge roster. Explicit IDs never fall back to another agent. */
    public static @Nullable String binding(String binding, ForemanState state) {
        String value = binding.startsWith("agent:") ? binding.substring(6) : binding;
        if (value.isEmpty()) value = "slot:1";
        if (value.startsWith("slot:")) {
            try {
                int slot = Integer.parseInt(value.substring(5)) - 1;
                var ids = List.copyOf(state.agents().keySet());
                return slot >= 0 && slot < ids.size() ? ids.get(slot) : null;
            } catch (NumberFormatException ignored) { return null; }
        }
        return state.agent(value) == null ? null : value;
    }
}
