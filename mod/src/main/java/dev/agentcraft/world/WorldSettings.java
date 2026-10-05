package dev.agentcraft.world;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;

/** Explicit settings for the selected HQ save. Generation settings only affect fresh saves. */
public record WorldSettings(String name, String type, String seed, String gameMode, String difficulty,
	boolean daylightCycle, boolean weatherCycle, boolean spawnMobs, boolean autoBuild) {
	private static final WorldSettings LEGACY = new WorldSettings("AgentCraft HQ", "flat", "agentcraft-hq",
		"creative", "peaceful", false, false, false, true);
	private static WorldSettings current;

	public static synchronized WorldSettings current() {
		if (current != null) return current;
		String file = System.getProperty("agentcraft.world.config", System.getenv("AGENTCRAFT_WORLD_CONFIG"));
		if (file == null || file.isBlank()) return current = LEGACY;
		try {
			return current = parse(JsonParser.parseString(Files.readString(Path.of(file), StandardCharsets.UTF_8)).getAsJsonObject());
		} catch (Exception e) {
			throw new IllegalArgumentException("Cannot load AgentCraft world settings: " + file, e);
		}
	}

	public static WorldSettings parse(JsonObject json) {
		Set<String> fields = Set.of("name", "type", "seed", "gameMode", "difficulty", "daylightCycle", "weatherCycle", "spawnMobs", "autoBuild");
		for (String key : json.keySet()) if (!fields.contains(key)) throw new IllegalArgumentException("Unknown world setting: " + key);
		String name = text(json, "name", "TradeRecord World").trim();
		if (name.isEmpty() || name.length() > 64 || name.matches(".*[\\\\/:*?\"<>|\\p{Cntrl}].*") || name.endsWith(".")
			|| name.equals("..") || name.matches("(?i)(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\\..*)?")) {
			throw new IllegalArgumentException("Invalid world name: use a simple folder name");
		}
		String type = choice(json, "type", "normal", Set.of("normal", "flat"));
		String mode = choice(json, "gameMode", "creative", Set.of("creative", "survival", "adventure", "spectator"));
		String difficulty = choice(json, "difficulty", "peaceful", Set.of("peaceful", "easy", "normal", "hard"));
		return new WorldSettings(name, type, text(json, "seed", ""), mode, difficulty,
			flag(json, "daylightCycle", true), flag(json, "weatherCycle", true), flag(json, "spawnMobs", true), flag(json,"autoBuild",false));
	}

	private static String text(JsonObject json, String key, String fallback) {
		if (!json.has(key)) return fallback;
		if (!json.get(key).isJsonPrimitive() || !json.getAsJsonPrimitive(key).isString()) throw new IllegalArgumentException(key + " must be a string");
		return json.get(key).getAsString();
	}
	private static String choice(JsonObject json, String key, String fallback, Set<String> choices) {
		String value = text(json, key, fallback);
		if (!choices.contains(value)) throw new IllegalArgumentException(key + " must be one of " + choices);
		return value;
	}
	private static boolean flag(JsonObject json, String key, boolean fallback) {
		if (!json.has(key)) return fallback;
		if (!json.get(key).isJsonPrimitive() || !json.getAsJsonPrimitive(key).isBoolean()) throw new IllegalArgumentException(key + " must be true or false");
		return json.get(key).getAsBoolean();
	}
}
