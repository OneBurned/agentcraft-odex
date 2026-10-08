import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { Foreman } from '../src/foreman.js';
import { ObserverBackend } from '../src/agents/observer.js';
import { CodexAdapter, type AgentAdapter, type AdapterEvents } from '../src/agent-adapters.js';
import { CodexCliAdapter, type CliRunner } from '../src/codex-cli.js';
import { silentLogger } from '../src/context.js';
import { writeJsonAtomic } from '../src/util/fsx.js';
import { ForemanServer } from '../src/server.js';
import { tempDir, testConfig, until, rmrf } from './helpers.js';

const dirs: string[] = [], cores: Foreman[] = [];
const dir = () => { const d = tempDir('codex-review-'); dirs.push(d); return d; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' }).toString().trim();
function commit(cwd: string, name: string) { git(cwd, 'add', '.'); git(cwd, '-c', `user.name=${name}`, '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture'); }
afterEach(async () => { for (const f of cores.splice(0)) await f.close(); for (const d of dirs.splice(0)) rmrf(d); });

async function fixture(transport: 'codex-desktop' | 'codex-cli') {
  const cwd = dir(), workspace = dir(); git(cwd, 'init', '-q'); fs.writeFileSync(path.join(cwd, 'file.txt'), 'original'); commit(cwd, 'Fixture');
  const sessionId = randomUUID(); writeJsonAtomic(path.join(workspace, 'conversation.json'), { version: 1, sessionId });
  writeJsonAtomic(path.join(workspace, 'access.json'), { version: 1, repositories: [{ id: 'fixture', name: 'Fixture', path: cwd, github: 'fixture/test' }] });
  for (const name of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) fs.writeFileSync(path.join(workspace, name), 'Fixture');
  const f = new Foreman({ config: testConfig(dir(), ['--backend', 'observer']), logger: silentLogger }); cores.push(f);
  const callbacks = new Map<string, AdapterEvents>(), prompts: string[] = [];
  let reviewer: AgentAdapter, finishCli = (_text: string) => {}, failCli = (_e: Error) => {}, cliBusy = false;
  let desktopWorking = false, desktopItems: any[] = [], desktopTurn = randomUUID();
  const backend = new ObserverBackend(f, undefined, (c, store, events) => {
    callbacks.set(c.agentId, events);
    if (c.provider === 'claude') return { start: () => events.activity('idle'), busy: () => false, dispose: async () => {},
      send: async () => ({}), execute: async () => ({}), control: async () => ({}) };
    if (c.transport === 'codex-desktop') {
      reviewer = new CodexAdapter(c, store, events, { call: async (_binding, tool, args) => {
        if (tool === 'send_message_to_thread') { prompts.push(String(args.prompt)); desktopWorking = true; desktopItems = []; desktopTurn = randomUUID(); return { threadId: c.threadId }; }
        return { thread: { id: c.threadId, status: { type: desktopWorking ? 'active' : 'idle' } },
          turns: [{ id: desktopTurn, status: desktopWorking ? 'inProgress' : 'completed', items: desktopItems }] };
      }, interrupt: async () => { desktopWorking = false; } });
    } else {
      const runner: CliRunner = { check: async () => ({ version: 'fixture' }), busy: () => cliBusy,
        stop: async () => { cliBusy = false; failCli(new Error('Stopped')); },
        run: async (prompt, id, signal, save) => {
          prompts.push(prompt); cliBusy = true; save(id ?? randomUUID());
          return new Promise<string[]>((resolve, reject) => {
            finishCli = text => { cliBusy = false; resolve([text]); }; failCli = e => { cliBusy = false; reject(e); };
            signal.addEventListener('abort', () => failCli(new Error('Stopped')), { once: true });
          });
        } };
      reviewer = new CodexCliAdapter(c, store, events, runner);
    }
    return reviewer;
  });
  await f.start(backend);
  const ids: string[] = [];
  for (const provider of ['claude', 'codex'] as const) {
    f.teamAction('team.create', { revision: f.team!.snapshot().revision, agent: { name: provider, provider, roles: [provider === 'claude' ? 'developer' : 'reviewer'], enabled: true, visible: true, appearance: { skin: 'wren', color: '#123456', slim: false } } });
    const id = f.team!.snapshot().agents.at(-1)!.id; ids.push(id);
    const connection = provider === 'claude' ? { provider, transport: 'claude-code', workspace, sessionId }
      : transport === 'codex-cli' ? { provider, transport, workspace: cwd, sessionId: randomUUID(), executable: process.execPath, sandbox: 'read-only' }
        : { provider, transport, threadId: randomUUID(), hostId: 'local', title: 'Fixture', pipePath: '\\\\.\\pipe\\codex-browser-use-review-fixture' };
    await backend.onStudioAction('connection.bind', { id, revision: f.team!.snapshot().revision, connection });
  }
  const [developerId, reviewerId] = ids as [string, string];
  await until(() => f.agent(reviewerId)?.controls?.message === true);
  const project = await f.repos.add(cwd);
  await backend.onStudioAction('create', { title: 'Claude implementation', description: 'Verify the committed change', expected: 'Expected result', repoId: project.id, developerId, reviewerId });
  const item = (f.store.data.backend.roleQueue as any).items[0];
  await backend.onStudioAction('approve', { id: item.id }); await backend.onStudioAction('start', {});
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'Claude fixture result'); commit(cwd, 'Claude fixture');
  callbacks.get(developerId)!.text(JSON.stringify({ id: item.id, run: item.attempt.run, status: 'done', summary: 'Implemented', checks: 'Fixture assertions', ci: 'pass' }), true);
  callbacks.get(developerId)!.activity('completed');
  await until(() => prompts.length > 0);
  const verdict = (value: string) => ({ id: item.id, run: item.attempt.run, agentId: reviewerId, head: item.head, verdict: value, summary: 'Checked exact range' });
  async function finish(value: object) {
    if (transport === 'codex-cli') finishCli(JSON.stringify(value));
    else {
      desktopItems = [{ type: 'agentMessage', id: 'final', text: JSON.stringify(value), phase: 'final_answer' }]; desktopWorking = false;
      await (reviewer! as CodexAdapter).chat.poll();
    }
  }
  return { f, backend, item, cwd, prompts, verdict, finish, reviewerId, callbacks, failCli };
}

