package dev.agentcraft.hq;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.nbt.*;

/** Converts bounded Sponge v2/v3 data to vanilla structure NBT before Minecraft's data fixer. */
final class SchematicReader {
	static final int MAX_CELLS = 1_000_000;
	static CompoundTag read(Path path) throws IOException {
		if (Files.size(path) > 16 * 1024 * 1024) throw invalid("файл больше 16 МБ");
		return convert(NbtIo.readCompressed(path, NbtAccounter.create(128L * 1024 * 1024)));
	}
	static CompoundTag convert(CompoundTag root) {
		var s = root.contains("Schematic") ? root.getCompoundOrEmpty("Schematic") : root;
		int version = s.getIntOr("Version", 0), dataVersion = s.getIntOr("DataVersion", 0);
		if ((version != 2 && version != 3) || dataVersion <= 0) throw invalid("нужна Sponge .schem v2/v3 с DataVersion");
		int w = Short.toUnsignedInt(s.getShortOr("Width", (short)0));
		int h = Short.toUnsignedInt(s.getShortOr("Height", (short)0));
		int l = Short.toUnsignedInt(s.getShortOr("Length", (short)0));
		if (w < 1 || h < 1 || l < 1 || w > 256 || h > 384 || l > 256 || (long)w*h*l > MAX_CELLS)
			throw invalid("размер должен быть до 256×384×256 и 1 000 000 ячеек");
		var blocks = version == 3 ? s.getCompoundOrEmpty("Blocks") : s;
		var sourcePalette = blocks.getCompoundOrEmpty("Palette");
		if (sourcePalette.isEmpty() || sourcePalette.size() > 65536) throw invalid("неверная палитра");
		CompoundTag[] palette = new CompoundTag[sourcePalette.size()];
		for (String state : sourcePalette.keySet()) {
			int id = sourcePalette.getIntOr(state, -1);
			if (id < 0 || id >= palette.length || palette[id] != null) throw invalid("неверный индекс палитры");
			palette[id] = stateTag(state);
			// Vanilla's structure palette field names changed in data version 5006.
			if(dataVersion>=5006) {
				palette[id].put("id",palette[id].get("Name")); palette[id].remove("Name");
				if(palette[id].contains("Properties")) {
					palette[id].put("properties",palette[id].get("Properties")); palette[id].remove("Properties");
				}
			}
		}
		int[] indices = decode(blocks.getByteArray(version == 3 ? "Data" : "BlockData").orElseThrow(() -> invalid("нет блоков")), w*h*l, palette.length);
		Map<Integer, CompoundTag> blockEntities = new HashMap<>();
		for (Tag item : blocks.getListOrEmpty("BlockEntities")) {
			if (!(item instanceof CompoundTag entry)) throw invalid("неверные данные блока");
			int[] p = entry.getIntArray("Pos").orElseThrow(() -> invalid("нет позиции блока"));
			if (p.length != 3 || p[0]<0 || p[0]>=w || p[1]<0 || p[1]>=h || p[2]<0 || p[2]>=l) throw invalid("позиция блока вне схемы");
			var nbt = payload(entry, version);
			nbt.putInt("x", p[0]); nbt.putInt("y", p[1]); nbt.putInt("z", p[2]);
			if (blockEntities.put(p[0]+p[2]*w+p[1]*w*l, nbt) != null) throw invalid("повтор позиции блока");
		}
		var out = new CompoundTag(); var list = new ListTag(); var pal = new ListTag();
		for (var entry : palette) pal.add(entry);
		for (int i=0; i<indices.length; i++) {
			var entry = new CompoundTag();
			entry.put("pos", ints(i%w, i/(w*l), (i/w)%l)); entry.putInt("state", indices[i]);
			if (blockEntities.containsKey(i)) entry.put("nbt", blockEntities.get(i));
			list.add(entry);
		}
		var entities = new ListTag();
		int[] sourceMinimum=sourceMinimum(s,version);
		if (s.getListOrEmpty("Entities").size() > 4096) throw invalid("слишком много сущностей");
		for (Tag item : s.getListOrEmpty("Entities")) {
			if (!(item instanceof CompoundTag entry)) throw invalid("неверная сущность");
			var pos = entry.getListOrEmpty("Pos").copy();
			if (pos.size()!=3) throw invalid("нет позиции сущности");
			if(version==2 && sourceMinimum!=null) for(int axis=0;axis<3;axis++)
				pos.set(axis,DoubleTag.valueOf(pos.getDoubleOr(axis,Double.NaN)-sourceMinimum[axis]));
			double x=coordinate(pos,0,w), y=coordinate(pos,1,h), z=coordinate(pos,2,l);
			var nbt = payload(entry, version);
			// WorldEdit stores absolute hanging anchors in Data; vanilla structures need local anchors.
			var oldPos = nbt.getListOrEmpty("Pos");
			int bx=(int)Math.floor(x), by=(int)Math.floor(y), bz=(int)Math.floor(z);
			if (nbt.contains("TileX") && oldPos.size()==3) {
				if(sourceMinimum!=null) {
					bx=nbt.getIntOr("TileX",0)-sourceMinimum[0]; by=nbt.getIntOr("TileY",0)-sourceMinimum[1]; bz=nbt.getIntOr("TileZ",0)-sourceMinimum[2];
					// WorldEdit's hanging Location is the anchor, while Data.Pos is the exact visual position.
					for(int axis=0;axis<3;axis++) pos.set(axis,DoubleTag.valueOf(oldPos.getDoubleOr(axis,Double.NaN)-sourceMinimum[axis]));
					coordinate(pos,0,w); coordinate(pos,1,h); coordinate(pos,2,l);
				} else {
					bx=(int)Math.floor(x+nbt.getIntOr("TileX",0)-oldPos.getDoubleOr(0,x));
					by=(int)Math.floor(y+nbt.getIntOr("TileY",0)-oldPos.getDoubleOr(1,y));
					bz=(int)Math.floor(z+nbt.getIntOr("TileZ",0)-oldPos.getDoubleOr(2,z));
				}
				nbt.putInt("TileX",bx); nbt.putInt("TileY",by); nbt.putInt("TileZ",bz);
			} else if(nbt.contains("TileX") && sourceMinimum!=null) {
				bx=nbt.getIntOr("TileX",0)-sourceMinimum[0]; by=nbt.getIntOr("TileY",0)-sourceMinimum[1]; bz=nbt.getIntOr("TileZ",0)-sourceMinimum[2];
				nbt.putInt("TileX",bx); nbt.putInt("TileY",by); nbt.putInt("TileZ",bz);
			}
			nbt.put("Pos", pos.copy()); nbt.remove("UUID");
			var entity = new CompoundTag(); entity.put("pos",pos.copy()); entity.put("blockPos",ints(bx,by,bz)); entity.put("nbt",nbt);
			entities.add(entity);
		}
		out.putInt("DataVersion",dataVersion); out.put("size",ints(w,h,l)); out.put("palette",pal); out.put("blocks",list); out.put("entities",entities);
		return out;
	}
	private static int[] sourceMinimum(CompoundTag s,int version) {
		var metadata=s.getCompoundOrEmpty("Metadata"); var worldEdit=metadata.getCompoundOrEmpty("WorldEdit");
		int[] offset=s.getIntArray("Offset").orElse(new int[0]);
		if(offset.length!=3) return null;
		if(version==2 && (metadata.contains("WEOffsetX") || !worldEdit.isEmpty())) return offset;
		int[] origin=worldEdit.getIntArray("Origin").orElse(new int[0]);
		if(version==3 && origin.length==3) return new int[]{origin[0]+offset[0],origin[1]+offset[1],origin[2]+offset[2]};
		return null;
	}
	private static double coordinate(ListTag pos,int index,int limit) {
		double v=pos.getDoubleOr(index,Double.NaN);
		if (!Double.isFinite(v) || v < 0 || v >= limit) throw invalid("позиция сущности вне схемы");
		return v;
	}
	private static CompoundTag payload(CompoundTag entry,int version) {
		var data = version==3 ? entry.getCompoundOrEmpty("Data").copy() : entry.copy();
		String id=entry.getStringOr("Id", "");
		if (!id.matches("[a-z0-9_.-]+:[a-z0-9_/.-]+")) throw invalid("нет типа сущности/блока");
		if(id.equals("minecraft:command_block_minecart")) throw invalid("импорт командных вагонеток не поддерживается");
		data.remove("Id"); if(version==2) data.remove("Pos"); data.putString("id",id);
		return data;
	}
	static int[] decode(byte[] bytes,int count,int paletteSize) {
		int[] result=new int[count]; int cursor=0;
		for(int i=0;i<count;i++) {
			int value=0, shift=0, b;
			do {
				if(cursor>=bytes.length || shift>=28) throw invalid("повреждённые индексы блоков");
				b=bytes[cursor++]&255; value|=(b&127)<<shift; shift+=7;
			} while((b&128)!=0);
			if(value>=paletteSize) throw invalid("индекс блока отсутствует в палитре");
			result[i]=value;
		}
		if(cursor!=bytes.length) throw invalid("лишние индексы блоков");
		return result;
	}
	static CompoundTag stateTag(String text) {
		var result=new CompoundTag(); int bracket=text.indexOf('[');
		String name=bracket<0?text:text.substring(0,bracket);
		// Some exports report 1.21 DataVersion but still use this pre-1.20.3 name.
		if(name.equals("minecraft:grass")) name="minecraft:short_grass";
		if(!name.matches("[a-z0-9_.-]+:[a-z0-9_/.-]+")) throw invalid("неверное имя блока");
		result.putString("Name",name);
		if(bracket>=0) {
			if(!text.endsWith("]")) throw invalid("неверные свойства блока");
			var props=new CompoundTag();
			for(String pair:text.substring(bracket+1,text.length()-1).split(",")) {
				String[] parts=pair.split("=",-1);
				if(parts.length!=2 || !parts[0].matches("[a-z0-9_]+") || !parts[1].matches("[a-z0-9_-]+") || props.contains(parts[0])) throw invalid("неверные свойства блока");
				props.putString(parts[0],parts[1]);
			}
			result.put("Properties",props);
		}
		return result;
	}
	static ListTag ints(int... values) { var list=new ListTag(); for(int v:values) list.add(IntTag.valueOf(v)); return list; }
	private static IllegalArgumentException invalid(String message) { return new IllegalArgumentException("Схема: "+message+"."); }
}
