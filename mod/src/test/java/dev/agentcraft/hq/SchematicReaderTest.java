package dev.agentcraft.hq;

import net.minecraft.nbt.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class SchematicReaderTest {
	private CompoundTag fixture(int version) {
		var s=new CompoundTag(); s.putInt("Version",version); s.putInt("DataVersion",3955);
		s.putShort("Width",(short)2); s.putShort("Height",(short)2); s.putShort("Length",(short)3);
		var blocks=version==3?new CompoundTag():s;
		var palette=new CompoundTag(); palette.putInt("minecraft:air",0); palette.putInt("minecraft:stone",1);
		blocks.put("Palette",palette); blocks.putByteArray(version==3?"Data":"BlockData",new byte[]{0,1,0,1,0,1,1,0,1,0,1,0});
		if(version==3) { s.put("Blocks",blocks); var root=new CompoundTag(); root.put("Schematic",s); return root; }
		return s;
	}
	@Test public void v2AndV3UseXThenZThenYAndKeepAir() {
		for(int v:new int[]{2,3}) {
			var result=SchematicReader.convert(fixture(v)); var blocks=result.getListOrEmpty("blocks");
			assertEquals(12,blocks.size()); assertEquals(SchematicReader.ints(1,0,2),blocks.getCompoundOrEmpty(5).get("pos"));
			assertEquals(SchematicReader.ints(0,1,0),blocks.getCompoundOrEmpty(6).get("pos"));
			assertEquals(0,blocks.getCompoundOrEmpty(0).getIntOr("state",-1));
		}
	}
	@Test public void rejectsBrokenOrOversizedSchematicsBeforePlacement() {
		var s=fixture(2); s.putShort("Width",(short)-1);
		assertThrows(IllegalArgumentException.class,()->SchematicReader.convert(s));
		for(byte[] data:new byte[][]{{(byte)128},{2},{0,0},{(byte)255,(byte)255,(byte)255,(byte)255,(byte)127}})
			assertThrows(IllegalArgumentException.class,()->SchematicReader.decode(data,1,2));
	}
	@Test public void rejectsDuplicatePaletteAndOutOfBoundsBlockEntity() {
		var s=fixture(2); s.getCompoundOrEmpty("Palette").putInt("minecraft:stone",0);
		assertThrows(IllegalArgumentException.class,()->SchematicReader.convert(s));
		var other=fixture(2); var entries=new ListTag(); var entry=new CompoundTag();
		entry.putIntArray("Pos",new int[]{2,0,0}); entry.putString("Id","minecraft:chest"); entries.add(entry); other.put("BlockEntities",entries);
		assertThrows(IllegalArgumentException.class,()->SchematicReader.convert(other));
	}
	@Test public void keepsBlockEntityDataAndLocalizesHangingEntityAnchor() {
		var root=fixture(3); var s=root.getCompoundOrEmpty("Schematic");
		var entry=new CompoundTag(); entry.putString("Id","minecraft:item_frame"); var pos=new ListTag();
		for(double d:new double[]{1.03125,1.5,1.5}) pos.add(DoubleTag.valueOf(d)); entry.put("Pos",pos);
		var data=new CompoundTag(); var oldPos=new ListTag();
		for(double d:new double[]{101.03125,11.5,201.5}) oldPos.add(DoubleTag.valueOf(d)); data.put("Pos",oldPos);
		data.putInt("TileX",101); data.putInt("TileY",11); data.putInt("TileZ",201); data.putInt("Facing",5); entry.put("Data",data);
		var entities=new ListTag(); entities.add(entry); s.put("Entities",entities);
		var be=new CompoundTag(); be.putString("Id","minecraft:chest"); be.putIntArray("Pos",new int[]{1,0,2});
		var contents=new CompoundTag(); contents.putString("CustomName","example"); be.put("Data",contents);
		var bes=new ListTag(); bes.add(be); s.getCompoundOrEmpty("Blocks").put("BlockEntities",bes);
		var converted=SchematicReader.convert(root);
		assertEquals(SchematicReader.ints(1,1,1),converted.getListOrEmpty("entities").getCompoundOrEmpty(0).get("blockPos"));
		assertEquals("example",converted.getListOrEmpty("blocks").getCompoundOrEmpty(5).getCompoundOrEmpty("nbt").getStringOr("CustomName",""));
	}
	@Test public void legacyGrassAndPathValidation() {
		assertEquals("minecraft:short_grass",SchematicReader.stateTag("minecraft:grass").getStringOr("Name",""));
		assertFalse(ImportedBuildings.validId("../secret")); assertFalse(ImportedBuildings.validId("studio")); assertTrue(ImportedBuildings.validId("modern-base"));
	}
	@Test public void currentDataVersionUsesCurrentVanillaPaletteFields() {
		var s=fixture(2); s.putInt("DataVersion",5006);
		var palette=SchematicReader.convert(s).getListOrEmpty("palette");
		assertEquals("minecraft:stone",palette.getCompoundOrEmpty(1).getStringOr("id",""));
		assertFalse(palette.getCompoundOrEmpty(1).contains("Name"));
	}
}
