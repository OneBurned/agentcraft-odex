package dev.agentcraft.workspace;

import dev.agentcraft.layout.Anchor;
import java.util.ArrayList;
import java.util.List;

/** Persisted user intent: a normal resting anchor or the bottom block of a dance pole. */
public record RestPlace(String id, boolean dance, Anchor anchor) {
    public String occupancyKey() {
        return (dance ? "pole:" : "rest:") + (int)Math.floor(anchor.x()) + ":"
            + (int)Math.floor(anchor.y()) + ":" + (int)Math.floor(anchor.z());
    }
    public static List<RestPlace> put(List<RestPlace> current, RestPlace place) {
        var next = new ArrayList<>(current);
        next.removeIf(p -> p.id().equals(place.id()) || p.occupancyKey().equals(place.occupancyKey()));
        if (next.size() >= 32) throw new IllegalArgumentException("Можно назначить до 32 мест отдыха агенту.");
        next.add(place);
        return List.copyOf(next);
    }
}
