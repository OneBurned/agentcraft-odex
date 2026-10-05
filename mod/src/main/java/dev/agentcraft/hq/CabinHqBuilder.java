package dev.agentcraft.hq;

import dev.agentcraft.Cast;
import dev.agentcraft.block.*;
import dev.agentcraft.layout.AnchorNames;
import dev.agentcraft.layout.Anchors;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.HorizontalDirectionalBlock;

/** A small, fully equipped timber workshop for the observer's single Codex. */
public final class CabinHqBuilder implements HqBuilder {
	public static final String ID = "cabin";
	static final int[] SITE = {-13,60,-13,13,83,13};
	public String id() { return ID; }
	public String description() { return "compact timber workshop for Codex (21 x 17, site 27 x 27)"; }
	public void build(ServerLevel level, Anchors.Builder a) { build(level,a,Options.DEFAULT); }
	public String build(ServerLevel level, Anchors.Builder a, Options options) {
		HqPlacement site = options.placement() == null ? HqPlacement.resolve(level, SITE[4]) : options.placement();
		Plan p = new Plan(-13,site.bottom(),-13,13,83,13,64,y -> y > 64 ? Blocks.AIR.defaultBlockState()
			: y == 64 ? Blocks.GRASS_BLOCK.defaultBlockState() : Blocks.STONE.defaultBlockState());
		p.fill(-10,65,-8,10,65,8,ModBlocks.OAK_PARQUET);
		p.fill(-10,64,-8,10,64,8,Blocks.STONE_BRICKS);
		for (int y=66;y<=70;y++) {
			p.fill(-10,y,-8,10,y,-8,ModBlocks.PLASTER_PANEL);
			p.fill(-10,y,8,10,y,8,ModBlocks.PLASTER_PANEL);
			p.fill(-10,y,-8,-10,y,8,ModBlocks.PLASTER_PANEL);
			p.fill(10,y,-8,10,y,8,ModBlocks.PLASTER_PANEL);
		}
		for(int x : new int[]{-10,-5,5,10}) for(int z : new int[]{-8,8}) p.fill(x,66,z,x,70,z,Blocks.STRIPPED_SPRUCE_LOG);
		for(int x : new int[]{-10,10}) for(int z : new int[]{-4,0,4}) p.fill(x,66,z,x,70,z,Blocks.STRIPPED_SPRUCE_LOG);
		for(int x : new int[]{-8,-3,3,7}) for(int z : new int[]{-8,8}) p.fill(x,67,z,x+1,69,z,Blocks.GLASS_PANE);
		for(int x : new int[]{-10,10}) for(int z : new int[]{-6,-2,2,6}) p.fill(x,67,z,x,69,z+1,Blocks.GLASS_PANE);
		p.fill(-1,66,8,1,68,8,Blocks.AIR);
		// Full gables support a steep, overhanging slate roof.
		for(int x=-10;x<=10;x++) {
			int roof=81-Math.abs(x);
			for(int z : new int[]{-8,8}) p.fill(x,71,z,x,roof-1,z,Blocks.SPRUCE_PLANKS);
		}
		for(int x=-11;x<=11;x++) for(int z=-10;z<=10;z++) {
			int roof=81-Math.abs(x);
			p.set(x,roof,z,x == 0 ? Blocks.DEEPSLATE_TILES.defaultBlockState()
				: St.stairs(Blocks.DEEPSLATE_TILE_STAIRS,x<0?Direction.EAST:Direction.WEST,false));
		}
		p.fill(-3,65,9,3,65,11,Blocks.SPRUCE_PLANKS);
		for(int x=-2;x<=2;x++) p.set(x,65,12,St.stairs(Blocks.SPRUCE_STAIRS,Direction.NORTH,false));
		for(int x : new int[]{-3,3}) { p.fill(x,66,11,x,69,11,Blocks.SPRUCE_FENCE); p.set(x,70,11,Blocks.LANTERN); }
		p.fill(-3,70,9,3,70,11,Blocks.SPRUCE_SLAB);
		for(int x : new int[]{-6,0,6}) { p.fill(x,70,-7,x,70,7,Blocks.DARK_OAK_LOG); p.set(x,69,0,St.lantern(Blocks.LANTERN,true)); }
		// Desk at the back, with one monitor and a seat.
		p.fill(-2,66,-6,2,66,-6,St.slab(Blocks.DARK_OAK_SLAB,true));
		p.set(0,67,-6,ModBlocks.MONITOR.defaultBlockState().setValue(PanelBlock.FACING,Direction.SOUTH).setValue(MonitorBlock.LIT,true));
		p.bind(0,67,-6,"marlow");
		p.set(0,66,-4,St.stairs(Blocks.DARK_OAK_STAIRS,Direction.SOUTH,false));
		p.set(-2,67,-6,Blocks.POTTED_FERN); p.set(2,67,-6,Blocks.LANTERN);
		for(String id : Cast.ids()) {
			a.spot(AnchorNames.desk(id),0,66,-4,180);
			a.put(AnchorNames.monitor(id),.5,67.5,-5.75,0,0);
		}
		for(int z=-6;z<=-3;z++) {
			p.fill(-9,66,z,-9,68,z,Blocks.BOOKSHELF);
			p.set(-9,66,z,ModBlocks.MEMORY_ARCHIVE.defaultBlockState().setValue(FacingEntityBlock.FACING,Direction.EAST));
			p.bind(-9,66,z,"shared");
		}
		p.set(-9,66,-2,ModBlocks.MEMORY_CATALOG.defaultBlockState().setValue(HorizontalDirectionalBlock.FACING,Direction.EAST));
		a.spot(AnchorNames.LIBRARY,-7,66,-4,90);
		for(int z=-1;z<=5;z++) for(int y=67;y<=70;y++) p.set(-9,y,z,ModBlocks.TASK_BOARD.defaultBlockState().setValue(PanelBlock.FACING,Direction.EAST));
		a.put(AnchorNames.TASK_WALL,-8.873,69,2.5,-90,0);
		p.set(9,66,-5,ModBlocks.CONSOLE_TERMINAL.defaultBlockState().setValue(FacingEntityBlock.FACING,Direction.WEST));
		a.spot(AnchorNames.TERMINAL,7,66,-5,-90);
		p.set(9,66,-2,Blocks.CRAFTING_TABLE);
		p.set(9,67,-2,ModBlocks.STATUS_LAMP.defaultBlockState().setValue(StatusLampBlock.STATUS,LampStatus.IDLE));
		p.bind(9,67,-2,"agent:marlow");
		a.spot(AnchorNames.TESTBENCH,7,66,-2,-90);
		p.set(9,66,1,ModBlocks.MERGE_STATION.defaultBlockState().setValue(FacingEntityBlock.FACING,Direction.WEST));
		a.spot(AnchorNames.MERGESTATION,7,66,1,-90);
		p.set(4,66,4,St.slab(Blocks.DARK_OAK_SLAB,true));
		p.set(4,67,4,Blocks.LANTERN);
		p.set(4,66,3,St.stairs(Blocks.SPRUCE_STAIRS,Direction.NORTH,false));
		a.spot(AnchorNames.MEETING,4,66,3,0);
		p.set(-4,66,6,St.stairs(Blocks.DARK_OAK_STAIRS,Direction.SOUTH,false));
		p.set(-5,66,6,Blocks.POTTED_AZALEA);
		a.spot(AnchorNames.LOUNGE,-4,66,6,180);
		p.set(2,66,6,ModBlocks.DECISION_PODIUM.defaultBlockState().setValue(FacingEntityBlock.FACING,Direction.NORTH));
		a.put(AnchorNames.DECISION_PODIUM,2.5,66.95,6.5,180,0);
		a.spot(AnchorNames.USER,0,66,5,180);
		p.set(0,65,0,ModBlocks.GLOW_PANEL); a.put(AnchorNames.GOAL_ATRIUM,.5,66,.5,180,0);
		a.spot(AnchorNames.ENTRANCE,0,66,7,180); a.spot(AnchorNames.SPAWN,0,66,10,180);
		a.bounds(-9,65,-7,9,73,11);
		a.cameraLookAt("exterior_hero",22,78,27,0,70,0);
		a.cameraLookAt("hall",0,69,7,0,68,-4);
		a.cameraLookAt("task_wall",-2,70,4,-9,69,3);
		p.settleGrass(); p=p.transformed(site.transform());
		var previous=PlanStore.load(level.getServer(),ID,p.box(),p.size());
		var stats=p.apply(level,previous,options.force());
		PlanStore.save(level.getServer(),ID,p.box(),p.cells());
		a.transform(site.transform()); site.save(level);
		return (stats.changed()+stats.connected())+" blocks updated; kept "+stats.kept()+" player edits";
	}
}
