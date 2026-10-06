import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import type { ClaudeWorkspace } from './claude-workspace.js';

export interface DialogRunner {
  run(prompt: string, signal: AbortSignal): Promise<string>;
  stop(): Promise<void>;
}

/** A conversational Claude process; optional tools expose only the configured review workspace. */
export class ClaudeDialog implements DialogRunner {
  private child?: ChildProcess;
  private exited?: Promise<void>;
  constructor(private executable: () => string | undefined, private workspace: () => ClaudeWorkspace | undefined = () => undefined) {}

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.kill();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.exited, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Claude ещё не подтвердил остановку. Повтори после завершения процесса.')), 5000);
      })]);
    } finally { clearTimeout(timeout); }
  }

  async run(prompt: string, signal: AbortSignal): Promise<string> {
    if (this.child) throw new Error('Предыдущий ответ Claude ещё выполняется.');
    const exe = this.executable();
    if (!exe) throw new Error('Claude Code не найден. Проверь настройки пульта.');
    if (signal.aborted) throw new Error('Ответ Claude остановлен.');
    const workspace = this.workspace();
    const output = await new Promise<string>((resolve, reject) => {
      let result = '', settled = false;
      const child = spawn(exe, ['-p', '--output-format', 'json', '--tools', '',
        ...(workspace?.args ?? ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']), '--setting-sources', '',
        '--settings', '{"disableAllHooks":true}', '--no-session-persistence'],
      { cwd: os.tmpdir(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      this.exited = new Promise(done => child.once('close', () => {
        if (this.child === child) this.child = undefined;
        done();
      }));
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(result);
      };
      const abort = () => { child.kill(); finish(new Error('Ответ Claude остановлен.')); };
      const timer = setTimeout(() => { child.kill(); finish(new Error('Claude не ответил за 10 минут.')); }, 600_000);
      signal.addEventListener('abort', abort, { once: true });
      child.once('error', () => finish(new Error('Не удалось запустить Claude Code. Проверь путь и вход в пульте.')));
      child.stdout!.on('data', b => {
        result += b.toString();
        if (result.length > 200_000) { child.kill(); finish(new Error('Ответ Claude превысил допустимый размер.')); }
      });
      child.stderr!.resume();
      child.stdin!.on('error', () => {});
      child.once('close', code => finish(code === 0 ? undefined : new Error(`Claude завершился с кодом ${code}; проверь вход в пульте.`)));
      child.stdin!.end(workspace ? `Постоянный контекст рабочего пространства:\n${workspace.instructions}\n\nТекущий запрос:\n${prompt}` : prompt);
    });
    let envelope: { is_error?: boolean; result?: string };
    try { envelope = JSON.parse(output); } catch { throw new Error('Не удалось прочитать ответ Claude.'); }
    if (envelope.is_error || typeof envelope.result !== 'string' || !envelope.result.trim())
      throw new Error('Claude не вернул текст ответа. Проверь вход и доступность сервиса.');
    return envelope.result.trim().slice(0, 16000);
  }
}
