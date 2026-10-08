package dev.agentcraft.client.mixin;

import com.mojang.blaze3d.platform.NativeImage;
import net.minecraft.client.renderer.texture.SkinTextureDownloader;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

/** Reuse Minecraft's legacy limb mirroring and transparency handling. */
@Mixin(SkinTextureDownloader.class)
public interface SkinTextureDownloaderInvoker {
	@Invoker("processLegacySkin")
	static NativeImage agentcraft$processLegacySkin(NativeImage image, String source) {
		throw new AssertionError("Mixin not applied");
	}
}
