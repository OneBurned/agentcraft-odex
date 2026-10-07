package dev.agentcraft.workspace;

/** Edge-triggered presentation cues. No retries/queues of obsolete scene events. */
public final class PersonaScene {
    private String previous = "";
    public String update(boolean restingAtTarget, boolean dancing, boolean colleagueNearby) {
        String scene = !restingAtTarget ? "" : dancing ? "dance" : colleagueNearby ? "peer" : "rest";
        if (previous.equals(scene)) return "";
        previous = scene;
        return scene;
    }
}
