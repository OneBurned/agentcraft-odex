package dev.agentcraft.hq;

import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import dev.agentcraft.command.AgentCraftCommands;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.shapes.CollisionContext;

/** Player-selected sites. Previews never modify blocks or save an active layout. */
final class PlacementCommands {
	private record Preview(ServerLevel level, int[] box, int ticks) {}
	private static final Map<UUID,Preview> previews = new HashMap<>();
	static void init() {
		for(String command : new String[]{"place","preview"}) AgentCraftCommands.sub(root -> root.then(Commands.literal(command)
			.executes(ctx -> help(ctx.getSource()))
			.then(Commands.argument("building",StringArgumentType.word()).suggests((ctx,b) -> b.suggest("studio").suggest("cabin").buildFuture())
				.executes(ctx -> run(ctx,command.equals("preview"))))));
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> previews.clear());
		ServerTickEvents.END_SERVER_TICK.register(server -> {
			previews.replaceAll((id,p) -> {
				if(p.ticks()%10==0) draw(p);
				return new Preview(p.level(),p.box(),p.ticks()-1);
			});
			previews.values().removeIf(p -> p.ticks()<=0);
		});
	}
	private static int help(CommandSourceStack s) {
		s.sendSuccess(() -> Component.literal("Наведи прицел на блок: /agentcraft preview studio|cabin — границы; /agentcraft place studio|cabin — построить. Studio: участок 93×91; cabin: 27×27."),false);
		return 1;
	}
	private static int run(CommandContext<CommandSourceStack> ctx, boolean preview) {
		var s=ctx.getSource();
		try {
			var player=s.getPlayerOrException(); var level=s.getLevel();
			if (s.getServer().isDedicatedServer()) throw new IllegalArgumentException("Постройки AgentCraft доступны в одиночной игре.");
			if (level != s.getServer().overworld()) throw new IllegalArgumentException("Для постройки перейди в обычное измерение (Верхний мир).");
			String id=StringArgumentType.getString(ctx,"building");
			if (!id.equals("studio") && !id.equals("cabin")) throw new IllegalArgumentException("Варианты: studio, cabin.");
			var eye=player.getEyePosition();
			var hit=level.clip(new ClipContext(eye,eye.add(player.getLookAngle().scale(64)),ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,CollisionContext.empty()));
			if(hit.getType()!=HitResult.Type.BLOCK) throw new IllegalArgumentException("Наведи прицел на блок не дальше 64 блоков.");
			var target=hit.getBlockPos();
			// Local entrances face south. Turn the south side toward the player's horizontal position.
			double dx=player.getX()-target.getX()-.5, dz=player.getZ()-target.getZ()-.5;
			int turns=Math.abs(dx)>Math.abs(dz)?(dx>0?3:1):(dz>0?0:2);
			int pivot=id.equals("studio")?7:0;
			HqPlacement site=new HqPlacement(target.getX(),target.getY()-64,target.getZ(),60,turns,pivot);
			int[] box=site.transform().box(id.equals("studio")?StudioHqBuilder.SITE:CabinHqBuilder.SITE);
			if(box[1]<level.getMinY() || box[4]>=level.getMaxY()) throw new IllegalArgumentException("Здание не помещается по высоте мира.");
			if(!level.getWorldBorder().isWithinBounds(new net.minecraft.core.BlockPos(box[0],box[1],box[2]))
				|| !level.getWorldBorder().isWithinBounds(new net.minecraft.core.BlockPos(box[3],box[4],box[5]))) throw new IllegalArgumentException("Участок выходит за границу мира.");
			if(preview) {
				previews.put(player.getUUID(),new Preview(level,box,300));
				s.sendSuccess(() -> Component.literal("Границы "+id+" показаны на 15 секунд. Центр основания: "+target.toShortString()+". При постройке участок внутри границ будет расчищен."),false);
			} else {
				PlacedSites.check(level,id,box);
				HqFeature.buildAndPublish(level,HqBuilders.get(id),new HqBuilder.Options(false,site));
				PlacedSites.remember(level,id,box);
				previews.remove(player.getUUID());
				// Building may fill the block occupied by the command's player; move them to the entrance.
				var spawn=dev.agentcraft.layout.Anchors.get(dev.agentcraft.layout.AnchorNames.SPAWN);
				player.teleportTo(level,spawn.x(),spawn.y(),spawn.z(),java.util.Set.of(),spawn.yaw(),0,true);
				s.sendSuccess(() -> Component.literal("Построено "+id+". Центр основания: "+target.toShortString()+". Codex работает здесь; прежнее здание сохранено."),false);
			}
			return 1;
		} catch(Exception e) { s.sendFailure(Component.literal(e.getMessage()==null?"Не удалось разместить здание":e.getMessage())); return 0; }
	}
	private static void draw(Preview p) {
		int[] b=p.box(); double low=b[1]+4.05, high=b[4]+1;
		for(double y : new double[]{low,high}) {
			for(int x=b[0];x<=b[3]+1;x+=2) for(int z:new int[]{b[2],b[5]+1}) dot(p.level(),x,y,z);
			for(int z=b[2];z<=b[5]+1;z+=2) for(int x:new int[]{b[0],b[3]+1}) dot(p.level(),x,y,z);
		}
		for(double y=low;y<=high;y+=2) for(int x:new int[]{b[0],b[3]+1}) for(int z:new int[]{b[2],b[5]+1}) dot(p.level(),x,y,z);
	}
	private static void dot(ServerLevel level,double x,double y,double z) {
		level.sendParticles(ParticleTypes.END_ROD,true,false,x,y,z,1,0,0,0,0);
	}
}
