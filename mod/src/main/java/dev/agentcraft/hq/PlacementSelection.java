package dev.agentcraft.hq;

import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import net.minecraft.core.BlockPos;

/** A confirmed preview survives its temporary outline, but never crosses worlds or players. */
final class PlacementSelection<W> {
	record Target(BlockPos block, int turns) {
		Target { block=block.immutable(); }
	}
	private record Site<W>(W world,String building,Target target,int[] box) {}
	private final Map<UUID,Site<W>> sites=new HashMap<>();

	Target resolve(UUID player,W world,String building,boolean preview,Supplier<Target> aim) {
		if(preview) return aim.get();
		var site=sites.get(player);
		if(site==null || site.world()!=world)
			throw new IllegalArgumentException("Сначала выбери место: /agentcraft preview "+building+". Затем отойди и выполни place без наведения.");
		if(!site.building().equals(building))
			throw new IllegalArgumentException("Выбрано место для "+site.building()+". Для другого здания сначала выполни /agentcraft preview "+building+".");
		return site.target();
	}
	void remember(UUID player,W world,String building,Target target,int[] box) {
		sites.put(player,new Site<>(world,building,target,box.clone()));
	}
	void checkBounds(UUID player,int[] box) {
		var site=sites.get(player);
		if(site==null || !Arrays.equals(site.box(),box))
			throw new IllegalArgumentException("Размер постройки изменился. Выполни preview ещё раз.");
	}
	void forget(UUID player) { sites.remove(player); }
	void clear() { sites.clear(); }
}
