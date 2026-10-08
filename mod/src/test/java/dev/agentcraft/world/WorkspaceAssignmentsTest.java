package dev.agentcraft.world;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import dev.agentcraft.layout.Anchor;
import dev.agentcraft.layout.Anchors;
import dev.agentcraft.workspace.WorkspaceAssignments;
import java.util.Map;
import org.junit.Test;
import static org.junit.Assert.*;

public class WorkspaceAssignmentsTest {
    private static final Anchors.Bounds BOUNDS = new Anchors.Bounds(-32, 50, -32, 32, 82, 32);
    private static Anchor spot(double x) { return new Anchor("", x, 66, 0.5, 90, 0); }

    @Test public void assigningClaudePreservesCodexAndOtherRoles() {
        var original = WorkspaceAssignments.with(Map.of(), "marlow", "desk", spot(1.5), BOUNDS);
        var withDesk = WorkspaceAssignments.with(original, "wren", "desk", spot(4.5), BOUNDS);
        var withReview = WorkspaceAssignments.with(withDesk, "wren", "mergestation", spot(6.5), BOUNDS);
        var moved = WorkspaceAssignments.with(withReview, "wren", "desk", spot(8.5), BOUNDS);
        assertEquals(1, original.size());
        assertEquals(3, moved.size());
        assertEquals(1.5, moved.get("marlow/desk").x(), 0);
        assertEquals(8.5, moved.get("wren/desk").x(), 0);
        assertEquals(6.5, moved.get("wren/mergestation").x(), 0);
        assertEquals("studio_wren_desk", moved.get("wren/desk").name());
        assertEquals(90, moved.get("wren/desk").yaw(), 0);
        Map<String, Anchor> reloaded = new Gson().fromJson(new Gson().toJson(moved),
            new TypeToken<Map<String, Anchor>>() {}.getType());
        assertEquals(moved, reloaded);
    }
    @Test public void acceptsCentersOfBoundaryBlocks() {
        assertEquals(1, WorkspaceAssignments.with(Map.of(), "wren", "lounge", spot(32.5), BOUNDS).size());
        assertEquals(1, WorkspaceAssignments.with(Map.of(), "wren", "lounge", spot(-31.5), BOUNDS).size());
    }
    @Test(expected=IllegalArgumentException.class) public void rejectsOutsideSite() {
        WorkspaceAssignments.with(Map.of(), "wren", "desk", spot(33.5), BOUNDS);
    }
    @Test(expected=IllegalArgumentException.class) public void requiresExistingSite() {
        WorkspaceAssignments.with(Map.of(), "wren", "desk", spot(1.5), null);
    }
    @Test(expected=IllegalArgumentException.class) public void rejectsMalformedAgentKey() {
        WorkspaceAssignments.with(Map.of(), "wren/desk", "desk", spot(1.5), BOUNDS);
    }
    @Test(expected=IllegalArgumentException.class) public void rejectsUnknownRole() {
        WorkspaceAssignments.with(Map.of(), "wren", "unknown", spot(1.5), BOUNDS);
    }
    @Test(expected=IllegalArgumentException.class) public void rejectsNonFinitePosition() {
        WorkspaceAssignments.with(Map.of(), "wren", "desk", spot(Double.NaN), BOUNDS);
    }
}
