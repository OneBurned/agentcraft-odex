package dev.agentcraft.client.studio;

import dev.agentcraft.client.agents.ClientAgentEntity;
import dev.agentcraft.client.agents.GridPathfinder;
import dev.agentcraft.layout.Anchor;
import dev.agentcraft.layout.Anchors;
import dev.agentcraft.workspace.RestCoordinator;
import dev.agentcraft.workspace.RestPlace;
import java.util.*;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.block.ChainBlock;
import net.minecraft.world.level.block.FenceBlock;
import net.minecraft.world.level.block.RotatedPillarBlock;
import net.minecraft.world.level.block.entity.JukeboxBlockEntity;
import net.minecraft.world.level.block.state.BlockState;

/** Client presentation only. Music snapshots are read on the integrated server's own thread. */
public final class RestDirector {
    private record Watch(MinecraftServer server, Set<BlockPos> poles) {}
    private record Music(Watch watch, Set<BlockPos> playing) {}
    private static volatile Watch watch;
    private static volatile Music music;
    private static int musicTicks;
    private final RestCoordinator choices = new RestCoordinator();
    private final Map<String, Integer> steps = new HashMap<>();
    private final Map<String, Long> nextStep = new HashMap<>();
    private record Reach(boolean ok, long until) {}
    private final Map<String, Reach> reachable = new HashMap<>();
    private Object world;
    private static final int[][] RING = {{0,1},{1,1},{1,0},{1,-1},{0,-1},{-1,-1},{-1,0},{-1,1}};
    public record Target(Anchor anchor, boolean dance) {}

