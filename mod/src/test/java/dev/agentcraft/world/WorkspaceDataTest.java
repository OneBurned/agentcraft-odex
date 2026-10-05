package dev.agentcraft.world;

import com.google.gson.Gson;
import dev.agentcraft.workspace.WorkspaceData;
import dev.agentcraft.workspace.WorkspaceRole;
import java.util.Map;
import org.junit.Test;
import static org.junit.Assert.*;

public class WorkspaceDataTest {
	private static final WorkspaceData.Spot DESK = new WorkspaceData.Spot(10,66,20,180);
	@Test public void optionalZonesFallBackWithoutInventingSavedPositions() {
		var workspace = new WorkspaceData(false,Map.of()).with(WorkspaceRole.DESK,DESK);
		assertEquals(DESK,workspace.spot(WorkspaceRole.LIBRARY));
		assertEquals(1,workspace.spots().size());
		assertEquals(workspace,new Gson().fromJson(new Gson().toJson(workspace),WorkspaceData.class));
	}
	@Test public void movingDeskDropsOutOfRangeOldZones() {
		var workspace = new WorkspaceData(true,Map.of("desk",DESK,"library",new WorkspaceData.Spot(15,66,20,90)));
		var moved = workspace.with(WorkspaceRole.DESK,new WorkspaceData.Spot(200,66,300,0));
		assertEquals(1,moved.spots().size());
		assertEquals(moved.spot(WorkspaceRole.DESK),moved.spot(WorkspaceRole.LIBRARY));
	}
	@Test(expected=IllegalArgumentException.class) public void deskRequiredBeforeOtherZones() {
		new WorkspaceData(false,Map.of()).with(WorkspaceRole.LOUNGE,DESK);
	}
	@Test(expected=IllegalArgumentException.class) public void rejectsDistantZones() {
		new WorkspaceData(true,Map.of("desk",DESK)).with(WorkspaceRole.LOUNGE,new WorkspaceData.Spot(10000,66,20,0));
	}
	@Test public void roleCycleReturnsToDesk() {
		var role=WorkspaceRole.DESK;
		for(int i=0;i<WorkspaceRole.values().length;i++) role=role.next();
		assertEquals(WorkspaceRole.DESK,role);
	}
}
