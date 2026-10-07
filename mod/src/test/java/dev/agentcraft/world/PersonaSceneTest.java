package dev.agentcraft.world;

import dev.agentcraft.workspace.PersonaScene;
import org.junit.Test;
import static org.junit.Assert.*;

public class PersonaSceneTest {
    @Test public void cuesRequireArrivalAndOnlyFireOnSceneChanges() {
        PersonaScene scene = new PersonaScene();
        assertEquals("", scene.update(false, true, true));
        assertEquals("rest", scene.update(true, false, false));
        assertEquals("", scene.update(true, false, false));
        assertEquals("peer", scene.update(true, false, true));
        assertEquals("dance", scene.update(true, true, true));
        for (int i = 0; i < 1200; i++) assertEquals("", scene.update(true, true, true));
        assertEquals("", scene.update(false, false, false)); // work, pause, offline or leaving
        assertEquals("rest", scene.update(true, false, false));
    }
}
