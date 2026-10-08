package dev.agentcraft.world;

import dev.agentcraft.hq.SiteTransform;
import org.junit.Test;
import static org.junit.Assert.*;

public class SiteTransformTest {
	@Test public void selectedBlockRemainsCentreForEveryRotation() {
		for(int turn=0;turn<4;turn++) {
			var t=new SiteTransform(123,-17,-456,turn,7);
			assertEquals(123,t.blockX(0,7)); assertEquals(-456,t.blockZ(0,7));
			assertEquals(123.5,t.worldX(.5,7.5),1e-9); assertEquals(-455.5,t.worldZ(.5,7.5),1e-9);
		}
	}
	@Test public void rotatesFacingAndRectangularFootprintTogether() {
		var t=new SiteTransform(100,6,200,1,0);
		assertEquals(97,t.blockX(2,3)); assertEquals(202,t.blockZ(2,3));
		assertArrayEquals(new int[]{96,66,198,104,86,202},t.box(new int[]{-2,60,-4,2,80,4}));
		// The legacy zero-pivot translation remains identical for existing worlds.
		var legacy=new SiteTransform(160,2,640,0,0);
		assertEquals(160.5,legacy.worldX(.5,22.5),1e-9);
		assertEquals(662.5,legacy.worldZ(.5,22.5),1e-9);
	}
}
