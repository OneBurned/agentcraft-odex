package dev.agentcraft.client.studio;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import dev.agentcraft.layout.Anchor;
import dev.agentcraft.layout.Anchors;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.HashMap;
import java.util.Map;
import java.util.List;
import dev.agentcraft.workspace.RestPlace;
import net.minecraft.client.Minecraft;
import net.minecraft.world.level.storage.LevelResource;

/** Local appearance and per-save furniture positions. Never stores credentials. */
public final class StudioPreferences {
    public static class Look {
        public boolean slim, hideLayer, hideName, hideRole, hideStatus;
        public String png = "";
        public Look copy() { return GSON.fromJson(GSON.toJson(this), Look.class); }
    }
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static StudioPreferences loaded;
    public Map<String, Look> looks = new HashMap<>();
    public Map<String, Map<String, Anchor>> worlds = new HashMap<>();
    public Map<String, Map<String, List<RestPlace>>> restPlaces = new HashMap<>();
    public static StudioPreferences get() {
        if (loaded == null) {
            try { loaded = Files.exists(file()) ? GSON.fromJson(Files.readString(file()), StudioPreferences.class) : new StudioPreferences(); }
            catch (Exception e) { dev.agentcraft.AgentCraft.LOGGER.warn("Cannot load studio preferences", e); loaded = new StudioPreferences(); }
            if (loaded == null) loaded = new StudioPreferences();
            if (loaded.looks == null) loaded.looks = new HashMap<>();
            if (loaded.worlds == null) loaded.worlds = new HashMap<>();
            if (loaded.restPlaces == null) loaded.restPlaces = new HashMap<>();
        }
        return loaded;
    }
    private static Path file() { return Minecraft.getInstance().gameDirectory.toPath().resolve("config/agentcraft-studio.json"); }
    public static Look defaults(String id) { Look l = new Look(); var member = dev.agentcraft.Cast.get(id); l.slim = member != null && member.slim(); return l; }
    public Look look(String id) { Look l = looks.computeIfAbsent(id, StudioPreferences::defaults); if (l.png == null) l.png = ""; return l; }
    public void save() {
        try {
            Files.createDirectories(file().getParent());
            Path temp = file().resolveSibling("agentcraft-studio.json.tmp");
            Files.writeString(temp, GSON.toJson(this));
            Files.move(temp, file(), StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception e) { throw new IllegalStateException("Не удалось сохранить настройки внешности", e); }
    }
    private String world() {
        var mc = Minecraft.getInstance();
        return mc.getSingleplayerServer() == null ? "multiplayer" : mc.getSingleplayerServer().getWorldPath(LevelResource.ROOT).toAbsolutePath().normalize().toString();
    }
    public void mark(String id, String role) {
        var mc = Minecraft.getInstance(); var p = mc.player;
        if (p == null || mc.getSingleplayerServer() == null) throw new IllegalStateException("Настройка мест доступна в одиночном мире.");
        markAt(id, role, new Anchor("", p.getX(), p.getY(), p.getZ(), p.getYRot(), 0));
    }
    public void markAt(String id, String role, Anchor place) {
        requireWorld();
        if (role.equals("lounge")) { addRest(id, false, place, null); return; }
        if (Minecraft.getInstance().getSingleplayerServer() == null) throw new IllegalStateException("Настройка мест доступна в одиночном мире.");
        String key = world(); var previous = worlds.get(key);
        var next = dev.agentcraft.workspace.WorkspaceAssignments.with(previous == null ? Map.of() : previous,
            id, role, place, Anchors.current().bounds());
        worlds.put(key, next);
        try { save(); }
        catch (RuntimeException e) { if (previous == null) worlds.remove(key); else worlds.put(key, previous); throw e; }
    }
    public List<RestPlace> rest(String id) {
        var places = restPlaces.getOrDefault(world(), Map.of()).get(id);
        if (places != null) return List.copyOf(places);
        Anchor legacy = worlds.getOrDefault(world(), Map.of()).get(id + "/lounge");
        return legacy == null ? List.of() : List.of(new RestPlace("legacy", false, legacy));
    }
    public void addRest(String id, boolean dance, Anchor place, String replaceId) {
        requireWorld();
        dev.agentcraft.workspace.WorkspaceAssignments.with(Map.of(), id, "lounge", place, Anchors.current().bounds());
        var point = new RestPlace(replaceId == null ? java.util.UUID.randomUUID().toString() : replaceId, dance, place);
        writeRest(id, RestPlace.put(rest(id), point));
    }
    private static void requireWorld() {
        var mc=Minecraft.getInstance();
        if (mc.getSingleplayerServer() == null || mc.level == null || mc.level.dimension() != net.minecraft.world.level.Level.OVERWORLD)
            throw new IllegalStateException("Места назначаются в обычном измерении одиночного мира.");
    }
    public void removeRest(String id, String pointId) { writeRest(id, rest(id).stream().filter(p -> !p.id().equals(pointId)).toList()); }
    private void writeRest(String id, List<RestPlace> points) {
        String key = world(); var previous = restPlaces.get(key);
        var next = new HashMap<String, List<RestPlace>>(previous == null ? Map.of() : previous);
        next.put(id, List.copyOf(points)); restPlaces.put(key, next);
        try { save(); }
        catch (RuntimeException e) { if (previous == null) restPlaces.remove(key); else restPlaces.put(key, previous); throw e; }
    }
    public void remove(String id, String role) { worlds.computeIfAbsent(world(), k -> new HashMap<>()).remove(id + "/" + role); save(); }
    public Anchor target(String id, String role, Anchor fallback) {
        if (role.equals("lounge") && restPlaces.getOrDefault(world(), Map.of()).containsKey(id)) return fallback;
        Anchor a = worlds.getOrDefault(world(), Map.of()).get(id + "/" + role);
        var b = Anchors.current().bounds();
        return a != null && b != null && b.contains(a.blockPos().getX(), a.blockPos().getY(), a.blockPos().getZ()) ? a : fallback;
    }
}
