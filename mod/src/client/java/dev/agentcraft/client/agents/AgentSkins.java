package dev.agentcraft.client.agents;

import dev.agentcraft.AgentCraft;
import dev.agentcraft.Cast;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.client.resources.DefaultPlayerSkin;
import net.minecraft.core.ClientAsset;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.PlayerModelType;
import net.minecraft.world.entity.player.PlayerSkin;

/**
 * Agent skins: {@code assets/agentcraft/textures/entity/agent/<skin>.png} (64x64 or legacy 64x32) with
 * the arm model from cast.json ({@code slim} = 3 px arms). Unknown skins fall back to a vanilla
 * default skin so a new Foreman agent still renders.
 */
public final class AgentSkins {
	private static final Map<String, PlayerSkin> CACHE = new HashMap<>();

	private AgentSkins() {
	}

	public static PlayerSkin get(String agentId, String skinId) {
		var look = dev.agentcraft.client.studio.StudioPreferences.get().look(agentId);
		return preview(agentId, skinId, look);
	}

    public static PlayerSkin get(dev.agentcraft.client.foreman.Protocol.Agent agent) {
        var look = dev.agentcraft.client.studio.StudioPreferences.get().look(agent.id()).copy();
        if (agent.slim() != null) look.slim = agent.slim();
        return preview(agent.id(), agent.skin(), look);
    }

	public static PlayerSkin preview(String agentId, String skinId, dev.agentcraft.client.studio.StudioPreferences.Look look) {
		return CACHE.computeIfAbsent(agentId + "|" + skinId + "|" + look.slim + "|" + look.png, k -> {
			PlayerSkin base = create(agentId, skinId);
			if (!look.png.isEmpty()) {
				try {
					java.nio.file.Path file = Minecraft.getInstance().gameDirectory.toPath().resolve("config/agentcraft-skins").resolve(look.png);
					if (!look.png.matches("[a-f0-9]{64}\\.png")) throw new IllegalArgumentException("Invalid skin file");
					var pixels = com.mojang.blaze3d.platform.NativeImage.read(java.nio.file.Files.readAllBytes(file));
					Identifier id = AgentCraft.id("studio/" + look.png);
					Minecraft.getInstance().getTextureManager().register(id, new net.minecraft.client.renderer.texture.DynamicTexture(() -> id.toString(), pixels));
					base = PlayerSkin.insecure(new ClientAsset.ResourceTexture(id, id), null, null, PlayerModelType.WIDE);
				} catch (Exception e) { AgentCraft.LOGGER.warn("Cannot load selected agent skin", e); }
			}
			return PlayerSkin.insecure(base.body(), base.cape(), base.elytra(), look.slim ? PlayerModelType.SLIM : PlayerModelType.WIDE);
		});
	}

	public static String importPng(String filename) throws Exception {
		return importPng(filename, Minecraft.getInstance().gameDirectory.toPath().resolve("config/agentcraft-skins"));
	}

	/** Same importer with an explicit destination, also exercised against the packaged JAR. */
	public static String importPng(String filename, java.nio.file.Path dir) throws Exception {
		var p = java.nio.file.Path.of(filename);
		if (java.nio.file.Files.size(p) > 524288) throw new IllegalArgumentException("PNG должен быть меньше 512 КБ");
		byte[] bytes = java.nio.file.Files.readAllBytes(p);
		try (var image = com.mojang.blaze3d.platform.NativeImage.read(bytes)) {
			if (image.getWidth() != 64 || image.getHeight() != 64) throw new IllegalArgumentException("Нужен скин PNG 64×64");
		}
		String name = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes)) + ".png";
		java.nio.file.Files.createDirectories(dir); java.nio.file.Files.write(dir.resolve(name), bytes);
		return name;
	}

	private static PlayerSkin create(String agentId, String skinId) {
		Identifier asset = AgentCraft.id("entity/agent/" + skinId);
		ClientAsset.ResourceTexture tex = new ClientAsset.ResourceTexture(asset);
		Cast.Member m = Cast.get(agentId);
		if (m == null) {
			m = Cast.get(skinId);
		}
		boolean exists = Minecraft.getInstance().getResourceManager().getResource(tex.texturePath()).isPresent();
		if (!exists) {
			AgentCraft.LOGGER.warn("No skin texture {} for agent {}; using a default skin", tex.texturePath(), agentId);
			return DefaultPlayerSkin.get(java.util.UUID.nameUUIDFromBytes(agentId.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
		}
		// Bundled legacy skins need the same conversion as downloaded player skins.
		// ResourceTexture alone would sample the missing left limbs from a 32-pixel image.
		try (var stream = Minecraft.getInstance().getResourceManager().open(tex.texturePath());
				var image = com.mojang.blaze3d.platform.NativeImage.read(stream)) {
			if (image.getWidth() == 64 && image.getHeight() == 32) {
				var converted = dev.agentcraft.client.mixin.SkinTextureDownloaderInvoker.agentcraft$processLegacySkin(image, skinId);
				Identifier id = AgentCraft.id("studio/legacy/" + skinId);
				Minecraft.getInstance().getTextureManager().register(id,
						new net.minecraft.client.renderer.texture.DynamicTexture(() -> id.toString(), converted));
				tex = new ClientAsset.ResourceTexture(id, id);
			}
		} catch (java.io.IOException e) {
			AgentCraft.LOGGER.warn("Cannot read bundled skin {}", skinId, e);
		}
		return PlayerSkin.insecure(tex, null, null, m != null && m.slim() ? PlayerModelType.SLIM : PlayerModelType.WIDE);
	}

	public static void clear() {
		CACHE.clear();
	}
}