    public static void init() {
        ServerLifecycleEvents.SERVER_STOPPED.register(server -> { if (watch != null && watch.server == server) { watch = null; music = null; } });
        ServerTickEvents.END_SERVER_TICK.register(server -> {
            if (++musicTicks % 10 != 0) return;
            Watch request = watch;
            if (request == null || request.server != server) return;
            Set<BlockPos> playing = new HashSet<>();
            var level = server.overworld();
            for (BlockPos pole : request.poles) {
                for (int cx=(pole.getX()-5)>>4; cx<=(pole.getX()+5)>>4; cx++)
                    for (int cz=(pole.getZ()-5)>>4; cz<=(pole.getZ()+5)>>4; cz++) {
                        var chunk=level.getChunkSource().getChunkNow(cx,cz);
                        if (chunk == null) continue;
                        for (var entity : chunk.getBlockEntities().values())
                            if (entity instanceof JukeboxBlockEntity box && box.getBlockPos().distSqr(pole) <= 25
                                    && box.getSongPlayer().isPlaying()) playing.add(pole);
                    }
            }
            music = new Music(request, Set.copyOf(playing));
        });
    }
    public void begin(ClientLevel level, Set<String> resting, Collection<String> agents) {
        if (world != level) { world = level; choices.clear(); steps.clear(); nextStep.clear(); reachable.clear(); }
        if (reachable.size() > 256) reachable.clear();
        choices.retain(resting); steps.keySet().retainAll(resting); nextStep.keySet().retainAll(resting);
        Set<BlockPos> poles = new HashSet<>();
        for (String agent : agents) for (RestPlace p : StudioPreferences.get().rest(agent))
            if (p.dance()) poles.add(p.anchor().blockPos());
        var server = Minecraft.getInstance().getSingleplayerServer();
        Watch previous=watch;
        if (previous == null || previous.server != server || !previous.poles.equals(poles)) watch = new Watch(server, Set.copyOf(poles));
    }
    private static boolean playing(BlockPos pole) {
        Music current=music; return current != null && current.watch == watch && current.playing.contains(pole);
    }
    private static boolean poleBlock(BlockState state) {
        return state.getBlock() instanceof FenceBlock || state.getBlock() instanceof ChainBlock
            && state.getValue(RotatedPillarBlock.AXIS) == Direction.Axis.Y;
    }
    public static Anchor pole(ClientLevel level, BlockPos clicked) {
        if (!poleBlock(level.getBlockState(clicked))) throw new IllegalArgumentException("Выбери вертикальную цепь или столб из заборов.");
        BlockPos base=clicked;
        for (int i=0; i<32 && poleBlock(level.getBlockState(base.below())); i++) base=base.below();
        var bounds=Anchors.current().bounds();
        if (bounds == null || !bounds.contains(base.getX(),base.getY(),base.getZ())) throw new IllegalArgumentException("Шест должен быть внутри рабочего участка.");
        if (!poleBlock(level.getBlockState(base.above())) || !poleBlock(level.getBlockState(base.above(2))))
            throw new IllegalArgumentException("Нужен вертикальный шест высотой хотя бы 3 блока.");
        Anchor anchor=new Anchor("pole",base.getX()+0.5,base.getY(),base.getZ()+0.5,0,0);
        if (!clearRing(level, anchor, new GridPathfinder(level,bounds)))
            throw new IllegalArgumentException("Вокруг шеста нужен свободный пол 3×3 и место для головы.");
        return anchor;
    }
    private static boolean clearRing(ClientLevel level, Anchor pole, GridPathfinder pf) {
        BlockPos base=pole.blockPos(); var bounds=Anchors.current().bounds();
        for (int y=0; y<3; y++) if (!poleBlock(level.getBlockState(base.above(y)))) return false;
        for (int[] d:RING) {
            int x=base.getX()+d[0], z=base.getZ()+d[1];
            if (bounds == null || !bounds.contains(x,base.getY(),z) || !Double.isFinite(pf.floor(x,base.getY(),z))) return false;
        }
        return true;
    }
    public Target target(String agent, ClientLevel level, GridPathfinder pf, ClientAgentEntity entity, long tick) {
        var options=StudioPreferences.get().rest(agent);
        var candidates=new ArrayList<RestCoordinator.Candidate>();
        for (RestPlace p:options) {
            var b=Anchors.current().bounds(); BlockPos pos=p.anchor().blockPos();
            if (b == null || !b.contains(pos.getX(),pos.getY(),pos.getZ())) continue;
            if (p.dance() && (!playing(pos) || !clearRing(level,p.anchor(),pf) || !reachable(agent,p,entity,pf,tick))) continue;
            if (!p.dance() && !Double.isFinite(pf.floor(pos.getX(),pos.getY(),pos.getZ()))
                    && dev.agentcraft.client.agents.Seats.detect(level,p.anchor(),pf) == null) continue;
            candidates.add(new RestCoordinator.Candidate(p.id(),p.occupancyKey(),p.dance()));
        }
        var chosen=choices.select(agent,candidates,tick);
        if (chosen == null) return null;
        RestPlace place=options.stream().filter(p -> p.id().equals(chosen.id())).findFirst().orElseThrow();
        if (!place.dance()) return new Target(place.anchor().withName("rest_"+place.id()),false);
        int step=steps.getOrDefault(agent,0);
        Anchor point=dancePoint(place,step,pf);
        if (entity != null && entity.position().distanceToSqr(point.pos()) < 0.06 && tick >= nextStep.getOrDefault(agent,0L)) {
            step=(step+1)%RING.length; steps.put(agent,step); nextStep.put(agent,tick+45);
            point=dancePoint(place,step,pf);
        }
        // Retargeting already follows collision-aware paths; do not animate until near the pole.
        boolean dancing=entity != null && entity.position().distanceToSqr(place.anchor().pos()) < 3.5;
        return new Target(point,dancing);
    }
    private boolean reachable(String agent, RestPlace place, ClientAgentEntity entity, GridPathfinder pf, long tick) {
        if (entity == null || entity.position().distanceToSqr(place.anchor().pos()) < 3.5) return true;
        String key=agent+":"+place.id()+":"+place.occupancyKey();
        Reach known=reachable.get(key);
        if (known == null || tick >= known.until) {
            var seat=entity.life().seat();
            var start=seat != null && seat.approach() != null ? seat.approach() : entity.position();
            known=new Reach(pf.find(start,dancePoint(place,steps.getOrDefault(agent,0),pf).pos()) != null,tick+100);
            reachable.put(key,known);
        }
        return known.ok;
    }
    private static Anchor dancePoint(RestPlace place,int step,GridPathfinder pf) {
        var p=place.anchor(); int[] d=RING[step];
        double y=pf.floor(p.blockPos().getX()+d[0],p.blockPos().getY(),p.blockPos().getZ()+d[1]);
        float yaw=(float)Math.toDegrees(Math.atan2(d[0],-d[1]));
        double radius=0.8/Math.sqrt(d[0]*d[0]+d[1]*d[1]);
        return new Anchor("dance_"+place.id()+"_"+step,p.x()+d[0]*radius,y,p.z()+d[1]*radius,yaw,0);
    }
}
