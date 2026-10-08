package dev.agentcraft.workspace;

/** Stable file/command keys; only the desk is required. */
public enum WorkspaceRole {
	DESK("desk", "Рабочее место"), LIBRARY("library", "Чтение"), TESTBENCH("testbench", "Проверки"),
	TERMINAL("terminal", "Консоль"), MERGESTATION("mergestation", "Ревью"), MEETING("meeting", "Планирование"),
	LOUNGE("lounge", "Отдых"), USER("user", "Ожидание ответа");
	public final String key;
	public final String label;
	WorkspaceRole(String key, String label) { this.key = key; this.label = label; }
	public WorkspaceRole next() { return values()[(ordinal() + 1) % values().length]; }
	public static WorkspaceRole parse(String key) {
		for (var role : values()) if (role.key.equals(key)) return role;
		throw new IllegalArgumentException("Неизвестная зона: " + key);
	}
}
