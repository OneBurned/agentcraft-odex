/** Actual role-queue adapters, not the target provider matrix. No credentials in this DTO. */
export const teamCapabilities = [
  { provider: 'codex', transport: 'codex-desktop', title: 'Codex · приложение',
    roles: ['planner', 'developer', 'reviewer'], unavailable: {},
    hint: 'Отдельный чат Codex. Для создания планов нужно разрешение draft grant.' },
  { provider: 'codex', transport: 'codex-cli', title: 'Codex · CLI',
    roles: ['planner', 'developer', 'reviewer'], unavailable: {},
    hint: 'Отдельная сессия CLI. Разработка требует workspace-write; планы — разрешение draft grant.' },
  { provider: 'claude', transport: 'claude-code', title: 'Claude Code',
    roles: ['developer', 'reviewer'], unavailable: { planner: 'Создание планов Claude для произвольной команды пока не подключено.' },
    hint: 'Отдельное рабочее пространство Claude. Разработчик использует настройки авторизации SDK моста.' },
] as const;

export function unsupportedRole(provider: string, roles: readonly string[]): string | undefined {
  const available = teamCapabilities.filter(c => c.provider === provider).flatMap(c => [...c.roles]);
  const role = roles.find(r => !available.includes(r as typeof available[number]));
  return role ? `Роль ${role} недоступна для ${provider}. ${provider === 'claude' ? teamCapabilities[2].unavailable.planner : ''}` : undefined;
}
