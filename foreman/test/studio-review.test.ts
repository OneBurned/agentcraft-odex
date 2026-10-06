import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoRepo, rmrf, until } from './helpers.js';

const proc = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: proc.spawn }));
import { ClaudeReviewer, cleanHead, gitText, findClaude } from '../src/studio-review.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmrf(dir); vi.clearAllMocks(); vi.unstubAllEnvs(); });
async function fixture() {
  const repo = await demoRepo(); dirs.push(path.dirname(repo)); const base = await cleanHead(repo);
  fs.writeFileSync(path.join(repo, 'review.txt'), 'Committed change'); await gitText(repo, ['add', 'review.txt']);
  await gitText(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Review fixture']);
  const input = { cwd: repo, base, head: await cleanHead(repo), task: 'Read fixture', checks: 'fixture checks', knowledge: 'Shared note' };
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: vi.fn(() => true) });
  let prompt = ''; child.stdin.on('data', b => prompt += b.toString()); proc.spawn.mockReturnValue(child);
  const reviewer = new ClaudeReviewer(() => 'mock-claude.exe');
  const respond = (value: unknown, code = 0) => { child.stdout.write(JSON.stringify(value)); child.emit('close', code); };
  return { repo, input, child, reviewer, prompt: () => prompt, respond };
}
describe('read-only Claude review adapter', () => {
  it('supplies committed changes with tools, MCP and hooks disabled', async () => {
    const h = await fixture(); const result = h.reviewer.run(h.input, new AbortController().signal);
    await until(() => proc.spawn.mock.calls.length > 0);
    const [, args, options] = proc.spawn.mock.calls[0]!;
    expect(args).toContain('--no-session-persistence'); expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe(''); expect(args[args.indexOf('--settings') + 1]).toBe('{"disableAllHooks":true}');
    expect(options).toMatchObject({ shell: false, windowsHide: true, cwd: os.tmpdir() });
    expect(h.prompt()).toContain('Committed change'); expect(h.prompt()).toContain(h.input.head);
    h.respond({ structured_output: { verdict: 'pass', summary: 'Проверено' } });
    await expect(result).resolves.toMatchObject({ verdict: 'pass' });
  });
  it('refuses a stale head before launching a reviewer', async () => {
    const h = await fixture();
    await expect(h.reviewer.run({ ...h.input, head: h.input.base }, new AbortController().signal)).rejects.toThrow('изменился');
    expect(proc.spawn).not.toHaveBeenCalled();
  });
  it('loads the same personal instructions and scoped tools for automated review', async () => {
    const h = await fixture();
    const reviewer = new ClaudeReviewer(() => 'mock-claude.exe', () => ({ directory: 'workspace', instructions: 'Проверь правила TradeRecord.', args: ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{"klava":{}}}', '--allowedTools', 'mcp__klava__project_read'] }));
    const result = reviewer.run(h.input, new AbortController().signal);
    await until(() => proc.spawn.mock.calls.length > 0);
    expect(h.prompt()).toContain('Проверь правила TradeRecord.');
    expect(h.prompt()).toContain(h.input.head);
    const args = proc.spawn.mock.calls[0]![1];
    expect(args).toContain('mcp__klava__project_read');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    h.respond({ structured_output: { verdict: 'pass', summary: 'Проверено с контекстом' } });
    await expect(result).resolves.toMatchObject({ verdict: 'pass' });
  });
  it('rejects a verdict when files changed during review', async () => {
    const h = await fixture(); const result = h.reviewer.run(h.input, new AbortController().signal);
    const assertion = expect(result).rejects.toThrow('Git'); await until(() => proc.spawn.mock.calls.length > 0);
    fs.writeFileSync(path.join(h.repo, 'new.txt'), 'unreviewed');
    h.respond({ structured_output: { verdict: 'pass', summary: 'obsolete' } }); await assertion;
  });
  it('kills the real reviewer process on interruption and ignores late output', async () => {
    const h = await fixture(); const controller = new AbortController(); const result = h.reviewer.run(h.input, controller.signal);
    const assertion = expect(result).rejects.toThrow('остановлено'); await until(() => proc.spawn.mock.calls.length > 0);
    controller.abort(); expect(h.child.kill).toHaveBeenCalledTimes(1);
    let confirmed = false; const stopped = h.reviewer.stop().then(() => { confirmed = true; });
    await Promise.resolve(); expect(confirmed).toBe(false);
    h.respond({ structured_output: { verdict: 'pass', summary: 'late' } }); await assertion; await stopped; expect(confirmed).toBe(true);
  });
  it('does not accept a malformed model verdict', async () => {
    const h = await fixture(); const result = h.reviewer.run(h.input, new AbortController().signal); const assertion = expect(result).rejects.toThrow();
    await until(() => proc.spawn.mock.calls.length > 0); h.respond({ structured_output: { verdict: 'maybe', summary: 'unknown' } }); await assertion;
  });
  it('discovers the newest desktop-bundled CLI when it is absent from PATH', () => {
    if (process.platform !== 'win32') return;
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-claude-discovery-')); dirs.push(local);
    for (const version of ['2.1.9', '2.1.288']) {
      const dir = path.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code', version, 'build');
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'claude.exe'), 'fixture');
    }
    vi.stubEnv('LOCALAPPDATA', local); vi.stubEnv('PATH', ''); vi.stubEnv('AGENTCRAFT_CLAUDE_EXE', '');
    // Explicit path always wins. Default local CLI, if installed, remains preferred to Desktop.
    const selected = findClaude();
    expect(selected?.includes('2.1.288') || selected === path.join(os.homedir(), '.local', 'bin', 'claude.exe')).toBe(true);
  });
});
