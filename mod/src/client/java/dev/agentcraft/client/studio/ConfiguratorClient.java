package dev.agentcraft.client.studio;

import dev.agentcraft.client.agents.ClientAgentEntity;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.layout.Anchor;
import dev.agentcraft.workspace.ConfiguratorItem;
import dev.agentcraft.workspace.ManualWorkspace;
import dev.agentcraft.workspace.WorkspaceRole;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import org.jspecify.annotations.Nullable;

/** Local NPC selection; personal places use the command desk's existing per-world store. */
public final class ConfiguratorClient implements ConfiguratorItem.ClientActions {
    private static final ConfiguratorClient INSTANCE = new ConfiguratorClient();
    private @Nullable Object world;
    private @Nullable String agent;
    private String name = "";
    private WorkspaceRole role = WorkspaceRole.DESK;
    private boolean dance;
    private String replaceRestId;

    public static void init() { ConfiguratorItem.clientActions = INSTANCE; }

    private static void message(Component text, boolean overlay) {
        var player = Minecraft.getInstance().player;
        if (player == null) return;
        if (overlay) player.sendOverlayMessage(text); else player.sendSystemMessage(text);
    }

    private void checkWorld() {
        Object now = Minecraft.getInstance().level;
        if (world != now) { world = now; agent = null; name = ""; role = WorkspaceRole.DESK; dance = false; replaceRestId = null; }
    }
    public static void restPlacement(String id, boolean dance, String replaceId) {
        var mc = Minecraft.getInstance();
        if (mc.player == null || !mc.player.isCreative() || mc.getSingleplayerServer() == null)
            throw new IllegalStateException("Нужен творческий режим одиночной игры.");
        INSTANCE.checkWorld(); INSTANCE.agent = id; INSTANCE.name = id;
        INSTANCE.role = WorkspaceRole.LOUNGE; INSTANCE.dance = dance; INSTANCE.replaceRestId = replaceId;
        mc.gui.setScreen(null);
        message(Component.literal(INSTANCE.label() + ". Возьми Настройщик и нажми ПКМ "
            + (dance ? "по цепи или забору." : "по новому полу или креслу.")), false);
    }

    public static void select(Player player, ClientAgentEntity entity) {
        INSTANCE.checkWorld();
        if (Minecraft.getInstance().getSingleplayerServer() == null || !player.isCreative()) {
            message(Component.literal("Выбор рабочих мест доступен в творческом режиме одиночной игры."), false);
            return;
        }
        if (player.isSecondaryUseActive()) {
            INSTANCE.agent = null;
            INSTANCE.replaceRestId = null;
            message(Component.literal("Настройщик: общие места. ПКМ по агенту — выбрать его."), false);
            return;
        }
        INSTANCE.agent = entity.agentId();
        INSTANCE.replaceRestId = null;
        INSTANCE.name = entity.view().name;
        message(Component.literal(INSTANCE.label() + ". ПКМ по полу/креслу — назначить; Shift+ПКМ — следующая зона."), false);
    }

    private String label() {
        if (agent == null) return "Настройщик: общие места";
        var current = Foreman.state().agents().get(agent);
        if (current != null) name = current.name();
        return name + " · " + (dance ? "Отдых: танцы у шеста" : role.label);
    }

    @Override public InteractionResult use(Player player, @Nullable BlockPos clicked) {
        checkWorld();
        // Preserve the original server-owned workflow until an NPC is selected.
        if (agent == null) return InteractionResult.SUCCESS;
        try {
            if (Minecraft.getInstance().getSingleplayerServer() == null || !player.isCreative())
                throw new IllegalStateException("Настройка мест доступна в творческом режиме одиночной игры.");
            if (player.isSecondaryUseActive()) {
                replaceRestId = null;
                if (role == WorkspaceRole.LOUNGE && !dance) dance = true;
                else { dance = false; role = role.next(); }
                message(Component.literal(label()), true);
            } else if (clicked == null) {
                message(Component.literal(label() + (dance ? ". Наведи прицел на цепь или забор." : ". Наведи прицел на пол или кресло.")), true);
            } else {
                if (dance) {
                    StudioPreferences.get().addRest(agent, true, RestDirector.pole(Minecraft.getInstance().level, clicked), replaceRestId);
                    replaceRestId = null;
                    message(Component.literal("Добавлено: " + label()), false);
                    return InteractionResult.FAIL;
                }
                var spot = ManualWorkspace.placement(player, clicked);
                Anchor point = new Anchor("", spot.x() + 0.5, spot.y(), spot.z() + 0.5, spot.yaw(), 0);
                if (role == WorkspaceRole.LOUNGE) StudioPreferences.get().addRest(agent, false, point, replaceRestId);
                else StudioPreferences.get().markAt(agent, role.key, point);
                replaceRestId = null;
                message(Component.literal("Сохранено: " + label() + " · "
                    + new BlockPos(spot.x(), spot.y(), spot.z()).toShortString()), false);
            }
        } catch (RuntimeException e) {
            message(Component.literal(e.getMessage() == null ? "Не удалось назначить место" : e.getMessage()), false);
        }
        // Do not send a second click to the server: it would reassign the shared Codex workspace.
        return InteractionResult.FAIL;
    }

    @Override public void tooltip(Consumer<Component> lines) {
        checkWorld();
        lines.accept(Component.literal(label()));
        lines.accept(Component.literal("ПКМ по агенту: выбрать его"));
        lines.accept(Component.literal("Shift+ПКМ: следующая зона"));
        lines.accept(Component.literal("ПКМ по полу/креслу: назначить место"));
        lines.accept(Component.literal("Shift+ПКМ по агенту: вернуться к общим местам"));
        if (agent == null) lines.accept(Component.literal("Сначала отметь основное рабочее место."));
    }
}
