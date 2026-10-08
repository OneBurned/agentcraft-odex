package dev.agentcraft.workspace;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.block.entity.MonitorBlockEntity;
import dev.agentcraft.block.entity.StatusLampBlockEntity;
import dev.agentcraft.layout.AnchorNames;
import dev.agentcraft.layout.Anchors;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.fabricmc.fabric.api.event.player.UseItemCallback;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.storage.LevelResource;

/** Manual single-player workspaces in any overworld, without building or changing game rules. */
public final class ManualWorkspace {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
	private static WorkspaceData data = new WorkspaceData(false, Map.of());
	private static final Map<UUID, WorkspaceRole> selected = new HashMap<>();
	private static int ticks;
	private ManualWorkspace() {}
	private static Path file(MinecraftServer server) { return server.getWorldPath(LevelResource.ROOT).resolve("agentcraft-workspace.json"); }
	public static void init() {
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			data = new WorkspaceData(false, Map.of());
			if (server.isDedicatedServer() || !Files.exists(file(server))) return;
			try {
				WorkspaceData loaded = GSON.fromJson(Files.readString(file(server)), WorkspaceData.class);
				if (loaded == null) throw new IllegalArgumentException("Empty workspace file");
				data = loaded;
				if (data.active()) publish(server);
			} catch (Exception e) { AgentCraft.LOGGER.error("Cannot load manual workspace", e); }
		});
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> {
			data = new WorkspaceData(false, Map.of()); selected.clear();
		});
		ServerTickEvents.END_SERVER_TICK.register(server -> {
			if (data.active() && ++ticks % 20 == 0) bindNearby(server.overworld());
		});
		UseItemCallback.EVENT.register((player, level, hand) -> {
			if (level.isClientSide() && player.getItemInHand(hand).getItem() instanceof ConfiguratorItem)
				return ConfiguratorItem.useOnClient(player, null);
			return InteractionResult.PASS;
		});
		UseBlockCallback.EVENT.register((player, level, hand, hit) -> {
			if (!(player.getItemInHand(hand).getItem() instanceof ConfiguratorItem)) return InteractionResult.PASS;
			if (level.isClientSide()) return ConfiguratorItem.useOnClient(player, hit.getBlockPos());
			if (!level.isClientSide()) {
				if (player.isSecondaryUseActive()) cycleOrHelp(player);
				else assign((ServerPlayer)player, selected.getOrDefault(player.getUUID(),WorkspaceRole.DESK), hit.getBlockPos());
			}
			return InteractionResult.SUCCESS;
		});
	}
	public static void cycleOrHelp(Player player) {
		if(player.isSecondaryUseActive()) selected.put(player.getUUID(),selected.getOrDefault(player.getUUID(),WorkspaceRole.DESK).next());
		WorkspaceRole role=selected.getOrDefault(player.getUUID(),WorkspaceRole.DESK);
		((ServerPlayer)player).sendSystemMessage(Component.literal("Настройщик: "+role.label+". ПКМ по полу/креслу; Shift+ПКМ — следующая зона."),true);
	}
	private static boolean assign(ServerPlayer player,WorkspaceRole role,BlockPos clicked) {
		try {
			ServerLevel level=(ServerLevel)player.level();
			if(level.getServer().isDedicatedServer() || level.dimension()!=Level.OVERWORLD) throw new IllegalArgumentException("Рабочее место доступно в обычном измерении одиночной игры.");
			if(!player.isCreative()) throw new IllegalArgumentException("Для настройки рабочего места включи творческий режим.");
			var spot=placement(player,clicked);
			BlockPos feet=new BlockPos(spot.x(),spot.y(),spot.z());
			WorkspaceData base=data.active()?data:new WorkspaceData(false,Map.of());
			commit(level.getServer(),base.with(role,spot));
			selected.put(player.getUUID(),role);
			player.sendSystemMessage(Component.literal(role.label+": "+feet.toShortString()+". Агенты подключены; мониторы и индикаторы в пределах 32 блоков подключаются автоматически."),false);
			return true;
		} catch (Exception e) { player.sendSystemMessage(Component.literal(e.getMessage()==null?"Не удалось настроить рабочее место":e.getMessage()),false); return false; }
	}
	/** Shared floor/chair geometry for the original workspace and personal configurator places. */
	public static WorkspaceData.Spot placement(Player player, BlockPos clicked) {
		var level=player.level();
		if(level.dimension()!=Level.OVERWORLD) throw new IllegalArgumentException("Рабочее место доступно в обычном измерении.");
		if(!player.isCreative()) throw new IllegalArgumentException("Для настройки рабочего места включи творческий режим.");
		var state=level.getBlockState(clicked);
		boolean seat=state.getBlock() instanceof StairBlock;
		BlockPos feet=seat?clicked:clicked.above();
		if (!seat && (!level.getBlockState(feet).getCollisionShape(level,feet).isEmpty()
			|| state.getCollisionShape(level,clicked).isEmpty())) throw new IllegalArgumentException("Выбери свободный пол или кресло из ступеньки.");
		if (!level.getBlockState(feet.above()).getCollisionShape(level,feet.above()).isEmpty()) throw new IllegalArgumentException("Над местом должно быть пространство для головы.");
		float yaw=seat?state.getValue(StairBlock.FACING).getOpposite().toYRot():player.getDirection().toYRot();
		return new WorkspaceData.Spot(feet.getX(),feet.getY(),feet.getZ(),yaw);
	}
	private static void commit(MinecraftServer server,WorkspaceData next) {
		try {
			Path f=file(server), temp=f.resolveSibling("agentcraft-workspace.json.tmp");
			Files.writeString(temp,GSON.toJson(next)+"\n"); Files.move(temp,f,StandardCopyOption.REPLACE_EXISTING);
			data=next;
			if(data.active()) publish(server);
		} catch(Exception e) { throw new IllegalStateException("Не удалось сохранить рабочее место",e); }
	}
	public static void deactivate(MinecraftServer server) {
		if(data.active()) commit(server,new WorkspaceData(false,data.spots()));
	}
	private static void publish(MinecraftServer server) {
		var a=Anchors.builder("manual"); var desk=data.spot(WorkspaceRole.DESK);
		for(var role:WorkspaceRole.values()) {
			var p=data.spot(role);
			a.spot(role==WorkspaceRole.DESK?AnchorNames.SHARED_DESK:role.key,p.x(),p.y(),p.z(),p.yaw());
		}
		a.spot(AnchorNames.SPAWN,desk.x(),desk.y(),desk.z(),desk.yaw());
		a.bounds(desk.x()-32,desk.y()-16,desk.z()-32,desk.x()+32,desk.y()+16,desk.z()+32);
		Anchors.publish(server,a.build());
		bindNearby(server.overworld());
	}
	private static void bindNearby(ServerLevel level) {
		var desk=data.spot(WorkspaceRole.DESK);
		if(desk==null) return;
		for(int cx=(desk.x()-32)>>4;cx<=(desk.x()+32)>>4;cx++) for(int cz=(desk.z()-32)>>4;cz<=(desk.z()+32)>>4;cz++) {
			var chunk=level.getChunkSource().getChunkNow(cx,cz);
			if(chunk==null) continue;
			for(var be:chunk.getBlockEntities().values()) {
				var p=be.getBlockPos();
				if(Math.abs(p.getX()-desk.x())>32 || Math.abs(p.getZ()-desk.z())>32 || Math.abs(p.getY()-desk.y())>16) continue;
				if(be instanceof MonitorBlockEntity monitor && monitor.binding().isEmpty()) monitor.setBinding("slot:1");
				if(be instanceof StatusLampBlockEntity lamp && lamp.binding().isEmpty()) lamp.setBinding("agent:slot:1");
			}
		}
	}
}
