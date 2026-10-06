// Desktop injects tools independently of the launcher's strict MCP configuration.
// Keep this list in sync with the Desktop inventory; this is not an MCP allowlist.
export const desktopDeniedTools = [
  'Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'NotebookEdit', 'Artifact*',
  'Cron*', 'ScheduleWakeup', 'SendMessage', 'PushNotification', 'RemoteTrigger',
  'Monitor', 'EnterWorktree', 'ExitWorktree', 'DesignSync', 'ListAgents', 'TaskStop',
  'mcp__terminal__*', 'mcp__Claude_Browser__*', 'mcp__claude-in-chrome__*',
  'mcp__scheduled-tasks__*', 'mcp__ccd_*', 'mcp__mcp-registry__*',
  'mcp__visualize__*',
  // Artifact document and visualization connectors observed in the installed app.
  'mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__*',
  'mcp__6f616b42-0ed8-571e-823f-ee4aca6b7ce9__*',
];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value, name) => {
  if (value !== undefined && (!Array.isArray(value) || value.some(v => typeof v !== 'string'))) {
    throw new Error(`Invalid Desktop settings: ${name} must be an array of strings.`);
  }
  return value ?? [];
};

export function klavaDesktopSettings(existing, tools) {
  if (!object(existing) || (existing.permissions !== undefined && !object(existing.permissions))) {
    throw new Error('Invalid Desktop settings: expected settings and permissions objects.');
  }
  const permissions = existing.permissions ?? {};
  const allow = strings(permissions.allow, 'permissions.allow');
  const deny = strings(permissions.deny, 'permissions.deny');
  strings(permissions.ask, 'permissions.ask');
  const servers = strings(existing.enabledMcpjsonServers, 'enabledMcpjsonServers');
  return {
    ...existing,
    disableAllHooks: true,
    enabledMcpjsonServers: [...new Set([...servers, 'klava'])],
    permissions: {
      ...permissions,
      allow: [...new Set([...allow, ...tools.map(t => `mcp__klava__${t}`)])],
      deny: [...new Set([...deny, ...desktopDeniedTools])],
    },
  };
}
