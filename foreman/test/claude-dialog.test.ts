import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
const proc = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: proc.spawn }));
import { ClaudeDialog } from '../src/claude-dialog.js';

afterEach(() => vi.clearAllMocks());
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  let prompt = ''; child.stdin.on('data', b => prompt += b.toString()); proc.spawn.mockReturnValue(child);
  const runner = new ClaudeDialog(() => 'mock-claude.exe');
  const respond = (data: unknown, code = 0) => { child.stdout.write(JSON.stringify(data)); child.emit('close', code); };
  return { runner, child, respond, prompt: () => prompt };
}
describe('Claude conversational process', () => {
  it('uses the real CLI text response without tools, MCP, hooks or project write access', async () => {
    const h = fixture(); const result = h.runner.run('Привет', new AbortController().signal);
    const [, args, options] = proc.spawn.mock.calls[0]!;
    expect(options).toMatchObject({ cwd: os.tmpdir(), windowsHide: true, shell: false });
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--settings') + 1]).toBe('{"disableAllHooks":true}');
    expect(args).toContain('--strict-mcp-config'); expect(args).toContain('--no-session-persistence');
    expect(h.prompt()).toBe('Привет'); h.respond({ result: 'Здравствуйте!' });
    await expect(result).resolves.toBe('Здравствуйте!');
  });
  it('waits for process exit instead of treating a kill request as confirmation', async () => {
    const h = fixture(); const result = h.runner.run('Вопрос', new AbortController().signal);
    const failed = expect(result).rejects.toThrow('кодом');
    let confirmed = false; const stopped = h.runner.stop().then(() => { confirmed = true; });
    await Promise.resolve(); expect(confirmed).toBe(false); expect(h.child.kill).toHaveBeenCalledOnce();
    h.respond({}, 1); await failed; await stopped; expect(confirmed).toBe(true);
  });
  it('passes explicit workspace tools and fresh instructions without enabling shell tools', async () => {
    const h = fixture();
    const workspace = vi.fn(() => ({ directory: 'workspace', instructions: 'Клава знает оба проекта.', args: ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{"klava":{}}}', '--allowedTools', 'mcp__klava__projects'] }));
    const runner = new ClaudeDialog(() => 'mock-claude.exe', workspace);
    const result = runner.run('Изучи проекты', new AbortController().signal);
    expect(workspace).toHaveBeenCalledOnce();
    const args = proc.spawn.mock.calls[0]![1];
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('mcp__klava__projects');
    expect(h.prompt()).toContain('Клава знает оба проекта.');
    h.respond({ result: 'Изучила' }); await expect(result).resolves.toBe('Изучила');
  });
  it('rejects concurrent starts and ignores output after cancellation', async () => {
    const h = fixture(); const controller = new AbortController();
    const result = h.runner.run('Вопрос', controller.signal); const failed = expect(result).rejects.toThrow('остановлен');
    await expect(h.runner.run('Другой вопрос', new AbortController().signal)).rejects.toThrow('ещё выполняется');
    controller.abort(); await failed; h.respond({ result: 'Поздний ответ' });
    expect(proc.spawn).toHaveBeenCalledOnce();
  });
  it('does not expose account diagnostics in process errors', async () => {
    const h = fixture(); const result = h.runner.run('Вопрос', new AbortController().signal);
    const failed = expect(result).rejects.toThrow('кодом 1');
    h.child.stderr.write('private account diagnostic'); h.respond({ is_error: true, result: 'private diagnostic' }, 1);
    await failed;
  });
  it('rejects invalid model envelopes and resets the process slot after exit', async () => {
    const h = fixture(); const result = h.runner.run('Вопрос', new AbortController().signal);
    const failed = expect(result).rejects.toThrow('не вернул'); h.respond({ is_error: true }); await failed;
    const next = fixture(); await expect(new ClaudeDialog(() => undefined).run('Hi', new AbortController().signal)).rejects.toThrow('не найден');
    expect(next.child.kill).not.toHaveBeenCalled();
  });
});
