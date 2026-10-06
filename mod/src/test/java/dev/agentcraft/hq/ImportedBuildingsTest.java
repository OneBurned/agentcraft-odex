package dev.agentcraft.hq;

import java.nio.file.Path;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.util.datafix.DataFixTypes;
import net.minecraft.util.datafix.DataFixers;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import org.junit.Test;
import static org.junit.Assert.*;

public class ImportedBuildingsTest {
	@Test public void realSchematicsMigrateAndRotateAroundSelectedBlock() throws Exception {
		String dir=System.getProperty("agentcraft.testBuildings"); org.junit.Assume.assumeNotNull(dir);
		SharedConstants.tryDetectVersion(); Bootstrap.bootStrap();
		for(String id:new String[]{"modern-base","lakehouse","island"}) {
			var raw=SchematicReader.read(Path.of(dir,id+".schem"));
			if(id.equals("lakehouse")) {
				var frame=raw.getListOrEmpty("entities").getCompoundOrEmpty(0);
				assertEquals(SchematicReader.ints(8,10,10),frame.get("blockPos"));
				assertEquals(8.03125,frame.getListOrEmpty("pos").getDoubleOr(0,0),0.00001);
				assertEquals(10.5,frame.getListOrEmpty("pos").getDoubleOr(1,0),0.00001);
			}
			var updated=DataFixTypes.STRUCTURE.updateToCurrentVersion(DataFixers.getDataFixer(),raw,raw.getIntOr("DataVersion",0));
			ImportedBuildings.validatePalette(updated);
			var template=new StructureTemplate(); template.load(BuiltInRegistries.BLOCK,updated);
			var target=new BlockPos(123,80,-456); var origin=ImportedBuildings.origin(template,target);
			assertTrue(template.getSize().getY()>0);
			for(int turns=0;turns<4;turns++) {
				var settings=ImportedBuildings.settings(template,turns);
				assertEquals(target,StructureTemplate.calculateRelativePosition(settings,settings.getRotationPivot()).offset(origin));
				var box=template.getBoundingBox(settings,origin);
				assertEquals(80,box.minY()); assertEquals(template.getSize().getY(),box.maxY()-box.minY()+1);
				assertEquals(turns%2==0?template.getSize().getX():template.getSize().getZ(),box.maxX()-box.minX()+1);
			}
			var saved=template.save(new net.minecraft.nbt.CompoundTag());
			assertEquals(raw.getListOrEmpty("blocks").size(),saved.getListOrEmpty("blocks").size());
			assertEquals(raw.getListOrEmpty("entities").size(),saved.getListOrEmpty("entities").size());
			// Vanilla data version 4885 removes bed block entities; beds themselves remain blocks.
			long originalBlockEntities=raw.getListOrEmpty("blocks").compoundStream().filter(b->b.contains("nbt")
				&& !b.getCompoundOrEmpty("nbt").getStringOr("id","").equals("minecraft:bed")).count();
			assertEquals(originalBlockEntities,saved.getListOrEmpty("blocks").compoundStream().filter(b->b.contains("nbt")).count());
			System.out.println(id+": "+template.getSize()+", entities="+saved.getListOrEmpty("entities").size());
		}
	}
}
