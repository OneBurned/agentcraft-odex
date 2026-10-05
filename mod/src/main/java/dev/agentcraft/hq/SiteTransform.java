package dev.agentcraft.hq;

/** Quarter-turns about a local block centre, followed by translation to a selected block. */
public record SiteTransform(int x, int y, int z, int turns, int pivotZ) {
	public SiteTransform { turns = Math.floorMod(turns, 4); }
	public double worldX(double px, double pz) {
		double dx = px - .5, dz = pz - pivotZ - .5;
		return x + .5 + switch (turns) { case 1 -> -dz; case 2 -> -dx; case 3 -> dz; default -> dx; };
	}
	public double worldZ(double px, double pz) {
		double dx = px - .5, dz = pz - pivotZ - .5;
		return z + .5 + switch (turns) { case 1 -> dx; case 2 -> -dz; case 3 -> -dx; default -> dz; };
	}
	public int blockX(int px, int pz) { return (int) Math.floor(worldX(px + .5, pz + .5)); }
	public int blockZ(int px, int pz) { return (int) Math.floor(worldZ(px + .5, pz + .5)); }
	public int[] box(int[] b) {
		int ax = blockX(b[0], b[2]), az = blockZ(b[0], b[2]);
		int bx = blockX(b[3], b[5]), bz = blockZ(b[3], b[5]);
		return new int[] {Math.min(ax,bx), b[1]+y, Math.min(az,bz), Math.max(ax,bx), b[4]+y, Math.max(az,bz)};
	}
}
