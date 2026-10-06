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
			.then(Commands.argument("building",StringArgumentType.word()).suggests((ctx,b) -> {
				b.suggest("studio").suggest("cabin"); ImportedBuildings.ids().forEach(b::suggest); return b.buildFuture();
			})
				.executes(ctx -> run(ctx,command.equals("preview"))))));
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> { previews.clear(); ImportedBuildings.clear(); });
		ServerTickEvents.END_SERVER_TICK.register(server -> {
			previews.replaceAll((id,p) -> {
				if(p.ticks()%10==0) draw(p);
				return new Preview(p.level(),p.box(),p.ticks()-1);
			});
			previews.values().removeIf(p -> p.ticks()<=0);
		});
	}
	private static int help(CommandSourceStack s) {
		s.sendSuccess(() -> Component.literal("Наведи прицел на блок: /agentcraft preview <постройка> — границы; /agentcraft place <постройка> — построить. Варианты: studio, cabin"+(ImportedBuildings.ids().isEmpty()?"":", "+String.join(", ",ImportedBuildings.ids()))+"."),false);
		return 1;
	}
	private static int run(CommandContext<CommandSourceStack> ctx, boolean preview) {
		var s=ctx.getSource();
		try {
			var player=s.getPlayerOrException(); var level=s.getLevel();
			if (s.getServer().isDedicatedServer()) throw new IllegalArgumentException("Постройки AgentCraft доступны в одиночной игре.");
			if (level != s.getServer().overworld()) throw new IllegalArgumentException("Для постройки перейди в обычное измерение (Верхний мир).");
			String id=StringArgumentType.getString(ctx,"building");
			boolean imported=!id.equals("studio") && !id.equals("cabin");
			var eye=player.getEyePosition();
			var hit=level.clip(new ClipContext(eye,eye.add(player.getLookAngle().scale(64)),ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,CollisionContext.empty()));
			if(hit.getType()!=HitResult.Type.BLOCK) throw new IllegalArgumentException("Наведи прицел на блок не дальше 64 блоков.");
			var target=hit.getBlockPos();
			// Local entrances face south. Turn the south side toward the player's horizontal position.
			double dx=player.getX()-target.getX()-.5, dz=player.getZ()-target.getZ()-.5;
			int turns=Math.abs(dx)>Math.abs(dz)?(dx>0?3:1):(dz>0?0:2);
			if(imported) return imported(s,player,id,target,turns,preview);
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
	private static int imported(CommandSourceStack source,net.minecraft.server.level.ServerPlayer player,String id,
		net.minecraft.core.BlockPos target,int turns,boolean preview) throws Exception {
		var level=source.getLevel(); var template=ImportedBuildings.load(source.getServer(),id);
		var settings=ImportedBuildings.settings(template,turns); var origin=ImportedBuildings.origin(template,target);
		var bounds=template.getBoundingBox(settings,origin);
		int[] box={bounds.minX(),bounds.minY(),bounds.minZ(),bounds.maxX(),bounds.maxY(),bounds.maxZ()};
		if(box[1]<level.getMinY() || box[4]>=level.getMaxY()) throw new IllegalArgumentException("Здание не помещается по высоте мира.");
		if(!level.getWorldBorder().isWithinBounds(new net.minecraft.core.BlockPos(box[0],box[1],box[2]))
			|| !level.getWorldBorder().isWithinBounds(new net.minecraft.core.BlockPos(box[3],box[4],box[5]))) throw new IllegalArgumentException("Участок выходит за границу мира.");
		if(preview) {
			previews.put(player.getUUID(),new Preview(level,box,300));
			source.sendSuccess(() -> Component.literal(id+": "+(box[3]-box[0]+1)+"×"+(box[5]-box[2]+1)+", высота "+(box[4]-box[1]+1)+". Центр нижнего слоя: "+target.toShortString()+". Границы на 15 секунд; внутри будут заменены блоки, включая воздух схемы."),false);
		} else {
			var volume=new net.minecraft.world.phys.AABB(box[0],box[1],box[2],box[3]+1,box[4]+1,box[5]+1);
			if(level.players().stream().anyMatch(p -> p.getBoundingBox().intersects(volume)))
				throw new IllegalArgumentException("Отойди за границы preview и наведи прицел на тот же блок: игрок находится внутри постройки.");
			PlacedSites.check(level,id,box);
			int flags=net.minecraft.world.level.block.Block.UPDATE_CLIENTS | net.minecraft.world.level.block.Block.UPDATE_KNOWN_SHAPE
				| net.minecraft.world.level.block.Block.UPDATE_SUPPRESS_DROPS | net.minecraft.world.level.block.Block.UPDATE_SKIP_ON_PLACE
				| net.minecraft.world.level.block.Block.UPDATE_SKIP_BLOCK_ENTITY_SIDEEFFECTS;
			if(!template.placeInWorld(level,origin,origin,settings,level.getRandom(),flags)) throw new IllegalStateException("Схема не содержит постройки.");
			PlacedSites.remember(level,id,box); previews.remove(player.getUUID());
			source.sendSuccess(() -> Component.literal("Построено "+id+". Рабочие места внутри назначь Настройщиком; прежние назначения сохранены."),false);
		}
		return 1;
	}
	private static void draw(Preview p) {
		int[] b=p.box(); double low=b[1]+.05, high=b[4]+1;
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