for (const transport of ['codex-desktop', 'codex-cli'] as const) {
  it.each(['pass', 'changes', 'question'] as const)(`${transport} receives Claude ranges and returns %s through its native response path`, async result => {
    const x = await fixture(transport), p = x.verdict(result), prompt = x.prompts[0]!;
    for (const text of ['Claude implementation', 'Expected result', 'Fixture assertions', JSON.stringify(x.item.ranges), 'Только ревью', 'без изменения файлов', 'studio.mjs', ' review ']) expect(prompt).toContain(text);
    const head = git(x.cwd, 'rev-parse', 'HEAD'); await x.finish(p);
    await until(() => x.item.receipts[p.run] !== undefined);
    expect(x.item.review).toBe(p.summary); expect(x.item.stage).toBe(result === 'pass' ? 'done' : result === 'changes' ? 'queued' : 'question');
    expect(git(x.cwd, 'rev-parse', 'HEAD')).toBe(head); expect(git(x.cwd, 'status', '--porcelain')).toBe('');
    await expect(x.backend.onStudioAction('review', p)).rejects.toThrow('уже использован');
  });
  it(`${transport} routes execution failure to the review question`, async () => {
    const x = await fixture(transport);
    if (transport === 'codex-cli') x.failCli(new Error('CLI review failure'));
    else x.callbacks.get(x.reviewerId)!.activity('error', 'Desktop review failure');
    await until(() => x.item.stage === 'question'); expect(x.item.reason).toContain('review failure');
  });
  it(`${transport} refuses a late helper verdict after stop`, async () => {
    const x = await fixture(transport), p = x.verdict('pass');
    await x.backend.onChatControl('stop', x.reviewerId);
    await expect(x.backend.onStudioAction('review', p)).rejects.toThrow('не активны');
    expect(x.item.stage).toBe('question');
  });
}
it('helper review alias validates its envelope and accepts a current one once', async () => {
  const x = await fixture('codex-cli'), p = x.verdict('pass');
  await expect(x.backend.onStudioAction('review', { ...p, verdict: 'approve' })).rejects.toThrow();
  await expect(x.backend.onStudioAction('review', p)).resolves.toEqual({});
  await expect(x.backend.onStudioAction('review', p)).rejects.toThrow('уже использован');
});
it('studio.mjs review sends a JSON file to an isolated bridge and exits nonzero on a reused key', async () => {
  const x = await fixture('codex-cli'), p = x.verdict('pass');
  const server = new ForemanServer(x.f, { host: '127.0.0.1', port: 0, log: silentLogger });
  try {
    const port = await server.start(), file = path.join(dir(), 'verdict.json'); writeJsonAtomic(file, p);
    const args = [path.join(x.f.config.projectRoot, 'tools/studio.mjs'), 'review', '--port', String(port), '--file', file];
    const run = () => promisify(execFile)(process.execPath, args, { windowsHide: true, timeout: 10000 });
    const response = await run(); expect(JSON.parse(response.stdout)).toEqual({ ok: true, action: 'review' });
    await expect(run()).rejects.toMatchObject({ code: 1 });
    expect(x.item.review).toBe(p.summary);
  } finally { await server.stop(); }
});
