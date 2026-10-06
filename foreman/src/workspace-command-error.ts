/** Classify diagnostics without returning raw CLI output (which can contain credentials). */
export class WorkspaceCommandError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function githubError(error: unknown): WorkspaceCommandError {
  const e = (error && typeof error === 'object' ? error : {}) as { code?: unknown; killed?: boolean; stderr?: unknown; stdout?: unknown };
  const diagnostic = `${e.stderr ?? ''}\n${e.stdout ?? ''}`;
  const status = diagnostic.match(/\bHTTP[\s/]+(\d{3})\b/i)?.[1];
  if (e.code === 'ENOENT') return new WorkspaceCommandError('GITHUB_CLI_MISSING', 'GitHub CLI (gh) не найден.');
  if (e.killed || e.code === 'ETIMEDOUT') return new WorkspaceCommandError('GITHUB_TIMEOUT', 'GitHub не ответил вовремя. Повтори запрос позже.');
  if (status === '401' || /gh auth login|not logged (?:in|into)/i.test(diagnostic))
    return new WorkspaceCommandError('GITHUB_AUTH_REQUIRED', 'Нужен действующий вход в GitHub CLI.');
  if (status === '429' || ((status === '403') && /rate limit/i.test(diagnostic)))
    return new WorkspaceCommandError('GITHUB_RATE_LIMIT', 'GitHub ограничил частоту запросов. Повтори позже.');
  if (status === '403') return new WorkspaceCommandError('GITHUB_FORBIDDEN', 'GitHub отказал в доступе (HTTP 403). Проверь права аккаунта.');
  if (status === '404') return new WorkspaceCommandError('GITHUB_NOT_FOUND_OR_HIDDEN', 'GitHub: объект не найден или недоступен текущему аккаунту (HTTP 404). Это не доказывает отсутствие коммита.');
  if (status === '422') return new WorkspaceCommandError('GITHUB_INVALID_REFERENCE_OR_REQUEST', 'GitHub не принял запрос (HTTP 422). Проверь SHA, ветку и параметры; ссылка может отсутствовать на GitHub.');
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ECONNRESET/.test(String(e.code)) || /could not resolve host|dial tcp|error connecting to|network is unreachable/i.test(diagnostic))
    return new WorkspaceCommandError('GITHUB_NETWORK', 'Не удалось соединиться с GitHub. Проверь сеть и повтори запрос.');
  return new WorkspaceCommandError('GITHUB_REQUEST_FAILED', 'Запрос GitHub завершился ошибкой. Причина не определена; наличие объекта и права доступа не подтверждены.');
}
