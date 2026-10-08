import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Foreman } from '../src/foreman.js';
import { ObserverBackend } from '../src/agents/observer.js';
import { ClaudeAdapter, CodexAdapter, type AgentAdapter, type AdapterEvents } from '../src/agent-adapters.js';
import type { AppCall } from '../src/codex-desktop.js';
import type { DialogRunner } from '../src/claude-dialog.js';
import type { ConversationMessage } from '../src/claude-conversation.js';
import { silentLogger } from '../src/context.js';
import { writeJsonAtomic } from '../src/util/fsx.js';
import { parseClientMessage, type Outbound } from '../src/protocol.js';
import { testConfig, tempDir, rmrf, until } from './helpers.js';

const dirs: string[] = [], cores: Foreman[] = [];
const dir = () => { const d = tempDir('agent-runtime-'); dirs.push(d); return d; };
afterEach(async () => { for (const f of cores.splice(0)) await f.close(); for (const d of dirs.splice(0)) rmrf(d); });
function runner(sessionId: string) {
  const rows: ConversationMessage[] = [];
  let finish: (text: string) => void = () => {};
  let rejectRun: (e: Error) => void = () => {};
  const value: DialogRunner = {
    shared: () => sessionId, history: async () => structuredClone(rows), externalStatus: () => undefined,
    run: vi.fn((text, signal) => new Promise<string>((resolve, reject) => {
      rows.push({ id: randomUUID(), role: 'user', text });
      rejectRun = reject;
      finish = result => { rows.push({ id: randomUUID(), role: 'assistant', text: result }); resolve(result); };
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      if (signal.aborted) reject(new Error('aborted'));
    })),
    stop: vi.fn(async () => rejectRun(new Error('stopped'))),
  };
  return { value, finish: (text: string) => finish(text), rows };
}
async function fixture() {
  const f = new Foreman({ config: testConfig(dir(), ['--backend', 'observer']), logger: silentLogger }); cores.push(f);
  const adapters = new Map<string, AgentAdapter>(), runners = new Map<string, ReturnType<typeof runner>>();
  const callbacks = new Map<string, AdapterEvents>();
  const chats = new Map<string, { working: boolean; turn: string; items: any[] }>();
  const sent: string[] = [], interrupted: string[] = [];
  const call: AppCall = async (binding, tool) => {
    const chat = chats.get(binding.threadId)!;
    if (tool === 'send_message_to_thread') { sent.push(binding.threadId); chat.working = true; chat.turn = randomUUID(); chat.items = []; return { threadId: binding.threadId }; }
    return { thread: { id: binding.threadId, status: { type: chat.working ? 'active' : 'idle' } },
      turns: [{ id: chat.turn, status: chat.working ? 'inProgress' : 'completed', items: chat.items }] };
  };
  const backend = new ObserverBackend(f, undefined, (c, store, events) => {
    callbacks.set(c.agentId, events);
    let a: AgentAdapter;
    if (c.transport === 'codex-desktop') {
      chats.set(c.threadId, { working: false, turn: randomUUID(), items: [] });
      a = new CodexAdapter(c, store, events, { call, interrupt: async id => { interrupted.push(id); chats.get(id)!.working = false; } });
    } else if (c.provider === 'claude') {
      const r = runner(c.sessionId); runners.set(c.agentId, r);
      a = new ClaudeAdapter(c, store, events, r.value);
    } else throw new Error('Unexpected CLI transport in desktop fixture');
    adapters.set(c.agentId, a); return a;
  });
  await f.start(backend);
  const ids: string[] = [], connections: any[] = [];
  for (const provider of ['codex', 'codex', 'claude', 'claude'] as const) {
    f.teamAction('team.create', { revision: f.team!.snapshot().revision, agent: { name: 'Same name', provider, roles: ['developer'], enabled: true, visible: true, appearance: { skin: 'marlow', color: '#123456', slim: false } } });
    const id = f.team!.snapshot().agents.at(-1)!.id;
    let c;
    if (provider === 'codex') c = { provider, transport: 'codex-desktop', threadId: randomUUID(), hostId: 'local', title: 'Fixture', pipePath: '\\\\.\\pipe\\codex-browser-use-fixture' };
    else {
      const workspace = dir(), sessionId = randomUUID();
      writeJsonAtomic(path.join(workspace, 'conversation.json'), { version: 1, sessionId });
      writeJsonAtomic(path.join(workspace, 'access.json'), { version: 1, repositories: [{ id: 'test', name: 'Test', path: workspace, github: 'example/test' }] });
      for (const file of ['CLAUDE.md', 'MEMORY.md', 'PROJECTS.md']) fs.writeFileSync(path.join(workspace, file), `Private for ${id}`);
      c = { provider, transport: 'claude-code', workspace, sessionId };
    }
    await backend.onStudioAction('connection.bind', { id, revision: f.team!.snapshot().revision, connection: c });
    ids.push(id); connections.push(c);
    await until(() => f.agent(id)?.controls?.message === true);
  }
  return { f, backend, ids, connections, adapters, callbacks, runners, chats, sent, interrupted };
}
async function message(f: Foreman, body: Record<string, unknown>) {
  const out: Outbound[] = [];
  const parsed = parseClientMessage({ v: 2, id: randomUUID(), ...body });
  if (!parsed.ok) throw new Error('Invalid fixture message');
  await f.handle(parsed.msg, m => out.push(m));
  return out.find(m => m.type === 'ack') as any;
}
it('two Codex and two Claude agents send, receive and pause independently through the real dispatch', async () => {
  const x = await fixture();
  const [a, b, c, d] = x.ids as [string, string, string, string];
  const feed: Outbound[] = []; x.f.subscribe(e => feed.push(e));
  for (const id of x.ids) expect((await message(x.f, { type: 'user.message', to: id, text: `For ${id}` })).ok).toBe(true);
  expect(x.sent).toEqual(x.connections.slice(0, 2).map(c => c.threadId));
  await until(() => x.runners.get(c)!.value.run instanceof Function && x.f.agent(d)?.state === 'thinking');
  expect((await message(x.f, { type: 'agent.action', agentId: a, action: 'pause' })).ok).toBe(true);
  expect(x.interrupted).toEqual([x.connections[0].threadId]);
  expect(x.f.agent(a)?.paused).toBe(true); expect(x.f.agent(b)?.state).toBe('thinking');
  expect(x.f.agent(c)?.controls?.pause).toBe(true);
  expect((await message(x.f, { type: 'agent.action', agentId: c, action: 'pause' })).ok).toBe(true);
  expect(x.runners.get(c)!.value.stop).toHaveBeenCalledOnce();
  expect(x.runners.get(d)!.value.stop).not.toHaveBeenCalled();
  expect(x.f.agent(d)?.state).toBe('thinking');
  expect(x.f.agent(c)?.paused).toBe(true);
  x.runners.get(d)!.finish('Only fourth answer');
  await until(() => x.f.agent(d)?.state === 'done');
  const view = await x.backend.onStudioAction('connection.get', { id: d });
  expect(view.history).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', text: 'Only fourth answer' })]));
  expect(JSON.stringify((await x.backend.onStudioAction('connection.get', { id: c })).history)).not.toContain('Only fourth answer');
  expect((await message(x.f, { type: 'agent.action', agentId: c, action: 'resume' })).ok).toBe(true);
  await until(() => vi.mocked(x.runners.get(c)!.value.run).mock.calls.length === 2);
  expect(vi.mocked(x.runners.get(c)!.value.run).mock.calls[1]![2]?.retry).toBe(true);
  expect((await message(x.f, { type: 'agent.action', agentId: a, action: 'resume' })).ok).toBe(true);
  expect(x.sent.at(-1)).toBe(x.connections[0].threadId);
  expect(x.f.agent(a)?.paused).toBe(false);
});
it('does not mark an agent paused until actual stop confirmation and preserves other agents', async () => {
  const x = await fixture(), id = x.ids[2]!, other = x.ids[3]!;
  await x.backend.onChatMessage('work', id);
  let confirm!: () => void;
  vi.mocked(x.runners.get(id)!.value.stop).mockImplementationOnce(() => new Promise<void>(resolve => { confirm = resolve; }));
  const stopping = x.backend.onChatControl('pause', id);
  await until(() => !!confirm);
  expect(x.f.agent(id)?.paused).toBe(false);
  await expect(x.backend.onStudioAction('connection.unbind', { id, revision: x.f.team!.snapshot().revision })).rejects.toThrow('занят');
  expect(x.f.agent(other)?.paused).toBe(false);
  confirm(); await stopping; expect(x.f.agent(id)?.paused).toBe(true);
  await x.backend.onChatControl('resume', id);
  vi.mocked(x.runners.get(id)!.value.stop).mockRejectedValueOnce(new Error('child exit unknown'));
  await expect(x.backend.onChatControl('stop', id)).rejects.toThrow('child exit unknown');
  expect(x.f.agent(id)?.paused).toBe(false);
  expect((await x.backend.onStudioAction('connection.get', { id })).phase).toBe('unavailable');
  await (x.adapters.get(id) as ClaudeAdapter).poll();
  expect((await x.backend.onStudioAction('connection.get', { id })).phase).toBe('unavailable');
  expect(x.f.agent(id)?.controls?.stop).toBe(true);
  await x.backend.onChatControl('stop', id);
  expect((await x.backend.onStudioAction('connection.get', { id })).phase).toBe('stopped');
});
it('rejects ambiguous recipients, duplicate bindings and changes while work is active', async () => {
  const x = await fixture(), id = x.ids[0]!;
  expect((await message(x.f, { type: 'user.message', to: 'Same name', text: 'No recipient' })).ok).toBe(false);
  expect((await message(x.f, { type: 'user.message', to: 'all', text: 'No broadcast' })).ok).toBe(false);
  await expect(x.backend.onStudioAction('connection.bind', { id: x.ids[1], revision: x.f.team!.snapshot().revision, connection: x.connections[0] })).rejects.toThrow('уже назначен');
  await x.backend.onChatMessage('work', id);
  expect(() => x.f.teamAction('team.disable', { id, revision: x.f.team!.snapshot().revision })).toThrow('занят');
  await expect(x.backend.onStudioAction('connection.unbind', { id, revision: x.f.team!.snapshot().revision })).rejects.toThrow('занят');
  expect(x.sent).toHaveLength(1);
});
it('drops old callbacks after unbinding and keeps archived history on disk', async () => {
  const x = await fixture(), id = x.ids[0]!, callbacks = x.callbacks.get(id)!;
  callbacks.text('Persist me', true);
  const historyDir = path.join(x.f.config.dataDir, `agents/${id}/history`);
  const before = fs.readFileSync(path.join(historyDir, fs.readdirSync(historyDir)[0]!), 'utf8');
  await x.backend.onStudioAction('connection.unbind', { id, revision: x.f.team!.snapshot().revision });
  callbacks.text('Late stale answer', true); callbacks.activity('working');
  expect(x.f.agent(id)?.activity).toBe('Не подключён');
  expect(fs.readFileSync(path.join(historyDir, fs.readdirSync(historyDir)[0]!), 'utf8')).toBe(before);
  x.f.teamAction('team.archive', { id, revision: x.f.team!.snapshot().revision });
  expect(x.f.agent(id)).toBeUndefined();
  expect(before).toContain('Persist me');
});
it('addresses progress by agent and never combines equal observer task keys', async () => {
  const x = await fixture();
  for (const id of x.ids.slice(0, 2)) {
    await x.backend.onChatMessage('work', id);
    const ack = await message(x.f, { type: 'observer.update', agentId: id, key: 'same', title: 'Work', state: 'editing', activity: 'Editing this project' });
    expect(ack.ok).toBe(true);
  }
  expect(x.f.tasks.list().filter(t => t.observerKey?.endsWith('/same'))).toHaveLength(2);
  expect(x.f.tasks.list().map(t => t.assignee)).toEqual(x.ids.slice(0, 2));
  const bad = await message(x.f, { type: 'observer.update', key: 'same', title: 'Work', state: 'done', activity: 'Done' });
  expect(bad.ok).toBe(false);
});
it('replaces an unavailable Codex connection when no command or work is active', async () => {
  const x = await fixture(), id = x.ids[0]!;
  x.callbacks.get(id)!.activity('unavailable');
  await x.backend.onStudioAction('connection.bind', { id, revision: x.f.team!.snapshot().revision,
    connection: { ...x.connections[0], threadId: randomUUID(), pipePath: '\\\\.\\pipe\\codex-browser-use-new' } });
  await until(() => x.f.agent(id)?.controls?.message === true);
  expect(x.f.team!.get(id)?.connectionRef).toBeTruthy();
});
it('terminal ownership disables only its Claude and never attempts to stop the terminal', async () => {
  const x = await fixture(), id = x.ids[2]!, other = x.ids[3]!;
  x.runners.get(id)!.value.externalStatus = () => 'Claude in terminal';
  await (x.adapters.get(id) as ClaudeAdapter).poll();
  expect(x.f.agent(id)?.controls?.message).toBe(false);
  expect(x.f.agent(other)?.controls?.message).toBe(true);
  await expect(x.backend.onChatControl('stop', id)).rejects.toThrow('terminal');
  expect(x.runners.get(id)!.value.stop).not.toHaveBeenCalled();
  expect(() => x.f.teamAction('team.archive', { id, revision: x.f.team!.snapshot().revision })).toThrow('занят');
  x.runners.get(id)!.value.externalStatus = () => undefined;
});
it('retains Codex history across a full bridge restart without replaying old feed entries', async () => {
  const x = await fixture(), id = x.ids[0]!;
  x.callbacks.get(id)!.text('Durable reply', true);
  await x.f.close();
  const f = new Foreman({ config: x.f.config, logger: silentLogger }); cores.push(f);
  const backend = new ObserverBackend(f, undefined, (_c, _s, events) => ({
    start: () => events.activity('idle'), dispose: async () => {}, busy: () => false,
    send: async () => ({}), control: async () => ({}),
  }));
  await f.start(backend);
  const view = await backend.onStudioAction('connection.get', { id });
  expect(view.history).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Durable reply' })]));
});
it.each(['workspace', 'connection'])('isolates a missing/damaged %s and detaches only its inactive agent', async damage => {
  const x = await fixture(), broken = x.ids[2]!, healthy = x.ids[3]!, codex = x.ids[0]!;
  if (damage === 'workspace') {
    const workspace = x.connections[2].workspace;
    expect(dirs).toContain(workspace);
    fs.renameSync(workspace, path.join(dir(), 'moved-workspace'));
  } else fs.writeFileSync(path.join(x.f.config.dataDir, x.f.team!.get(broken)!.connectionRef!), '{broken');
  await (x.adapters.get(broken) as ClaudeAdapter).poll();
  expect(x.f.agent(broken)?.controls?.message).toBe(false);
  await (x.adapters.get(healthy) as ClaudeAdapter).poll();
  await (x.adapters.get(codex) as CodexAdapter).chat.poll();
  expect(x.f.agent(healthy)?.controls?.message).toBe(true);
  expect(x.f.agent(codex)?.controls?.message).toBe(true);
  await x.backend.onChatMessage('Unrelated work', healthy);
  await x.backend.onChatMessage('Other work', codex);
  await x.backend.onStudioAction('connection.unbind', { id: broken, revision: x.f.team!.snapshot().revision });
  expect(x.f.team!.get(broken)?.connectionRef).toBeNull();
  expect(x.f.agent(healthy)?.state).toBe('thinking');
  expect(x.f.agent(codex)?.state).toBe('thinking');
  expect(x.runners.get(healthy)!.value.stop).not.toHaveBeenCalled();
});
it.each(['workspace', 'connection'])('starts with a damaged %s, serves healthy agents and allows recovery', async damage => {
  const x = await fixture(), broken = x.ids[2]!;
  await x.f.close();
  if (damage === 'workspace') {
    expect(dirs).toContain(x.connections[2].workspace);
    fs.renameSync(x.connections[2].workspace, path.join(dir(), 'moved-workspace'));
  } else fs.writeFileSync(path.join(x.f.config.dataDir, x.f.team!.get(broken)!.connectionRef!), '{broken');
  const f = new Foreman({ config: x.f.config, logger: silentLogger }); cores.push(f);
  const backend = new ObserverBackend(f, undefined, (c, store, events) => c.provider === 'claude'
    ? new ClaudeAdapter(c, store, events, runner(c.sessionId).value)
    : new CodexAdapter(c as Extract<typeof c, { transport: 'codex-desktop' }>, store, events, { call: async (binding, tool) => tool === 'read_thread'
      ? { thread: { id: binding.threadId, status: { type: 'idle' } }, turns: [] } : { threadId: binding.threadId } }));
  await f.start(backend);
  for (const id of x.ids.filter(id => id !== broken)) await until(() => f.agent(id)?.controls?.message === true);
  expect(f.agent(broken)?.controls?.message).toBe(false);
  f.teamAction('team.archive', { id: broken, revision: f.team!.snapshot().revision });
  f.teamAction('team.restore', { id: broken, revision: f.team!.snapshot().revision });
  f.teamAction('team.archive', { id: broken, revision: f.team!.snapshot().revision });
  await backend.onStudioAction('connection.unbind', { id: broken, revision: f.team!.snapshot().revision });
  expect(f.team!.get(broken)).toMatchObject({ archived: true, connectionRef: null });
  await backend.onChatMessage('Healthy after recovery', x.ids[0]!);
  expect(f.agent(x.ids[0]!)?.state).toBe('thinking');
});
it.each(['unavailable', 'interrupted', 'error'] as const)('releases an inactive Codex in %s through all lifecycle operations', async phase => {
  const x = await fixture(), id = x.ids[0]!;
  for (const action of ['team.update', 'team.disable', 'team.archive', 'connection.unbind']) {
    // Restore and enable between independent lifecycle operations.
    if (x.f.team!.get(id)?.archived) x.f.teamAction('team.restore', { id, revision: x.f.team!.snapshot().revision });
    if (!x.f.team!.get(id)?.enabled) {
      x.f.teamAction('team.update', { id, revision: x.f.team!.snapshot().revision, patch: { enabled: true } });
      await until(() => x.f.agent(id)?.controls?.message === true);
    }
    x.callbacks.get(id)!.activity(phase);
    if (phase === 'interrupted') expect(x.f.agent(id)?.controls?.stop).toBe(true);
    const payload = { id, revision: x.f.team!.snapshot().revision, ...(action === 'team.update' ? { patch: { name: 'Renamed' } } : {}) };
    if (action === 'connection.unbind') await x.backend.onStudioAction(action, payload);
    else x.f.teamAction(action, payload);
    expect(x.f.agent(x.ids[1]!)?.controls?.message).toBe(true);
  }
});
it('polls read only their connection and reuse the parsed common team revision', async () => {
  const x = await fixture();
  const read = vi.spyOn(fs, 'readFileSync');
  try {
    await (x.adapters.get(x.ids[0]!) as CodexAdapter).chat.poll();
    const files = read.mock.calls.map(c => String(c[0]));
    for (const id of x.ids.slice(1)) expect(files).not.toContain(path.join(x.f.config.dataDir, x.f.team!.get(id)!.connectionRef!));
    expect(files.filter(f => f === x.f.team!.file).length).toBeLessThanOrEqual(1);
  } finally { read.mockRestore(); }
});
