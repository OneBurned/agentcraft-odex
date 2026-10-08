package dev.agentcraft.workspace;

import dev.agentcraft.layout.Anchor;
import dev.agentcraft.layout.Anchors;
import java.util.HashMap;
import java.util.Map;

/** Personal places share one validated path regardless of which UI assigns them. */
public final class WorkspaceAssignments {
    private WorkspaceAssignments() {}

    public static Map<String, Anchor> with(Map<String, Anchor> current, String agent, String role,
            Anchor place, Anchors.Bounds bounds) {
        if (agent == null || !agent.matches("[a-z0-9_-]{1,64}")) throw new IllegalArgumentException("Неизвестный агент");
        WorkspaceRole.parse(role);
        if (!Double.isFinite(place.x()) || !Double.isFinite(place.y()) || !Double.isFinite(place.z())
                || !Float.isFinite(place.yaw())) throw new IllegalArgumentException("Некорректное место");
        if (bounds == null || place.x() < bounds.minX() || place.x() >= (double)bounds.maxX() + 1
                || place.y() < bounds.minY() || place.y() >= (double)bounds.maxY() + 1
                || place.z() < bounds.minZ() || place.z() >= (double)bounds.maxZ() + 1)
            throw new IllegalArgumentException("Место должно быть внутри рабочего участка, отмеченного Настройщиком.");
        var next = new HashMap<>(current);
        next.put(agent + "/" + role, place.withName("studio_" + agent + "_" + role));
        return next;
    }
}
