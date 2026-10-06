package dev.agentcraft.workspace;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Stable choices and exclusive physical places, independent of rendering and real task state. */
public final class RestCoordinator {
    public record Candidate(String id, String key, boolean dance) {}
    private record Choice(Candidate place, long until) {}
    private final Map<String, Choice> choices = new HashMap<>();
    public static boolean canRest(String state, String station, boolean active, boolean paused,
            boolean stale, boolean question, boolean planning) {
        return active && !paused && !stale && !question && !planning && station.equals("lounge")
            && (state.equals("idle") || state.equals("done"));
    }
    public void retain(Set<String> agents) { choices.keySet().retainAll(agents); }
    public void clear() { choices.clear(); }
    public Candidate select(String agent, List<Candidate> candidates, long tick) {
        var available = candidates.stream().filter(c -> choices.entrySet().stream()
            .noneMatch(e -> !e.getKey().equals(agent) && e.getValue().place.key().equals(c.key()))).toList();
        var dances = available.stream().filter(Candidate::dance).toList();
        var pool = dances.isEmpty() ? available : dances;
        Choice previous = choices.get(agent);
        if (previous != null && pool.contains(previous.place) && tick < previous.until) return previous.place;
        choices.remove(agent);
        if (pool.isEmpty()) return null;
        var alternatives = previous == null ? pool : pool.stream().filter(c -> !c.equals(previous.place)).toList();
        if (alternatives.isEmpty()) alternatives = pool;
        Candidate chosen = alternatives.get(Math.floorMod(agent.hashCode() + (int)(tick / 600), alternatives.size()));
        choices.put(agent, new Choice(chosen, tick + 600));
        return chosen;
    }
}
