package dev.agentcraft.hq;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.TreeSet;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.datafix.DataFixTypes;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructurePlaceSettings;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import net.minecraft.world.level.levelgen.structure.templatesystem.LiquidSettings;

/** User-owned schematics stay outside the mod JAR and do not change agent workstations. */
final class ImportedBuildings {
	private record Cached(long modified,long bytes,StructureTemplate template) {}
	private static final java.util.Map<Path,Cached> cache=new java.util.LinkedHashMap<>();
	static void clear() { cache.clear(); }
	static Path directory() { return FabricLoader.getInstance().getConfigDir().resolve("agentcraft/buildings"); }
	static boolean validId(String id) { return id.matches("[a-z0-9][a-z0-9_-]{0,63}") && !id.equals("studio") && !id.equals("cabin"); }
	static List<String> ids() {
		var ids=new TreeSet<String>();
		if(Files.isDirectory(directory())) try(var files=Files.list(directory())) {
			files.filter(p -> Files.isRegularFile(p) && p.getFileName().toString().endsWith(".schem")).forEach(p -> {
				String name=p.getFileName().toString(); String id=name.substring(0,name.length()-6);
				if(validId(id)) ids.add(id);
			});
		} catch(java.io.IOException e) { dev.agentcraft.AgentCraft.LOGGER.warn("Cannot list building schematics", e); }
		return List.copyOf(ids);
	}
	static StructureTemplate load(MinecraftServer server,String id) throws Exception {
		if(!validId(id)) throw new IllegalArgumentException("Неизвестная постройка. Варианты подскажет Tab.");
		Path file=directory().resolve(id+".schem");
		if(!Files.isRegularFile(file)) throw new IllegalArgumentException("Нет схемы "+id+".schem в config/agentcraft/buildings.");
		long modified=Files.getLastModifiedTime(file).toMillis(), bytes=Files.size(file);
		var cached=cache.get(file);
		if(cached!=null && cached.modified()==modified && cached.bytes()==bytes) return cached.template();
		var raw=SchematicReader.read(file);
		if(raw.getIntOr("DataVersion",0)>net.minecraft.SharedConstants.getCurrentVersion().dataVersion().version())
			throw new IllegalArgumentException("Схема создана в более новой версии Minecraft.");
		var data=DataFixTypes.STRUCTURE.updateToCurrentVersion(server.getFixerUpper(),raw,raw.getIntOr("DataVersion",0));
		validatePalette(data);
		var template=new StructureTemplate(); template.load(BuiltInRegistries.BLOCK,data);
		if(cache.size()>=4) cache.clear();
		cache.put(file,new Cached(modified,bytes,template));
		return template;
	}
	static void validatePalette(CompoundTag data) throws Exception {
		// NbtUtils silently turns unknown blocks into air; reject them before any world mutation.
		for(var tag:data.getListOrEmpty("palette")) {
			if(!(tag instanceof CompoundTag state)) throw new IllegalArgumentException("Повреждена палитра схемы.");
			String name=state.getStringOr("id",""); var props=state.getCompoundOrEmpty("properties");
			if(name.endsWith("command_block")) throw new IllegalArgumentException("Импорт командных блоков не поддерживается.");
			StringBuilder text=new StringBuilder(name);
			if(!props.isEmpty()) {
				text.append('['); boolean first=true;
				for(String key:props.keySet()) { if(!first) text.append(','); first=false; text.append(key).append('=').append(props.getStringOr(key,"")); }
				text.append(']');
			}
			BlockStateParser.parseForBlock(BuiltInRegistries.BLOCK,text.toString(),false);
		}
	}
	static StructurePlaceSettings settings(StructureTemplate template,int turns) {
		var size=template.getSize();
		return new StructurePlaceSettings().setRotation(Rotation.values()[Math.floorMod(turns,4)])
			.setRotationPivot(new BlockPos(size.getX()/2,0,size.getZ()/2)).setIgnoreEntities(false)
			.setKnownShape(true).setLiquidSettings(LiquidSettings.IGNORE_WATERLOGGING);
	}
	static BlockPos origin(StructureTemplate template,BlockPos target) {
		return target.offset(-template.getSize().getX()/2,0,-template.getSize().getZ()/2);
	}
}
