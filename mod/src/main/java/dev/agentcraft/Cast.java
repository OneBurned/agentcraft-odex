package dev.agentcraft;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/** Bundled cosmetic presets only. The bridge supplies the team roster. */
public final class Cast {
	/** One cast member. {@code slim} = 3 px arms (model "slim"); colours are 0xRRGGBB. */
	public record Member(String id, String name, String role, String title, int color, int accent, int textOnDark, int textOnLight,
		boolean slim) {
	}

	private static volatile @Nullable Map<String, Member> members;

	private Cast() {
	}

	public static Map<String, Member> members() {
		Map<String, Member> m = members;
		if (m == null) {
			m = load();
			members = m;
		}
		return m;
	}

	public static List<String> ids() {
		return List.copyOf(members().keySet());
	}

	public static @Nullable Member get(String id) {
		return members().get(id);
	}

	/** Index of a cosmetic preset, or -1. */
	public static int indexOf(String id) {
		return ids().indexOf(id);
	}

	private static Map<String, Member> load() {
		Map<String, Member> out = new LinkedHashMap<>();
		try (InputStream in = Cast.class.getResourceAsStream("/assets/agentcraft/cast.json")) {
			if (in != null) {
				JsonObject root = JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
				for (JsonElement e : root.getAsJsonArray("agents")) {
					JsonObject a = e.getAsJsonObject();
					String id = a.get("id").getAsString();
					out.put(id, new Member(id, str(a, "name", id), str(a, "role", "worker"), str(a, "title", ""),
						color(a, "color", 0x9C9488), color(a, "accent", 0xF4EFE6), color(a, "text_on_dark", 0xF4EFE6),
						color(a, "text_on_light", 0x1F1E1D), "slim".equals(str(a, "model", "default"))));
				}
			}
		} catch (Exception e) {
			AgentCraft.LOGGER.warn("Could not read cast.json; cosmetic catalog unavailable", e);
		}
		return Collections.unmodifiableMap(out);
	}

	private static String str(JsonObject o, String k, String def) {
		return o.has(k) && o.get(k).isJsonPrimitive() ? o.get(k).getAsString() : def;
	}

	private static int color(JsonObject o, String k, int def) {
		return parseColor(str(o, k, null), def);
	}

	/** "#RRGGBB" -> 0xRRGGBB, or {@code def} if it does not parse. */
	public static int parseColor(@Nullable String hex, int def) {
		if (hex == null) {
			return def;
		}
		String h = hex.startsWith("#") ? hex.substring(1) : hex;
		if (h.length() != 6) {
			return def;
		}
		try {
			return Integer.parseInt(h, 16);
		} catch (NumberFormatException e) {
			return def;
		}
	}

}
