package dev.agentcraft.block.entity;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.ValueInput;
import net.minecraft.world.level.storage.ValueOutput;
import org.jspecify.annotations.Nullable;

/** Status lamp. Binding: "agent:ID", "ci:REPO" or "goal". The client drives the lamp status and particles (hq.StatusLampRenderer). */
public class StatusLampBlockEntity extends StationBlockEntity {
	private @Nullable Boolean hologram;

	public StatusLampBlockEntity(BlockPos pos, BlockState state) {
		super(ModBlockEntities.STATUS_LAMP, pos, state);
	}

	/** Old atrium projectors stay on; ordinary lamps opt in independently of their binding. */
	public boolean hologramEnabled() {
		return hologram != null ? hologram : "goal:atrium".equals(binding());
	}

	public void toggleHologram() {
		hologram = !hologramEnabled();
		changed();
	}

	@Override
	protected void loadAdditional(ValueInput input) {
		super.loadAdditional(input);
		hologram = input.read("hologram", com.mojang.serialization.Codec.BOOL).orElse(null);
	}

	@Override
	protected void saveAdditional(ValueOutput output) {
		super.saveAdditional(output);
		if (hologram != null) output.putBoolean("hologram", hologram);
	}
}
