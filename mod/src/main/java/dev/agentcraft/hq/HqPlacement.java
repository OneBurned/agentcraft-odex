package dev.agentcraft.hq;

import com.google.gson.Gson;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.layout.AnchorNames;
import dev.agentcraft.layout.Anchors;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.levelgen.FlatLevelSource;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.storage.LevelResource;

/** Persisted translation: rebuilding never relocates the studio or depends on player edits. */
public record HqPlacement(int x, int y, int z, int bottom, int turns, int pivotZ) {
	HqPlacement(int x, int y, int z, int bottom) { this(x, y, z, bottom, 0, 0); }
	SiteTransform transform() { return new SiteTransform(x, y, z, turns, pivotZ); }
	void save(ServerLevel level) {
		Path file = level.getServer().getWorldPath(LevelResource.ROOT).resolve("agentcraft-site.json");
		try {
			Path temp = file.resolveSibling("agentcraft-site.json.tmp");
			Files.writeString(temp, new Gson().toJson(this) + "\n");
			Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING);
		} catch (Exception e) { throw new IllegalStateException("Cannot save studio site", e); }
	}
	static HqPlacement resolve(ServerLevel level, int localTop) {
		Path file = level.getServer().getWorldPath(LevelResource.ROOT).resolve("agentcraft-site.json");
		try {
			if (Files.exists(file)) {
				HqPlacement saved = new Gson().fromJson(Files.readString(file), HqPlacement.class);
				if (saved == null || saved.bottom() > 60 || saved.bottom() + saved.y() < level.getMinY()
					|| localTop + saved.y() >= level.getMaxY()) throw new IllegalArgumentException("Invalid studio site");
				return saved;
			}
			HqPlacement site;
			var spawn = Anchors.get(AnchorNames.SPAWN);
			if (spawn != null) {
				// Compatibility with saved studios from before terrain-aware placement.
				site = new HqPlacement((int) Math.round(spawn.x() - .5), (int) Math.round(spawn.y() - 66),
					(int) Math.round(spawn.z() - 22.5), 60);
			} else if (level.getChunkSource().getGenerator() instanceof FlatLevelSource) {
				site = new HqPlacement(0, 0, 0, 60);
			} else {
				site = findLand(level);
			}
			Path temp = file.resolveSibling("agentcraft-site.json.tmp");
			Files.writeString(temp, new Gson().toJson(site) + "\n");
			Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING);
			AgentCraft.LOGGER.info("Studio site: {}", site);
			return site;
		} catch (Exception e) {
			throw new IllegalStateException("Cannot select/read studio site " + file, e);
		}
	}

	private static HqPlacement findLand(ServerLevel level) {
		var generator = level.getChunkSource().getGenerator();
		var random = level.getChunkSource().randomState();
		HqPlacement best = null;
		int bestRange = Integer.MAX_VALUE;
		// Search outwards, without generating chunks or carving through mountains/ocean.
		for (int ring = 0; ring <= 8; ring++) {
			for (int gx = -ring; gx <= ring; gx++) for (int gz = -ring; gz <= ring; gz++) {
				if (Math.max(Math.abs(gx), Math.abs(gz)) != ring) continue;
				int x = gx * 160, z = gz * 160;
				int min = Integer.MAX_VALUE, max = Integer.MIN_VALUE;
				for (int dx : new int[] {-46, 0, 46}) for (int dz : new int[] {-36, 9, 54}) {
					int h = generator.getBaseHeight(x + dx, z + dz, Heightmap.Types.OCEAN_FLOOR_WG, level, random) - 1;
					min = Math.min(min, h);
					max = Math.max(max, h);
				}
				if (min < generator.getSeaLevel() || max + 40 >= level.getMaxY()) continue;
				int range = max - min;
				if (range < bestRange) {
					int dy = (min + max) / 2 - 64;
					best = new HqPlacement(x, dy, z, Math.max(level.getMinY() - dy, Math.min(60, min - 12 - dy)));
					bestRange = range;
				}
				if (bestRange <= 6) return best;
			}
		}
		if (best == null) throw new IllegalStateException("No dry studio site nearby; choose another world seed");
		return best;
	}
}
