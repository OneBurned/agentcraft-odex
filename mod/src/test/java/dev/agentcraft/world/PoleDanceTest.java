package dev.agentcraft.world;

import dev.agentcraft.workspace.PoleDance;
import org.junit.Test;
import static org.junit.Assert.*;

public class PoleDanceTest {
    @Test public void waitsUntilArrivedAndFacingPole() {
        var dance = new PoleDance();
        for (int tick = 0; tick < 500; tick++) {
            assertEquals(PoleDance.Pose.NONE, dance.advance(tick, false, true));
            assertEquals(0, dance.step());
        }
        for (int tick = 500; tick < 1000; tick++)
            assertEquals(PoleDance.Pose.NONE, dance.advance(tick, true, false));
        dance.advance(1000, true, true);
        assertEquals(PoleDance.Pose.NONE, dance.advance(1044, true, true));
        dance.advance(1045, true, true);
        assertEquals(1f, dance.advance(1045 + PoleDance.TURN_END, true, false).back(), 0);
    }

    @Test public void holdsOnePointThroughBothDipsThenWalksOn() {
        var dance = new PoleDance();
        dance.advance(0, true, true);
        dance.advance(PoleDance.HOLD_TICKS, true, true);
        for (int elapsed = 0; elapsed < PoleDance.ROUTINE_TICKS; elapsed++) {
            dance.advance(PoleDance.HOLD_TICKS + elapsed, true, false);
            assertEquals(0, dance.step());
        }
        assertEquals(PoleDance.Pose.NONE, dance.advance(PoleDance.HOLD_TICKS + PoleDance.ROUTINE_TICKS, true, true));
        assertEquals(1, dance.step());
        // Travel time does not count as standing time at the next point.
        dance.advance(10000, false, false);
        dance.advance(10001, true, true);
        dance.advance(10045, true, true);
        assertEquals(1, dance.step());
        dance.advance(10046, true, true);
        assertEquals(2, dance.step());
    }

    @Test public void exactlyTwoDipsOnlyWhileFullyFacingAway() {
        int peaks = 0;
        for (int tick = 0; tick < PoleDance.ROUTINE_TICKS; tick++) {
            var p = PoleDance.pose(tick);
            assertTrue(p.dip() >= 0 && p.dip() <= 1);
            assertTrue(p.back() >= 0 && p.back() <= 1);
            if (p.dip() > 0) assertEquals(1f, p.back(), 0);
            if (p.dip() == 1) peaks++;
        }
        assertEquals(2, peaks);
        assertEquals(PoleDance.Pose.NONE, PoleDance.pose(0));
        assertEquals(PoleDance.Pose.NONE, PoleDance.pose(PoleDance.ROUTINE_TICKS));
        assertEquals(0f, PoleDance.pose(PoleDance.RETURN_START).dip(), 0);
        assertEquals(0f, PoleDance.pose(PoleDance.RETURN_END).back(), 0);
    }

    @Test public void turnCanBeFollowedWithoutAngularSnaps() {
        float previousYaw = 0, previousDip = 0;
        for (int tick = 0; tick <= PoleDance.ROUTINE_TICKS; tick++) {
            var pose = PoleDance.pose(tick);
            float yaw = 180 * pose.back();
            // Standing AgentMotion turns at up to 9.6 degrees/tick.
            assertTrue(Math.abs(yaw - previousYaw) < 9.6f);
            assertTrue(Math.abs(pose.dip() - previousDip) < 0.05f);
            previousYaw = yaw; previousDip = pose.dip();
        }
    }

    @Test public void displacementCancelsSequenceInsteadOfDippingDuringTravel() {
        var dance = new PoleDance();
        dance.advance(0, true, true); dance.advance(45, true, true);
        assertTrue(dance.advance(141, true, false).dip() > 0.9);
        assertEquals(PoleDance.Pose.NONE, dance.advance(142, false, false));
        assertEquals(PoleDance.Pose.NONE, dance.advance(143, true, false));
        dance.advance(144, true, true);
        assertEquals(PoleDance.Pose.NONE, dance.advance(188, true, true));
        assertEquals(0, dance.step());
    }

    @Test public void agentsHaveIndependentSequencesAndRestartUpright() {
        var first = new PoleDance(); var second = new PoleDance();
        first.advance(0, true, true); first.advance(45, true, true);
        assertEquals(1f, first.advance(141, true, false).dip(), 0);
        assertEquals(PoleDance.Pose.NONE, second.advance(141, true, true));
        // RestDirector discards the sequence on work, lost music, another place or world.
        var restarted = new PoleDance();
        assertEquals(PoleDance.Pose.NONE, restarted.advance(5000, true, true));
        assertEquals(0, restarted.step());
    }

    @Test public void circlesAllEightPointsAndRepeatsRoutineOnlyAtOppositeSides() {
        var dance = new PoleDance(); long tick = 0;
        int routines = 0;
        for (int point = 0; point < 16; point++) {
            assertEquals(point % 8, dance.step());
            dance.advance(tick, true, true);
            dance.advance(tick += PoleDance.HOLD_TICKS, true, true);
            if (point % 4 == 0) {
                routines++;
                assertEquals(point % 8, dance.step());
                dance.advance(tick += PoleDance.ROUTINE_TICKS, true, false);
            }
            assertEquals((point + 1) % 8, dance.step());
            dance.advance(++tick, false, false);
            tick += 20;
        }
        assertEquals(4, routines);
    }

    @Test public void tiltedRigidLegsStayOnFloorThroughoutDip() {
        assertEquals(0f, PoleDance.lowering(0), 0);
        assertTrue(PoleDance.lowering(1) > 0.25f);
        assertTrue(PoleDance.lowering(1) < 0.4f);
        for (int sample = 0; sample <= 100; sample++) {
            float dip = sample / 100f;
            double pitch = -PoleDance.LEG_PITCH * dip, roll = PoleDance.LEG_ROLL * dip;
            double lowest = Double.POSITIVE_INFINITY;
            for (int x : new int[]{-2, 2}) for (int y : new int[]{0, 12}) for (int z : new int[]{-2, 2}) {
                double rotatedY = Math.sin(roll) * x + Math.cos(roll) * (Math.cos(pitch) * y - Math.sin(pitch) * z);
                double worldY = (12 - rotatedY) * 0.9375 / 16 - PoleDance.lowering(dip);
                lowest = Math.min(lowest, worldY);
            }
            assertEquals(0, lowest, 0.000001);
        }
    }
}
