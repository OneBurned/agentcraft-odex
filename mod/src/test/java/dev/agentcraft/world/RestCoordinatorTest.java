package dev.agentcraft.world;

import dev.agentcraft.workspace.RestCoordinator;
import dev.agentcraft.workspace.RestPlace;
import dev.agentcraft.layout.Anchor;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class RestCoordinatorTest {
    private static final RestCoordinator.Candidate CHAIR = new RestCoordinator.Candidate("chair", "rest:1", false);
    private static final RestCoordinator.Candidate POLE = new RestCoordinator.Candidate("dance", "pole:1", true);
    @Test public void musicStartsAndStopsWithoutWaitingForRestTimer() {
        var c=new RestCoordinator();
        assertEquals(CHAIR,c.select("marlow",List.of(CHAIR),0));
        assertEquals(POLE,c.select("marlow",List.of(CHAIR,POLE),1));
        assertEquals(CHAIR,c.select("marlow",List.of(CHAIR),2));
    }
    @Test public void physicalPoleIsExclusiveEvenWithDifferentSavedIds() {
        var c=new RestCoordinator();
        assertEquals(POLE,c.select("marlow",List.of(POLE),0));
        var samePole=new RestCoordinator.Candidate("claudes-dance", "pole:1",true);
        assertEquals(CHAIR,c.select("wren",List.of(samePole,CHAIR),0));
    }
    @Test public void workReleasesReservedPole() {
        var c=new RestCoordinator(); c.select("marlow",List.of(POLE),0);
        c.retain(Set.of("wren"));
        assertEquals(POLE,c.select("wren",List.of(POLE),1));
    }
    @Test public void choicesRemainStableAndEventuallyRotate() {
        var second=new RestCoordinator.Candidate("second","rest:2",false);
        var c=new RestCoordinator(); var first=c.select("wren",List.of(CHAIR,second),0);
        assertEquals(first,c.select("wren",List.of(second,CHAIR),599));
        assertNotEquals(first,c.select("wren",List.of(CHAIR,second),600));
    }
    @Test public void deletedOrUnavailablePlacesAreReleased() {
        var c=new RestCoordinator(); c.select("marlow",List.of(POLE),0);
        assertNull(c.select("marlow",List.of(),1));
        assertEquals(POLE,c.select("wren",List.of(POLE),2));
    }
    @Test public void differentAgentsCanUseDifferentPoles() {
        var second=new RestCoordinator.Candidate("second","pole:2",true);
        var c=new RestCoordinator(); var a=c.select("marlow",List.of(POLE,second),0);
        assertNotEquals(a,c.select("wren",List.of(POLE,second),0));
    }
    @Test public void onlyFreeLiveAgentsRest() {
        assertTrue(RestCoordinator.canRest("idle","lounge",true,false,false,false,false));
        assertTrue(RestCoordinator.canRest("done","lounge",true,false,false,false,false));
        for (String s:List.of("thinking","reading","editing","running","testing","waiting_user","blocked","error"))
            assertFalse(RestCoordinator.canRest(s,"lounge",true,false,false,false,false));
        assertFalse(RestCoordinator.canRest("idle","desk",true,false,false,false,false));
        assertFalse(RestCoordinator.canRest("idle","lounge",false,false,false,false,false));
        assertFalse(RestCoordinator.canRest("idle","lounge",true,true,false,false,false));
        assertFalse(RestCoordinator.canRest("idle","lounge",true,false,true,false,false));
        assertFalse(RestCoordinator.canRest("idle","lounge",true,false,false,true,false));
        assertFalse(RestCoordinator.canRest("idle","lounge",true,false,false,false,true));
    }
    private static RestPlace place(String id,boolean dance,int x) { return new RestPlace(id,dance,new Anchor("",x+0.5,65,0.5,90,0)); }
    @Test public void placesAppendWithoutLosingLegacyRestAndRoundTrip() {
        var old=place("legacy",false,1); var dance=place("dance",true,5);
        var points=RestPlace.put(List.of(old),dance);
        assertEquals(List.of(old,dance),points);
        List<RestPlace> loaded=new Gson().fromJson(new Gson().toJson(points),new TypeToken<List<RestPlace>>(){}.getType());
        assertEquals(points,loaded);
    }
    @Test public void movingReplacesOnlySelectedPlaceAndRepeatedMarkDoesNotDuplicate() {
        var points=RestPlace.put(List.of(place("a",false,1),place("b",true,5)),place("b",true,9));
        assertEquals(2,points.size()); assertEquals(1.5,points.getFirst().anchor().x(),0);
        points=RestPlace.put(points,place("c",true,9));
        assertEquals(2,points.size()); assertEquals("c",points.getLast().id());
    }
    @Test public void changingWorldReleasesAllReservations() {
        var c=new RestCoordinator(); c.select("marlow",List.of(POLE),0); c.clear();
        assertEquals(POLE,c.select("wren",List.of(POLE),0));
    }
}
