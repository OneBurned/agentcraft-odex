import dev.agentcraft.client.agents.AgentSkins;
import java.awt.image.BufferedImage;
import java.nio.file.*;
import java.util.Arrays;
import javax.imageio.ImageIO;

/** Run with the distributable JAR first on the game runtime classpath; no Minecraft window. */
class PortableSkinCheck {
    public static void main(String[] args) throws Exception {
        Path jar = Path.of(args[0]).toRealPath();
        Path loaded = Path.of(AgentSkins.class.getProtectionDomain().getCodeSource().getLocation().toURI()).toRealPath();
        if (!jar.equals(loaded)) throw new AssertionError("Importer was not loaded from the package");
        Path root = Files.createTempDirectory("agentcraft-png-package-");
        Path source = root.resolve("skin.png"), target = root.resolve("game/config/agentcraft-skins");
        ImageIO.write(new BufferedImage(64, 64, BufferedImage.TYPE_INT_ARGB), "png", source.toFile());
        byte[] expected = Files.readAllBytes(source);
        String name = AgentSkins.importPng(source.toString(), target);
        if (!name.matches("[a-f0-9]{64}\\.png") || !Arrays.equals(expected, Files.readAllBytes(target.resolve(name)))) throw new AssertionError("PNG copy or filename changed");
        Files.delete(source);
        if (!Files.isRegularFile(target.resolve(name))) throw new AssertionError("Imported PNG depends on original");
        for (int height : new int[]{32, 65}) {
            ImageIO.write(new BufferedImage(64, height, BufferedImage.TYPE_INT_ARGB), "png", source.toFile());
            reject(source, target);
        }
        Files.write(source, new byte[524289]); reject(source, target);
        Files.writeString(source, "not an image"); reject(source, target);
        System.out.println("Packaged PNG importer: valid 64x64 copied; original removed; legacy, wrong size, oversized and invalid input rejected. Visual rendering not tested.");
        // Remove only the explicitly created files, never a recursively computed directory.
        Files.delete(source); Files.delete(target.resolve(name)); Files.delete(target);
        Files.delete(root.resolve("game/config")); Files.delete(root.resolve("game")); Files.delete(root);
    }
    private static void reject(Path source, Path target) throws Exception {
        try { AgentSkins.importPng(source.toString(), target); }
        catch (Exception expected) { return; }
        throw new AssertionError("Invalid PNG accepted");
    }
}
