package dev.agentcraft.hq;

import com.google.gson.Gson;
import dev.agentcraft.layout.Anchors;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.storage.LevelResource;

/** Keep old HQ sites intact when a player places another active building. */
final class PlacedSites {
	private record Entry(String building,int[] box) {}
	private static Path file(ServerLevel level) { return level.getServer().getWorldPath(LevelResource.ROOT).resolve("agentcraft-sites.json"); }
	private static List<Entry> read(ServerLevel level) throws Exception {
		List<Entry> entries=new ArrayList<>();
		if(Files.exists(file(level))) entries.addAll(List.of(new Gson().fromJson(Files.readString(file(level)),Entry[].class)));
		Path plan=file(level).resolveSibling(PlanStore.FILE);
		if(Files.exists(plan)) {
			var data=NbtIo.readCompressed(plan,NbtAccounter.unlimitedHeap());
			int[] box=data.getIntArray("box").orElse(new int[0]);
			if(box.length==6 && entries.stream().noneMatch(e -> Arrays.equals(e.box(),box))) entries.add(new Entry(data.getStringOr("builder","studio"),box));
		}
		return entries;
	}
	static void check(ServerLevel level,String id,int[] box) throws Exception {
		var entries=read(level);
		Path activePlan=file(level).resolveSibling(PlanStore.FILE);
		int[] activeBox=Files.exists(activePlan)?NbtIo.readCompressed(activePlan,NbtAccounter.unlimitedHeap()).getIntArray("box").orElse(new int[0]):new int[0];
		for(var e:entries) if(intersects(box,e.box())) {
			if(Arrays.equals(box,activeBox) && Arrays.equals(box,e.box()) && e.building().equals(id) && Anchors.current().name().equals(id)) continue;
			throw new IllegalArgumentException("Участок пересекает прежнее здание. Выбери место дальше; preview покажет размер участка.");
		}
		// Persist the old active site's box before its plan is replaced.
		write(level,entries);
	}
	static boolean intersects(int[] a,int[] b) { return a[0]<=b[3] && a[3]>=b[0] && a[1]<=b[4] && a[4]>=b[1] && a[2]<=b[5] && a[5]>=b[2]; }
	static void remember(ServerLevel level,String id,int[] box) throws Exception {
		var entries=read(level);
		if(entries.stream().noneMatch(e -> Arrays.equals(e.box(),box))) entries.add(new Entry(id,box));
		write(level,entries);
	}
	private static void write(ServerLevel level,List<Entry> entries) throws Exception {
		Path f=file(level),temp=f.resolveSibling("agentcraft-sites.json.tmp");
		Files.writeString(temp,new Gson().toJson(entries)+"\n"); Files.move(temp,f,StandardCopyOption.REPLACE_EXISTING);
	}
}
