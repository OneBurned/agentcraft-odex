package dev.agentcraft.workspace;

/** Edge-triggered presentation cues. No retries/queues of obsolete scene events. */
public final class PersonaScene {
    private String previous = "";
    public record Peer(String id, boolean resting, double distanceSquared) {}
    public static String closestPeer(String self, java.util.List<Peer> peers) {
        return peers.stream().filter(p -> !p.id().equals(self) && p.resting() && p.distanceSquared() < 16)
            .min(java.util.Comparator.comparingDouble(Peer::distanceSquared).thenComparing(Peer::id))
            .map(Peer::id).orElse("");
    }
    public String update(boolean restingAtTarget, boolean dancing, String peerId) {
        String scene = !restingAtTarget ? "" : dancing ? "dance" : !peerId.isEmpty() ? "peer" : "rest";
        String key = scene.equals("peer") ? scene + "/" + peerId : scene;
        if (previous.equals(key)) return "";
        previous = key;
        return scene;
    }
}
