package dev.agentcraft.workspace;

import java.util.LinkedHashMap;
import java.util.Map;

/** The user's chosen positions are the source of truth; fallback anchors are derived only. */
public record WorkspaceData(boolean active, Map<String, Spot> spots) {
	public record Spot(int x, int y, int z, float yaw) {}
	public WorkspaceData {
		if (spots == null) throw new IllegalArgumentException("Missing workspace positions");
		spots = Map.copyOf(spots);
		for (var entry : spots.entrySet()) {
			WorkspaceRole.parse(entry.getKey());
			if (!Float.isFinite(entry.getValue().yaw())) throw new IllegalArgumentException("Invalid facing");
		}
		if (active && !spots.containsKey("desk")) throw new IllegalArgumentException("Сначала отметь рабочее место.");
		Spot desk = spots.get("desk");
		if (desk != null) for (Spot spot : spots.values()) {
			if (Math.abs((long) spot.x() - desk.x()) > 32 || Math.abs((long) spot.z() - desk.z()) > 32
				|| Math.abs((long) spot.y() - desk.y()) > 16) throw new IllegalArgumentException("Зона должна быть в 32 блоках от рабочего места (по высоте — 16).");
		}
	}
	public WorkspaceData with(WorkspaceRole role, Spot spot) {
		var copy = new LinkedHashMap<>(spots);
		// A new desk starts a new workspace when the previous zones are too far away.
		if (role == WorkspaceRole.DESK) copy.entrySet().removeIf(e -> Math.abs((long)e.getValue().x()-spot.x()) > 32
			|| Math.abs((long)e.getValue().z()-spot.z()) > 32 || Math.abs((long)e.getValue().y()-spot.y()) > 16);
		copy.put(role.key, spot);
		return new WorkspaceData(true, copy);
	}
	public Spot spot(WorkspaceRole role) { return spots.getOrDefault(role.key, spots.get("desk")); }
}
