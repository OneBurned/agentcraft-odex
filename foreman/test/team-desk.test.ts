import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Foreman } from '../src/foreman.js';
import { ObserverBackend } from '../src/agents/observer.js';
import { DesktopChat } from '../src/codex-desktop.js';
import { TeamRegistry } from '../src/team.js';
import { ClaudeAdapter } from '../src/agent-adapters.js';
import { AgentConnections } from '../src/agent-connections.js';
import * as review from '../src/studio-review.js';
import { silentLogger } from '../src/context.js';
import { writeJsonAtomic } from '../src/util/fsx.js';
import { testConfig, tempDir, rmrf, demoRepo } from './helpers.js';

const roots: string[] = [], cores: Foreman[] = [];
function dir() { const p = tempDir('team-desk-'); roots.push(p); return p; }
afterEach(async () => { vi.restoreAllMocks(); for (const f of cores.splice(0)) await f.close(); for (const p of roots.splice(0)) rmrf(p); });
const agent = (provider = 'codex', roles = ['developer']) => ({ name: 'Agent', provider, roles, enabled: false, visible: true, appearance: { skin: 'marlow', color: '#123456', slim: false } });
function workspace() {
  const root = dir(), sessionId = randomUUID();
  writeJsonAtomic(path.join(root, 'access.json'), { version: 1, repositories: [{ id: 'test', name: 'Test', path: root, github: 'example/test' }] });
  writeJsonAtomic(path.join(root, 'conversation.json'), { version: 1, sessionId });
  for (const p of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) fs.writeFileSync(path.join(root, p), 'fixture');
  return { root, sessionId };
}
async function fixture() {
  const fm = new Foreman({ config: testConfig(dir(), ['--backend', 'observer']), logger: silentLogger }); cores.push(fm);
  const start = vi.fn(), send = vi.fn(async () => ({ chatDelivered: true })), check = vi.fn(async () => ({ notice: 'fixture probe' })), dispose = vi.fn(async () => {});
  const backend = new ObserverBackend(fm, undefined, (_c, _store, events) => ({
    start: () => { start(); events.activity('idle'); }, send, check, dispose, control: async () => ({}), busy: () => false,
  }));
  await fm.start(backend);
  const action = (a: string, p: Record<string, unknown> = {}) => backend.onStudioAction(a, p);
  const change = (a: string, p: Record<string, unknown>) => fm.teamAction(a, { revision: fm.team!.snapshot().revision, ...p });
  return { fm, backend, action, change, start, send, check, dispose };
}
it('desk builds three connections, checks disabled agents without starting work, assigns, archives and restores', async () => {
  const x = await fixture(); const c = workspace(), cli = dir(), ids: string[] = [];
  const data = await x.action('get') as any;
  expect(data.capabilities.map((c: any) => c.transport)).toEqual(['codex-desktop', 'codex-cli', 'claude-code']);
  const configs = [
    { provider: 'codex', transport: 'codex-desktop', threadId: randomUUID(), hostId: 'local', title: 'Test', pipePath: '\\\\.\\pipe\\codex-browser-use-fixture' },
    { provider: 'codex', transport: 'codex-cli', workspace: cli, sessionId: randomUUID(), executable: process.execPath, sandbox: 'read-only' },
    { provider: 'claude', transport: 'claude-code', workspace: c.root, sessionId: c.sessionId },
  ];
  for (const [i, connection] of configs.entries()) {
    x.change('team.create', { agent: agent(connection.provider, i === 0 ? ['planner', 'developer'] : ['reviewer']) });
    const id = x.fm.team!.snapshot().agents.at(-1)!.id; ids.push(id);
    await x.action('connection.bind', { id, revision: x.fm.team!.snapshot().revision, connection });
    expect((await x.action('connection.get', { id }) as any).connection).toMatchObject(connection);
    expect(await x.action('connection.check', { id })).toMatchObject({ agentId: id, result: { notice: 'fixture probe' } });
  }
  expect(x.start).not.toHaveBeenCalled(); expect(x.send).not.toHaveBeenCalled(); expect(x.check).toHaveBeenCalledTimes(3); expect(x.dispose).toHaveBeenCalledTimes(3);
  for (const id of ids) x.change('team.update', { id, patch: { enabled: true } });
  const repo = await demoRepo(); roots.push(repo); const project = await x.fm.repos.add(repo);
  const view = await x.action('create', { title: 'Task', description: 'Requirements', expected: 'Checks', repoId: project.id, developerId: ids[0], reviewerId: ids[2] }) as any;
  expect(view.items.at(-1)).toMatchObject({ developerId: ids[0], reviewerId: ids[2], noReview: false });
  await x.action('settings', { revision: x.fm.team!.snapshot().revision, autoSelect: true });
  expect((await x.action('get') as any).team.assignment.autoSelect).toBe(true);
  x.change('team.archive', { id: ids[1] });
  expect((await x.action('get') as any).team.agents[1]).toMatchObject({ archived: true, enabled: false, visible: false });
  await expect(x.action('connection.check', { id: ids[1] })).rejects.toThrow('восстанови');
  x.change('team.restore', { id: ids[1] });
  expect(x.fm.team!.get(ids[1]!)).toMatchObject({ archived: false, enabled: false, visible: true });
  await x.action('connection.check', { id: ids[1] });
  expect(x.send).not.toHaveBeenCalled();
});
it('desk allows Claude planner/reviewer and rejects unknown roles without changing the revision', async () => {
  const x = await fixture();
  expect(() => x.change('team.create', { agent: agent('claude', ['unknown' as any]) })).toThrow();
  expect(x.fm.team!.snapshot().revision).toBe(0);
  x.change('team.create', { agent: agent('codex', ['planner']) }); const id = x.fm.team!.snapshot().agents[0]!.id;
  x.change('team.update', { id, patch: { provider: 'claude', roles: ['planner', 'reviewer'] } });
  const legacy = x.fm.team!.snapshot(); legacy.agents[0]!.provider = 'claude';
  writeJsonAtomic(x.fm.team!.file, legacy);
  const registry = new TeamRegistry(x.fm.config.dataDir);
  registry.change('update', { id, revision: legacy.revision, patch: { name: 'Preserved' } }, () => {});
  expect(registry.get(id)?.roles).toEqual(['planner', 'reviewer']);
});
it('check holds the selected connection against rebinding and never enables a disabled agent', async () => {
  const x = await fixture(); x.change('team.create', { agent: agent() }); const id = x.fm.team!.snapshot().agents[0]!.id;
  const connection = { provider: 'codex', transport: 'codex-cli', workspace: dir(), sessionId: randomUUID(), executable: process.execPath, sandbox: 'read-only' };
  await x.action('connection.bind', { id, revision: x.fm.team!.snapshot().revision, connection });
  let finish!: () => void; x.check.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ notice: 'ok' }); }));
  const pending = x.action('connection.check', { id });
  await expect(x.action('connection.check', { id })).rejects.toThrow('проверки');
  expect(() => x.change('team.update', { id, patch: { enabled: true } })).toThrow('проверки');
  await expect(x.action('connection.bind', { id, revision: x.fm.team!.snapshot().revision, connection })).rejects.toThrow('проверки');
  finish(); await pending;
  expect(x.fm.team!.get(id)?.enabled).toBe(false); expect(x.send).not.toHaveBeenCalled();
});
it('desktop diagnostic calls only read_thread and rejects a different conversation', async () => {
  const root = dir(), threadId = randomUUID(); let returned = threadId;
  const call = vi.fn(async () => ({ thread: { id: returned, status: { type: 'idle' } }, turns: [] }));
  const text = vi.fn(), chat = new DesktopChat({ configFile: path.join(root, 'unused'), stateFile: path.join(root, 'state.json'),
    binding: () => ({ threadId, title: 'Test', hostId: 'local', pipePath: '\\\\.\\pipe\\codex-browser-use-fixture' }), call, onText: text, onStatus: vi.fn() });
  await expect(chat.check()).resolves.toMatchObject({ notice: expect.any(String) });
  expect((call.mock.calls[0] as any)[1]).toBe('read_thread'); expect(text).not.toHaveBeenCalled(); expect(fs.readdirSync(root)).toEqual([]);
  returned = randomUUID(); await expect(chat.check()).rejects.toThrow('другой чат');
});
it('Claude diagnostic checks login without invoking either model runner or rewriting the workspace', async () => {
  const root = dir(), w = workspace(), team = new TeamRegistry(root), store = new AgentConnections(root, team);
  team.change('create', { revision: 0, agent: agent('claude', ['reviewer']) }, () => {}); const id = team.snapshot().agents[0]!.id;
  store.bind({ id, revision: 1, connection: { provider: 'claude', transport: 'claude-code', workspace: w.root, sessionId: w.sessionId } }, () => {});
  const before = fs.readdirSync(w.root).map(p => [p, fs.readFileSync(path.join(w.root, p), 'utf8')]);
  vi.spyOn(review, 'findClaude').mockReturnValue(process.execPath); const auth = vi.spyOn(review, 'claudeLoggedIn').mockResolvedValue(true);
  const run = vi.fn(async () => 'not called'), runner = { run, stop: async () => {}, externalStatus: () => undefined };
  const a = new ClaudeAdapter(store.read(id)! as any, store, { text: vi.fn(), history: vi.fn(), activity: vi.fn() }, runner, runner);
  try { expect(await a.check()).toMatchObject({ notice: expect.stringContaining('Модель не вызывалась') });
    expect(auth).toHaveBeenCalledWith(process.execPath); expect(run).not.toHaveBeenCalled();
    expect(fs.readdirSync(w.root).map(p => [p, fs.readFileSync(path.join(w.root, p), 'utf8')])).toEqual(before);
    auth.mockResolvedValue(false); await expect(a.check()).rejects.toThrow('не выполнен вход');
  } finally { await a.dispose(); }
});
