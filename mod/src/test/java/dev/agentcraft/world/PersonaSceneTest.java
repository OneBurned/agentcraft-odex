package dev.agentcraft.world;

import dev.agentcraft.workspace.PersonaScene;
import org.junit.Test;
import static org.junit.Assert.*;

public class PersonaSceneTest {
    @Test public void choosesPresentRestingPeersAmongThreeAgentsAndReactsToRecipientChanges() {
        var peers = java.util.List.of(new PersonaScene.Peer("a", true, 0),
            new PersonaScene.Peer("b", true, 9), new PersonaScene.Peer("c", true, 4));
        assertEquals("c", PersonaScene.closestPeer("a", peers));
        assertEquals("b", PersonaScene.closestPeer("a", java.util.List.of(peers.get(0), peers.get(1), new PersonaScene.Peer("c", false, 4))));
        assertEquals("", PersonaScene.closestPeer("a", java.util.List.of(peers.get(0), new PersonaScene.Peer("b", true, 16))));
        var scene = new PersonaScene();
        assertEquals("peer", scene.update(true, false, "c"));
        assertEquals("", scene.update(true, false, "c"));
        assertEquals("peer", scene.update(true, false, "b"));
        assertEquals("rest", scene.update(true, false, ""));
    }
    @Test public void cuesRequireArrivalAndOnlyFireOnSceneChanges() {
        PersonaScene scene = new PersonaScene();
        assertEquals("", scene.update(false, true, "third"));
        assertEquals("rest", scene.update(true, false, ""));
        assertEquals("", scene.update(true, false, ""));
        assertEquals("peer", scene.update(true, false, "third"));
        assertEquals("dance", scene.update(true, true, "third"));
        for (int i = 0; i < 1200; i++) assertEquals("", scene.update(true, true, "third"));
        assertEquals("", scene.update(false, false, "")); // work, pause, offline or leaving
        assertEquals("rest", scene.update(true, false, ""));
    }
}
