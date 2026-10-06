package dev.agentcraft.workspace;

import java.util.function.Consumer;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;
import net.minecraft.network.chat.Component;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.TooltipFlag;
import net.minecraft.world.item.component.TooltipDisplay;
import net.minecraft.world.level.Level;

public final class ConfiguratorItem extends Item {
	/** Client-only personal assignments consume the click before vanilla sends it to the server. */
	public interface ClientActions {
		InteractionResult use(Player player, @Nullable BlockPos clicked);
		void tooltip(Consumer<Component> lines);
	}
	public static @Nullable ClientActions clientActions;
	public static InteractionResult useOnClient(Player player, @Nullable BlockPos clicked) {
		return clientActions == null ? InteractionResult.SUCCESS : clientActions.use(player, clicked);
	}
	public ConfiguratorItem(Properties properties) { super(properties); }
	@Override public InteractionResult use(Level level, Player player, InteractionHand hand) {
		if (level.isClientSide()) return useOnClient(player, null);
		if (!level.isClientSide()) ManualWorkspace.cycleOrHelp(player);
		return InteractionResult.SUCCESS;
	}
	@Override public void appendHoverText(ItemStack stack, TooltipContext context, TooltipDisplay display, Consumer<Component> lines, TooltipFlag flag) {
		if (clientActions != null) { clientActions.tooltip(lines); return; }
		lines.accept(Component.literal("ПКМ по агенту: выбрать, кому назначать места"));
		lines.accept(Component.literal("Shift + ПКМ: выбрать зону"));
		lines.accept(Component.literal("ПКМ по полу или креслу: отметить место Codex"));
		lines.accept(Component.literal("Сначала отметь рабочее место. Остальные зоны необязательны."));
	}
}
