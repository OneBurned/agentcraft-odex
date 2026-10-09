import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
const proc = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: proc.spawn }));
const sdk = vi.hoisted(() => ({ getSessionInfo: vi.fn(), getSessionMessages: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk);
import { ClaudeDialog } from '../src/claude-dialog.js';
import { conversationLease } from '../src/claude-conversation.js';
import { personaPrompt } from '../src/persona-prompt.js';
const dirs: string[] = [];

afterEach(() => { vi.clearAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  let prompt = ''; child.stdin.on('data', b => prompt += b.toString()); proc.spawn.mockReturnValue(child);
  const runner = new ClaudeDialog(() => 'mock-claude.exe');
  const respond = (data: unknown, code = 0) => { child.stdout.write(JSON.stringify(data)); child.emit('close', code); };
  return { runner, child, respond, prompt: () => prompt };
}
describe('Claude conversational process', () => {
  it('passes persona through the shared-session temporary system prompt without rewriting the user message or CLAUDE.md', async () => {
    const h = fixture(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-dialog-persona-')); dirs.push(directory);
    const sessionId = randomUUID();
    fs.writeFileSync(path.join(directory, 'conversation.json'), JSON.stringify({ version: 1, sessionId }));
    const personalFile = path.join(directory, 'CLAUDE.md'); fs.writeFileSync(personalFile, 'Personal instructions');
    sdk.getSessionInfo.mockResolvedValue({ sessionId, cwd: directory });
    const runner = new ClaudeDialog(() => 'mock-claude.exe', () => ({ directory, instructions: 'Workspace context', args: ['--append-system-prompt', 'Base rules'] }));
    const response = runner.run('Legacy prompt', new AbortController().signal, {
      text: 'Новое сообщение', context: 'Game context', retry: false, style: personaPrompt('Shared reviewer persona'), instructions: 'Messaging service instructions',
    });
    await vi.waitFor(() => expect(proc.spawn).toHaveBeenCalledOnce());
    const args = proc.spawn.mock.calls[0]![1];
    const temporary = args[args.indexOf('--append-system-prompt-file') + 1];
    const system = fs.readFileSync(temporary, 'utf8');
    for (const text of ['Base rules', 'Workspace context', 'Game context', 'Shared reviewer persona', 'Не переноси характер в артефакты', 'Messaging service instructions'])
      expect(system).toContain(text);
    expect(args[args.indexOf('--resume') + 1]).toBe(sessionId);
    expect(h.prompt()).toBe('Новое сообщение');
    h.respond({ result: 'Ответ', session_id: sessionId }); await expect(response).resolves.toBe('Ответ');
    expect(fs.existsSync(temporary)).toBe(false); expect(fs.readFileSync(personalFile, 'utf8')).toBe('Personal instructions');
  });
  it('resumes the bound native session with only the new message and retains the lock until exit on abort', async () => {
    const h = fixture(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-dialog-shared-')); dirs.push(directory);
    const sessionId = randomUUID(); fs.writeFileSync(path.join(directory, 'conversation.json'), JSON.stringify({ version: 1, sessionId, importedHistory: 'old game context' }));
    sdk.getSessionInfo.mockResolvedValue({ sessionId, cwd: directory });
    const runner = new ClaudeDialog(() => 'mock-claude.exe', () => ({ directory, instructions: 'role', args: [] }));
    const abort = new AbortController(); const response = runner.run('legacy prompt', abort.signal, { text: 'new message', context: 'game state', retry: false });
    await vi.waitFor(() => expect(proc.spawn).toHaveBeenCalledOnce());
    const [, args, opts] = proc.spawn.mock.calls[0]!;
    expect(args).toContain('--resume'); expect(args).toContain(sessionId); expect(args).not.toContain('--no-session-persistence');
    expect(opts.cwd).toBe(directory); expect(h.prompt()).toBe('new message');
    expect(fs.readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')).toContain('old game context');
    const failed = expect(response).rejects.toThrow('остановлен'); abort.abort(); await failed;
    expect(conversationLease(directory)?.owner).toBe('game');
    h.respond({}, 1); expect(conversationLease(directory)).toBeUndefined();
  });
  it('refuses a missing native session without creating a new conversation or leaking a lease', async () => {
    fixture(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-dialog-shared-')); dirs.push(directory);
    fs.writeFileSync(path.join(directory, 'conversation.json'), JSON.stringify({ version: 1, sessionId: randomUUID() }));
    sdk.getSessionInfo.mockResolvedValue(undefined);
    const runner = new ClaudeDialog(() => 'mock-claude.exe', () => ({ directory, instructions: '', args: [] }));
    await expect(runner.run('new', new AbortController().signal)).rejects.toThrow('не найдена');
    expect(proc.spawn).not.toHaveBeenCalled(); expect(conversationLease(directory)).toBeUndefined();
  });
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
