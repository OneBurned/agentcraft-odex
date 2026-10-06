package dev.agentcraft.workspace;

/** Tick-based choreography. The caller advances it only at a reachable, music-playing pole. */
public final class PoleDance {
    public static final int HOLD_TICKS = 45;
    public static final int TURN_START = 12, TURN_END = 52;
    public static final int DIP_START = 64, DIP_TICKS = 64, DIP_END = DIP_START + 2 * DIP_TICKS;
    public static final int RETURN_START = DIP_END + 12, RETURN_END = RETURN_START + 40;
    public static final int ROUTINE_TICKS = RETURN_END + 12;
    public static final float LEG_PITCH = 1.15f, LEG_ROLL = 0.12f;
    public record Pose(float back, float dip) {
        public static final Pose NONE = new Pose(0, 0);
    }

    private int step;
    private long arrivedAt = -1, routineAt = -1;

    public int step() { return step; }

    /** Never start or continue a dip while travelling, displaced, or before facing the pole. */
    public Pose advance(long tick, boolean arrived, boolean facingPole) {
        if (!arrived) {
            arrivedAt = routineAt = -1;
            return Pose.NONE;
        }
        if (routineAt >= 0) {
            long elapsed = tick - routineAt;
            if (elapsed < ROUTINE_TICKS) return pose(elapsed);
            next();
            return Pose.NONE;
        }
        if (!facingPole) {
            arrivedAt = -1;
            return Pose.NONE;
        }
        if (arrivedAt < 0) arrivedAt = tick;
        if (tick - arrivedAt >= HOLD_TICKS) {
            if (step % 4 == 0) routineAt = tick;
            else next();
        }
        return Pose.NONE;
    }

    private void next() {
        step = (step + 1) % 8;
        arrivedAt = routineAt = -1;
    }

    /** Smooth turn, exactly two slow dips facing away, then a turn back while upright. */
    public static Pose pose(long elapsed) {
        if (elapsed < 0 || elapsed >= ROUTINE_TICKS) return Pose.NONE;
        float back = ease((elapsed - TURN_START) / (float) (TURN_END - TURN_START))
            * (1 - ease((elapsed - RETURN_START) / (float) (RETURN_END - RETURN_START)));
        float dip = elapsed >= DIP_START && elapsed < DIP_END
            ? (float) (0.5 - 0.5 * Math.cos(2 * Math.PI * (elapsed - DIP_START) / DIP_TICKS)) : 0;
        return new Pose(back, dip);
    }

    private static float ease(float t) {
        t = Math.max(0, Math.min(1, t));
        return t * t * (3 - 2 * t);
    }

    /** Lower the model as its rigid legs tilt, keeping the lowest boot corner at floor height. */
    public static float lowering(float dip) {
        double pitch = LEG_PITCH * dip, roll = LEG_ROLL * dip;
        double soleY = 12 * Math.cos(pitch) * Math.cos(roll)
            + 2 * Math.sin(pitch) * Math.cos(roll) + 2 * Math.sin(roll);
        return (float) ((12 - soleY) / 16 * 0.9375);
    }
}
