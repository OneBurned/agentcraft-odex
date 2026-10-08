package dev.agentcraft.hq;

import java.util.UUID;
import net.minecraft.core.BlockPos;
import org.junit.Test;
import static org.junit.Assert.*;

public class PlacementSelectionTest {
	private final UUID player=UUID.randomUUID();
	private final Object world=new Object();
	private final int[] box={-10,60,-15,10,80,15};
	private PlacementSelection.Target noAim() { throw new AssertionError("place must never raycast or recalculate rotation"); }

	@Test public void placementUsesSavedCentreAndRotationWithoutAimingForEveryBuilding() {
		for(String building:new String[]{"studio","cabin","modern-base","island","lakehouse"}) {
			var selections=new PlacementSelection<Object>();
			for(int turn=0;turn<4;turn++) {
				var centre=new BlockPos(1007,118,1613);
				var target=new PlacementSelection.Target(centre,turn);
				var preview=selections.resolve(player,world,building,true,()->target);
				selections.remember(player,world,building,preview,box);
				// No outline timer is consulted by placement, nor the player's current aim/position.
				assertEquals(target,selections.resolve(player,world,building,false,this::noAim));
				selections.checkBounds(player,box);
			}
		}
	}
	@Test public void missingPreviewOtherPlayerWorldOrBuildingCannotFallBackToAim() {
		var selections=new PlacementSelection<Object>();
		assertThrows(IllegalArgumentException.class,()->selections.resolve(player,world,"cabin",false,this::noAim));
		var target=new PlacementSelection.Target(BlockPos.ZERO,2);
		selections.remember(player,world,"cabin",target,box);
		assertThrows(IllegalArgumentException.class,()->selections.resolve(UUID.randomUUID(),world,"cabin",false,this::noAim));
		assertThrows(IllegalArgumentException.class,()->selections.resolve(player,new Object(),"cabin",false,this::noAim));
		assertThrows(IllegalArgumentException.class,()->selections.resolve(player,world,"studio",false,this::noAim));
		assertEquals(target,selections.resolve(player,world,"cabin",false,this::noAim));
	}
	@Test public void onlySuccessfulNewPreviewReplacesSelection() {
		var selections=new PlacementSelection<Object>();
		var old=new PlacementSelection.Target(BlockPos.ZERO,1);
		selections.remember(player,world,"cabin",old,box);
		assertThrows(IllegalArgumentException.class,()->selections.resolve(player,world,"studio",true,()->{throw new IllegalArgumentException("No aimed block");}));
		assertEquals(old,selections.resolve(player,world,"cabin",false,this::noAim));
		var next=new PlacementSelection.Target(new BlockPos(50,100,200),3);
		assertEquals(next,selections.resolve(player,world,"studio",true,()->next));
		// Command validation happens before remember; a failed size/border check keeps the old selection.
		assertEquals(old,selections.resolve(player,world,"cabin",false,this::noAim));
		selections.remember(player,world,"studio",next,box);
		assertEquals(next,selections.resolve(player,world,"studio",false,this::noAim));
	}
	@Test public void changedBoundsAreRejectedWithoutLosingSelectedSite() {
		var selections=new PlacementSelection<Object>(); var original=box.clone();
		var mutable=new BlockPos.MutableBlockPos(1,2,3);
		var target=new PlacementSelection.Target(mutable,1);
		selections.remember(player,world,"island",target,box);
		mutable.set(9,9,9); box[3]++;
		assertThrows(IllegalArgumentException.class,()->selections.checkBounds(player,box));
		selections.checkBounds(player,original);
		assertEquals(new BlockPos(1,2,3),selections.resolve(player,world,"island",false,this::noAim).block());
	}
	@Test public void successfulPlacementOrWorldCloseClearsSelection() {
		var selections=new PlacementSelection<Object>(); var target=new PlacementSelection.Target(BlockPos.ZERO,0);
		selections.remember(player,world,"cabin",target,box); selections.forget(player);
		assertThrows(IllegalArgumentException.class,()->selections.resolve(player,world,"cabin",false,this::noAim));
		selections.remember(player,world,"cabin",target,box); selections.clear();
		assertThrows(IllegalArgumentException.class,()->selections.resolve(player,world,"cabin",false,this::noAim));
	}
}
