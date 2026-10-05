package dev.agentcraft.world;

import com.google.gson.JsonParser;
import org.junit.Test;

/** Configuration contract; run by Gradle check without booting Minecraft. */
public final class WorldSettingsTest {
	@Test
	public void validatesSettings() {
		WorldSettings defaults = parse("{}");
		require(defaults.type().equals("normal") && defaults.daylightCycle() && defaults.weatherCycle(), "normal defaults");
		WorldSettings flat = parse("{\"name\":\"Мой мир\",\"type\":\"flat\",\"seed\":\"-42\",\"gameMode\":\"survival\",\"difficulty\":\"hard\",\"spawnMobs\":false}");
		require(flat.name().equals("Мой мир") && flat.seed().equals("-42") && !flat.spawnMobs(), "explicit settings");
		for (String json : new String[] {
			"{\"name\":\"../old\"}", "{\"name\":\"C:\\\\world\"}", "{\"name\":\"CON.txt\"}",
			"{\"name\":\"..\"}", "{\"name\":\"bad.\"}", "{\"type\":\"typo\"}",
			"{\"gameMode\":\"typo\"}", "{\"difficulty\":\"typo\"}", "{\"seed\":42}",
			"{\"daylightCycle\":\"false\"}", "{\"weatherCycle\":null}", "{\"spawnMobs\":1}", "{\"unknown\":true}"
		}) {
			try { parse(json); } catch (IllegalArgumentException expected) { continue; }
			throw new AssertionError("Accepted invalid settings: " + json);
		}
		System.out.println("World settings: defaults, explicit values, and 13 invalid inputs passed");
	}
	private static WorldSettings parse(String json) { return WorldSettings.parse(JsonParser.parseString(json).getAsJsonObject()); }
	private static void require(boolean condition, String label) { if (!condition) throw new AssertionError(label); }
}
