package dev.agentcraft.client;

import dev.agentcraft.AgentCraft;
import dev.agentcraft.world.HqWorld;
import dev.agentcraft.world.WorldSettings;
import java.util.List;
import java.util.Optional;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.minecraft.client.Minecraft;
import dev.agentcraft.client.mixin.BackupConfirmScreenAccessor;
import net.minecraft.client.gui.screens.AccessibilityOnboardingScreen;
import net.minecraft.client.gui.screens.BackupConfirmScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.HolderSet;
import net.minecraft.core.registries.Registries;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.biome.Biomes;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.levelgen.FlatLevelSource;
import net.minecraft.world.level.levelgen.WorldDimensions;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.flat.FlatLayerInfo;
import net.minecraft.world.level.levelgen.flat.FlatLevelGeneratorSettings;
import net.minecraft.world.level.levelgen.presets.WorldPresets;

/**
 * Opens the configured world, or creates it with WorldSettings when the save does not exist.
 * Without a settings file the legacy flat AgentCraft HQ is used. Disable with AGENTCRAFT_AUTOWORLD=0.
 */
public final class AutoWorld {
	private static boolean attempted;
	/** True while AutoWorld itself is opening the HQ world (so its confirm screens may be auto-answered). */
	private static boolean openingHq;

	private AutoWorld() {
	}

	public static void init() {
		if (!ClientEnv.AUTO_WORLD) {
			AgentCraft.LOGGER.info("AutoWorld disabled (AGENTCRAFT_AUTOWORLD=0)");
			return;
		}
		ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> openingHq = false);
		ScreenEvents.AFTER_INIT.register((client, screen, w, h) -> {
			if (openingHq && screen instanceof BackupConfirmScreen backup) {
				// Registry content changed since the HQ world was saved (a block/entity was renamed or removed
				// while developing). The HQ world is generated, so take Fabric's backup and load it instead of
				// waiting forever on "Missing content detected!" in an unattended run.
				openingHq = false;
				AgentCraft.LOGGER.warn("AutoWorld: '{}' needs confirmation ({}); making a backup and loading it",
					HqWorld.LEVEL_NAME, screen.getTitle().getString());
				client.execute(() -> ((BackupConfirmScreenAccessor) backup).agentcraft$onProceed().proceed(true, false));
				return;
			}
			if (attempted) {
				return;
			}
			if (screen instanceof TitleScreen || screen instanceof AccessibilityOnboardingScreen) {
				attempted = true;
				// Never switch screens from inside another screen's init.
				client.execute(() -> openOrCreate(client));
			}
		});
	}

	public static void openOrCreate(Minecraft mc) {
		try {
			if (mc.getLevelSource().levelExists(HqWorld.LEVEL_NAME)) {
				AgentCraft.LOGGER.info("AutoWorld: loading existing world '{}'", HqWorld.LEVEL_NAME);
				openingHq = true;
				mc.createWorldOpenFlows().openWorld(HqWorld.LEVEL_NAME, () -> mc.gui.setScreen(new TitleScreen()));
			} else {
				AgentCraft.LOGGER.info("AutoWorld: creating world '{}'", HqWorld.LEVEL_NAME);
				WorldSettings config = WorldSettings.current();
				LevelSettings settings = new LevelSettings(
					HqWorld.LEVEL_NAME,
					GameType.valueOf(config.gameMode().toUpperCase(java.util.Locale.ROOT)),
					new LevelSettings.DifficultySettings(Difficulty.valueOf(config.difficulty().toUpperCase(java.util.Locale.ROOT)), false, false),
					true,
					WorldDataConfiguration.DEFAULT
				);
				long seed;
				if (config.seed().isBlank()) seed = WorldOptions.randomSeed();
				else {
					try { seed = Long.parseLong(config.seed()); }
					catch (NumberFormatException ignored) { seed = config.seed().hashCode(); }
				}
				WorldOptions options = new WorldOptions(seed, config.type().equals("normal"), false);
				mc.createWorldOpenFlows().createFreshLevel(HqWorld.LEVEL_NAME, settings, options,
					config.type().equals("normal") ? WorldPresets::createNormalWorldDimensions : AutoWorld::meadowDimensions, new TitleScreen());
			}
		} catch (Exception e) {
			AgentCraft.LOGGER.error("AutoWorld failed; staying on the title screen", e);
			mc.gui.setScreen(new TitleScreen());
		}
	}

	/** Normal dimensions, with the overworld replaced by a flat plains meadow (grass top at y=64). */
	private static WorldDimensions meadowDimensions(HolderLookup.Provider registries) {
		Holder<Biome> plains = registries.lookupOrThrow(Registries.BIOME).getOrThrow(Biomes.PLAINS);
		FlatLevelGeneratorSettings base = new FlatLevelGeneratorSettings(Optional.of(HolderSet.empty()), plains, List.of());
		// y=-64 bedrock, stone up to 60, dirt 61..63, grass 64.
		List<FlatLayerInfo> layers = List.of(
			new FlatLayerInfo(1, Blocks.BEDROCK),
			new FlatLayerInfo(124, Blocks.STONE),
			new FlatLayerInfo(3, Blocks.DIRT),
			new FlatLayerInfo(1, Blocks.GRASS_BLOCK)
		);
		FlatLevelGeneratorSettings flat = base.withBiomeAndLayers(layers, Optional.of(HolderSet.empty()), plains);
		return WorldPresets.createNormalWorldDimensions(registries).replaceOverworldGenerator(registries, new FlatLevelSource(flat));
	}
}
