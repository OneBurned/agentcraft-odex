package dev.agentcraft.block;

import dev.agentcraft.block.entity.StatusLampBlockEntity;
import dev.agentcraft.workspace.ConfiguratorItem;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.minecraft.network.chat.Component;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.BaseEntityBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.StateDefinition;
import net.minecraft.world.level.block.state.properties.EnumProperty;

/**
 * CI / agent status lamp. The {@code status} property selects the lit texture; its block entity
 * carries a binding ("agent:kit", "ci:REPO", "goal") that tells the client which state to show.
 */
public class StatusLampBlock extends BaseEntityBlock {
	public static final EnumProperty<LampStatus> STATUS = EnumProperty.create("status", LampStatus.class);

	public static void initInteractions() {
		UseBlockCallback.EVENT.register((player, level, hand, hit) -> {
			if (player.isSpectator() || player.isSecondaryUseActive() || hand != InteractionHand.MAIN_HAND
				|| player.getItemInHand(hand).getItem() instanceof ConfiguratorItem
				|| !(level.getBlockEntity(hit.getBlockPos()) instanceof StatusLampBlockEntity lamp)) {
				return InteractionResult.PASS;
			}
			if (!level.isClientSide()) {
				lamp.toggleHologram();
				((net.minecraft.server.level.ServerPlayer) player).sendSystemMessage(
					Component.literal("Голограмма: " + (lamp.hologramEnabled() ? "вкл." : "выкл.")), true);
			}
			return InteractionResult.SUCCESS;
		});
	}

	public StatusLampBlock(BlockBehaviour.Properties properties) {
		super(properties);
		this.registerDefaultState(this.stateDefinition.any().setValue(STATUS, LampStatus.OFF));
	}

	@Override
	protected void createBlockStateDefinition(StateDefinition.Builder<Block, BlockState> builder) {
		builder.add(STATUS);
	}

	@Override
	public BlockEntity newBlockEntity(BlockPos pos, BlockState state) {
		return new StatusLampBlockEntity(pos, state);
	}

	public static int light(BlockState state) {
		return state.getValue(STATUS) == LampStatus.OFF ? 0 : 12;
	}
}
