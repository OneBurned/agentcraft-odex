/** Actual role-queue adapters, not the target provider matrix. No credentials in this DTO. */
export const teamCapabilities = [
  { provider: 'codex', transport: 'codex-desktop', title: 'Codex · приложение',
    roles: ['planner', 'developer', 'reviewer'], unavailable: {},
    hint: 'Отдельный чат Codex. Для создания планов нужно разрешение draft grant.' },
  { provider: 'codex', transport: 'codex-cli', title: 'Codex · CLI',
    roles: ['planner', 'developer', 'reviewer'], unavailable: {},
    hint: 'Отдельная сессия CLI. Разработка требует workspace-write; планы — разрешение draft grant.' },
  { provider: 'claude', transport: 'claude-code', title: 'Claude Code',
    roles: ['planner', 'developer', 'reviewer'], unavailable: {},
    hint: 'Отдельное пространство и сессия Claude. Планы — draft grant в planning.json; разработка — авторизация SDK моста.' },
] as const;

export function unsupportedRole(provider: string, roles: readonly string[]): string | undefined {
  const available = teamCapabilities.filter(c => c.provider === provider).flatMap(c => [...c.roles]);
  const role = roles.find(r => !available.includes(r as typeof available[number]));
  return role ? `Роль ${role} недоступна для ${provider}.` : undefined;
}
