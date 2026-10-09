import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { Foreman } from '../src/foreman.js';
import { ForemanServer } from '../src/server.js';
import { ObserverBackend } from '../src/agents/observer.js';
import { silentLogger } from '../src/context.js';
import { tempDir, testConfig, rmrf } from './helpers.js';
import type { AdapterEvents } from '../src/agent-adapters.js';
import { AgentMessaging } from '../src/agent-messaging.js';
import { WorkspaceReader } from '../src/claude-workspace-access.js';
import { claudeWorkspace } from '../src/claude-workspace.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of cleanup.splice(0).reverse()) await f(); });
async function fixture() {
  const home = tempDir('peer-messages-');
  const f = new Foreman({ config: testConfig(home, ['--backend', 'observer']), logger: silentLogger });
  const events = new Map<string, AdapterEvents>(), sends = new Map<string, ReturnType<typeof vi.fn>>();
  const backend = new ObserverBackend(f, undefined, (c, _s, e) => {
    events.set(c.agentId, e); const send = vi.fn(async () => ({ chatDelivered: true })); sends.set(c.agentId, send);
    return { start: () => e.activity('idle'), dispose: async () => {}, busy: () => false, send, control: async () => ({}) };
  });
  await f.start(backend);
  const server = new ForemanServer(f, { host: '127.0.0.1', port: 0, validateOutbound: true, log: silentLogger });
  const port = await server.start(); f.config.port = port;
  cleanup.push(async () => { await server.stop(); await f.close(); rmrf(home); });
  const action = (action: string, payload: Record<string, unknown> = {}) => backend.onStudioAction(action, payload);
  const ids: string[] = [], workspaces = new Map<string, string>();
  for (const provider of ['codex', 'claude', 'codex'] as const) {
    f.teamAction('team.create', { revision: f.team!.snapshot().revision, agent: { name: 'Agent ' + ids.length, provider,
      roles: ['planner', 'developer', 'reviewer'], enabled: true, visible: true, appearance: { skin: 'marlow', color: '#123456', slim: false } } });
    const id = f.team!.snapshot().agents.at(-1)!.id; ids.push(id);
    let connection;
    if (provider === 'codex') connection = { provider, transport: 'codex-desktop', threadId: randomUUID(), hostId: 'local', title: id, pipePath: '\\\\.\\pipe\\codex-browser-use-peer-test' };
    else {
      const workspace = path.join(home, 'workspace'); fs.mkdirSync(workspace); workspaces.set(id, workspace);
      const sessionId = randomUUID(); fs.writeFileSync(path.join(workspace, 'conversation.json'), JSON.stringify({ version: 1, sessionId }));
      fs.writeFileSync(path.join(workspace, 'access.json'), JSON.stringify({ version: 1, repositories: [{ id: 'test', name: 'Test', path: home }] }));
      for (const name of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) fs.writeFileSync(path.join(workspace, name), 'Fixture');
      connection = { provider, transport: 'claude-code', workspace, sessionId };
    }
    await action('connection.bind', { id, revision: f.team!.snapshot().revision, connection });
  }
  const [a, b, other] = ids as [string, string, string];
  const mailbox = () => (backend as any).teamStudio.messaging as AgentMessaging;
  const permit = (id: string) => JSON.parse(fs.readFileSync(mailbox().credentialFile(id), 'utf8'));
  const auth = (id: string) => ({ agentId: id, token: permit(id).token });
  const send = (from = a, to = b, requestId = 'one', text = 'Какие проверки нужны?', extra = {}) => action('message.send', { ...auth(from), to, requestId, text, ...extra });
  const restart = async () => {
    await backend.stop();
    f.store.data.backend.agentMessaging = JSON.parse(fs.readFileSync(path.join(f.config.dataDir, 'state.json'), 'utf8')).backend.agentMessaging;
    await backend.start();
  };
  const disable = (id: string) => f.teamAction('team.update', { id, revision: f.team!.snapshot().revision, patch: { enabled: false } });
  return { f, backend, action, ids, a, b, other, home, port, events, sends, mailbox, permit, auth, send, restart, disable, workspaces };
}

it('addresses only the selected agent, persists source in both histories and game feed, confirms delivery and deduplicates', async () => {
  const x = await fixture(); const first = await x.send();
  expect(first).toMatchObject({ from: x.a, to: x.b, status: 'queued', duplicate: false });
  expect(await x.send()).toMatchObject({ id: first.id, duplicate: true });
  await x.mailbox().tick();
  expect(x.sends.get(x.b)).toHaveBeenCalledTimes(1); expect(x.sends.get(x.other)).not.toHaveBeenCalled();
  const wire = x.sends.get(x.b)!.mock.calls[0]![0] as string;
  expect(wire).toContain(`Сообщение от агента Agent 0 (${x.a})`); expect(wire).toContain('НЕ пользователь');
  for (const id of [x.a, x.b]) {
    const view = await x.action('connection.get', { id });
    expect((view.history as any[]).find(r => r.id === first.id)).toMatchObject({ role: 'agent', source: { agentId: x.a, to: x.b, messageId: first.id, threadId: first.threadId } });
    expect(x.f.store.logTail(id).some(l => l.text.includes('Сообщение от агента'))).toBe(true);
  }
  expect(x.f.store.data.feed.some(r => r.kind === 'message' && r.agentId === x.a && r.to === x.b)).toBe(true);
  expect((await x.action('message.list', x.auth(x.a))).messages).toMatchObject([{ id: first.id, status: 'delivered' }]);
  // Native providers use a user transport role, but the bridge retains verified provenance.
  x.events.get(x.b)!.history([{ id: 'native', role: 'user', text: wire }]);
  expect((await x.action('connection.get', { id: x.b })).history).toMatchObject([{ role: 'agent', source: { messageId: first.id } }]);
  const final = vi.fn(); (x.backend as any).runtime.onFinal = final;
  x.events.get(x.b)!.text('{"status":"done"}', true); expect(final).not.toHaveBeenCalled();
  await x.restart(); expect(await x.send()).toMatchObject({ status: 'delivered', duplicate: true });
  await x.mailbox().tick(); expect(x.sends.get(x.b)).not.toHaveBeenCalled();
});

it('queues busy recipients across restart and rejects disabled, foreign, self and replaced connections', async () => {
  const x = await fixture(); x.events.get(x.b)!.activity('working');
  await x.send(); await x.mailbox().tick(); expect(x.sends.get(x.b)).not.toHaveBeenCalled();
  await x.restart(); await x.mailbox().tick(); expect(x.sends.get(x.b)).toHaveBeenCalledTimes(1);
  await expect(x.send(x.a, x.a, 'self')).rejects.toThrow('самому');
  await expect(x.send(x.a, 'missing', 'foreign')).rejects.toThrow('включёнными');
  x.events.get(x.other)!.activity('working'); await x.send(x.a, x.other, 'disable');
  x.events.get(x.other)!.activity('idle'); x.disable(x.other); await x.mailbox().tick();
  expect(x.mailbox().data.messages.at(-1)!.status).toBe('rejected');
  await expect(x.send(x.a, x.other, 'disabled')).rejects.toThrow('включёнными');
  const old = x.auth(x.b), workspace = x.workspaces.get(x.b)!;
  fs.writeFileSync(path.join(workspace, 'conversation.json'), JSON.stringify({ version: 1, sessionId: randomUUID() }));
  await expect(x.action('message.list', old)).rejects.toThrow();
});

it('closes one pair thread after ten messages including both directions; restart and omitted thread do not reset it', async () => {
  const x = await fixture(); let threadId: unknown;
  for (let n = 0; n < 10; n++) {
    const r = await x.send(n % 2 ? x.b : x.a, n % 2 ? x.a : x.b, 'm' + n, 'Обсуждение ' + n, threadId ? { threadId } : {});
    threadId = r.threadId;
  }
  expect(x.f.decisions.open()).toHaveLength(1); expect(x.f.decisions.open()[0]!.context).toContain('Обсуждение 9');
  await expect(x.send(x.a, x.b, 'eleven')).rejects.toThrow('закрыта');
  await x.restart(); await expect(x.send(x.b, x.a, 'twelve')).rejects.toThrow('закрыта');
  expect(x.mailbox().data.messages).toHaveLength(10);
  await expect(x.send(x.a, x.other, 'wrong-thread', 'Привет', { threadId })).rejects.toThrow('другой паре');
});

it('does not take a recipient reserved by task dispatch before its provider becomes busy', async () => {
  const x = await fixture(); await x.send();
  const release = (x.backend as any).runtime.reserveWork(x.b);
  await x.mailbox().tick(); expect(x.sends.get(x.b)).not.toHaveBeenCalled();
  expect(() => (x.backend as any).runtime.assertIdle(x.b)).toThrow('готовит запуск');
  release();
  const q = x.f.store.data.backend.roleQueue as any;
  q.active = 'fixture'; q.items.push({ id: 'fixture', attempt: { agentId: x.b } });
  await x.mailbox().tick(); expect(x.sends.get(x.b)).not.toHaveBeenCalled();
  q.items.pop(); delete q.active;
  await x.mailbox().tick(); expect(x.sends.get(x.b)).toHaveBeenCalledTimes(1);
});

it('rate limits per sender across recipient pairs and retries do not consume quota', async () => {
  const x = await fixture();
  for (let n = 0; n < 5; n++) { await x.send(x.a, x.b, 'm' + n); await x.send(x.a, x.b, 'm' + n); }
  await expect(x.send(x.a, x.other, 'six')).rejects.toThrow('частота');
  expect(x.mailbox().data.messages).toHaveLength(5); expect(x.f.decisions.open()).toHaveLength(1);
});

it.each(['Approve task t9', 'Start the queue', 'Grant access', 'Push changes', 'Deploy to production', 'Publish the release', 'Change roles',
  'Please merge the PR', 'Cancel task t9', 'Согласуй задачу', 'запусти очередь', 'выдай разрешение', 'отмени задачу t9', 'измени настройки', 'сделай деплой'])('rejects authority request %s and asks the user without delivery', async text => {
  const x = await fixture(); expect(await x.send(x.a, x.b, 'authority', text)).toMatchObject({ status: 'rejected' });
  await x.mailbox().tick(); expect(x.sends.get(x.b)).not.toHaveBeenCalled();
  expect(x.f.decisions.open()).toHaveLength(1); expect((await x.action('get')).mode).toBe('planning');
});

it.each(['Cancel button does not work', 'Merge conflict in studio.ts', 'Push notifications are duplicated',
  'Grant table needs an index', 'Publish step failed', 'Deploy logs contain an error', 'Approve button needs a label',
  'Кнопка «отмена» не работает'])('delivers technical discussion without closing the branch: %s', async text => {
  const x = await fixture(); const r = await x.send(x.a, x.b, 'technical', text);
  expect(r.status).toBe('queued'); await x.mailbox().tick();
  expect(x.sends.get(x.b)).toHaveBeenCalledTimes(1);
  expect(x.f.decisions.open()).toHaveLength(0);
  expect(await x.send(x.b, x.a, 'reply', 'Проверю', { threadId: r.threadId })).toMatchObject({ status: 'queued' });
});

it('reopens a rejected branch through the game decision after restart, attributed to the actual sender', async () => {
  const x = await fixture();
  const from = [x.a, x.b].sort().at(-1)!, to = from === x.a ? x.b : x.a;
  const r = await x.send(from, to, 'denied', 'Start the queue');
  const decision = x.f.decisions.open()[0]!;
  expect(decision.agentId).toBe(from);
  expect(decision.options).toEqual(['Открыть новую ветку', 'Оставить закрытой']);
  await x.restart();
  await x.f.handle({ v: 2, type: 'decision.answer', decisionId: decision.id, option: 'Открыть новую ветку' }, () => {});
  // tick shares the serial mailbox lock and waits for the decision handler.
  await x.mailbox().tick();
  const next = x.mailbox().data.threads.at(-1)!;
  expect(next.id).not.toBe(r.threadId); expect(x.f.decisions.open()).toHaveLength(0);
  expect(await x.send(from, to, 'continued')).toMatchObject({ threadId: next.id, status: 'queued' });
  expect(await x.action('message.reset', { threadId: r.threadId })).toEqual({ threadId: next.id });
  expect(x.mailbox().data.threads).toHaveLength(2);
  await expect(x.send(from, to, 'old', 'Обсуждение', { threadId: r.threadId })).rejects.toThrow('закрыта');
});

it('keeps a branch closed when the user chooses so; plain text does not grant reopening', async () => {
  const x = await fixture(); await x.send(x.a, x.b, 'denied', 'Start the queue');
  const d = x.f.decisions.open()[0]!;
  await x.f.answerDecision(d.id, undefined, 'Сообщение пользователя'); await x.mailbox().tick();
  expect(d.status).toBe('open'); expect(x.mailbox().data.threads).toHaveLength(1);
  await x.f.answerDecision(d.id, 'Оставить закрытой'); await x.mailbox().tick();
  expect(d.status).toBe('answered');
  await expect(x.send(x.a, x.b, 'next')).rejects.toThrow('закрыта');
  expect((await x.action('get')).mode).toBe('planning');
});

it('opens a fresh branch after ten delivered messages without resetting the sender rate limit', async () => {
  const x = await fixture();
  for (let n = 0; n < 10; n++) {
    await x.send(n % 2 ? x.b : x.a, n % 2 ? x.a : x.b, 'limit' + n);
    await x.mailbox().tick();
    x.events.get(x.a)!.activity('idle'); x.events.get(x.b)!.activity('idle');
  }
  const d = x.f.decisions.open()[0]!;
  await x.f.answerDecision(d.id, 'Открыть новую ветку'); await x.mailbox().tick();
  expect(x.mailbox().data.threads).toHaveLength(2); expect(x.f.decisions.open()).toHaveLength(0);
  await expect(x.send(x.a, x.b, 'too-soon')).rejects.toThrow('частота');
  expect(x.f.decisions.open()).toHaveLength(1);
});

it.each(['queued', 'uncertain'] as const)('keeps the question actionable until %s delivery is settled', async status => {
  const x = await fixture(); const r = await x.send();
  if (status === 'uncertain') { x.sends.get(x.b)!.mockRejectedValueOnce(new Error('Timeout')); await x.mailbox().tick(); }
  else { x.events.get(x.b)!.activity('working'); await x.send(x.b, x.a, 'denied', 'Start the queue'); }
  const d = x.f.decisions.open()[0]!;
  await x.f.answerDecision(d.id, 'Открыть новую ветку'); await x.mailbox().tick();
  expect(d.status).toBe('open'); expect(x.mailbox().data.threads).toHaveLength(1);
  if (status === 'uncertain') await x.action('message.resolve', { id: r.id, status: 'rejected', note: 'Проверено' });
  else { x.events.get(x.b)!.activity('idle'); await x.mailbox().tick(); }
  await x.f.answerDecision(d.id, 'Открыть новую ветку'); await x.mailbox().tick();
  expect(d.status).toBe('answered'); expect(x.mailbox().data.threads).toHaveLength(2);
});

it('exposes a later delivery failure even after the earlier limit question was answered', async () => {
  const x = await fixture(); await x.send(); await x.send(x.b, x.a, 'denied', 'Start the queue');
  const d = x.f.decisions.open()[0]!;
  x.events.get(x.b)!.activity('working');
  await x.f.answerDecision(d.id, 'Оставить закрытой'); await x.mailbox().tick();
  x.events.get(x.b)!.activity('idle'); x.sends.get(x.b)!.mockRejectedValueOnce(new Error('Timeout'));
  await x.mailbox().tick();
  expect(x.f.decisions.open()).toHaveLength(1); expect(x.f.decisions.open()[0]!.id).not.toBe(d.id);
});

it('provides service instructions separately from the visible user message', async () => {
  const x = await fixture();
  await x.action('connection.send', { id: x.a, text: 'Обсудим тесты', purpose: 'message' });
  const prompt = x.sends.get(x.a)!.mock.calls[0]![0] as string;
  expect(prompt).toBe('Обсудим тесты');
  const instructions = x.events.get(x.a)!.messageInstructions!()!;
  expect(instructions).toContain('MCP agent_message/agent_messages');
  expect(instructions).toContain(x.mailbox().credentialFile(x.a)); expect(instructions).not.toContain(x.permit(x.a).token);
  expect((await x.action('connection.get', { id: x.a })).history).toMatchObject([{ role: 'user', text: prompt }]);
  expect(x.f.store.logTail(x.a).some(l => l.text.includes('messaging.json'))).toBe(false);
  expect(x.f.store.data.messages.at(-1)?.text).toBe(prompt);
});

it('preserves uncertain sends after crash without retrying or claiming successful delivery', async () => {
  const x = await fixture(); await x.send();
  x.sends.get(x.b)!.mockRejectedValueOnce(new Error('Provider timeout'));
  await x.mailbox().tick(); expect(x.mailbox().data.messages[0]!.status).toBe('uncertain');
  await x.restart(); await x.mailbox().tick(); expect(x.sends.get(x.b)).not.toHaveBeenCalled();
  expect(await x.send()).toMatchObject({ status: 'uncertain', duplicate: true });
  const m = x.mailbox().data.messages[0]!; m.status = 'sending'; x.f.store.flush();
  await x.restart(); expect(x.mailbox().data.messages[0]!.status).toBe('uncertain');
  expect(x.f.decisions.open()).toHaveLength(1);
  await expect(x.action('message.reset', { threadId: m.threadId })).rejects.toThrow('незавершённую');
  await x.action('message.resolve', { id: m.id, status: 'rejected', note: 'Оператор проверил исходный разговор.' });
  const next = await x.action('message.reset', { threadId: m.threadId });
  expect(next.threadId).not.toBe(m.threadId);
  expect(x.f.decisions.open()).toHaveLength(0);
  expect(await x.send(x.a, x.b, 'after-resolution', 'Продолжаем обсуждение')).toMatchObject({ threadId: next.threadId, status: 'queued' });
});

it('uses real Claude workspace calls and Codex CLI scoped credentials, without operator commands or sender spoofing', async () => {
  const x = await fixture(), reader = await WorkspaceReader.open(x.workspaces.get(x.b)!);
  const r = await reader.call('agent_message', { to: x.a, requestId: 'claude', text: 'Проверка связи' }) as Record<string, unknown>;
  expect(r).toMatchObject({ from: x.b, to: x.a, status: 'queued' });
  await expect(reader.call('agent_message', { to: x.a, requestId: 'spoof', text: 'Hi', agentId: x.other })).rejects.toThrow();
  const file = path.join(x.home, 'reply.json'); fs.writeFileSync(file, JSON.stringify({ requestId: 'codex', text: 'Ответ', threadId: r.threadId }));
  const cli = (...args: string[]) => promisify(execFile)(process.execPath, [path.join(x.f.config.projectRoot, 'tools/studio.mjs'), ...args], { windowsHide: true, timeout: 15000 });
  const reply = JSON.parse((await cli('message', '--to', x.b, '--file', file, '--permit', x.mailbox().credentialFile(x.a))).stdout);
  expect(reply).toMatchObject({ from: x.a, to: x.b, threadId: r.threadId });
  for (const action of ['start', 'approve', 'cancel', 'settings', 'draft.grant', 'message.reset'])
    await expect(x.action(action, x.auth(x.a))).rejects.toThrow();
  await expect(cli('start', '--permit', x.mailbox().credentialFile(x.a))).rejects.toMatchObject({ code: 1 });
  await expect(x.action('message.list', { ...x.auth(x.a), agentId: x.other })).rejects.toThrow('Разрешение');
  expect(await reader.call('agent_messages', {})).toMatchObject({ messages: [{ from: x.a }, { from: x.b }] });
  const workspace = claudeWorkspace(x.workspaces.get(x.b)!);
  const config = JSON.parse(workspace.args[workspace.args.indexOf('--mcp-config') + 1]!).mcpServers.klava;
  const client = new Client({ name: 'peer-mcp-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: config.args, stderr: 'pipe' }));
    const result = await client.callTool({ name: 'agent_message', arguments: { to: x.a, requestId: 'claude', text: 'Проверка связи' } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as any[])[0].text)).toMatchObject({ id: r.id, duplicate: true, from: x.b });
  } finally { await client.close(); }
});

it.each(['/messenger', '/'])('keeps websocket peer scope sticky at %s and exposes no operator snapshot', async endpoint => {
  const x = await fixture(), ws = new WebSocket(`ws://127.0.0.1:${x.port}${endpoint}`);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = (value: any) => new Promise<any>(resolve => {
    const id = randomUUID(); const receive = (raw: WebSocket.RawData) => { const m = JSON.parse(raw.toString());
      if (m.type === 'ack' && m.re === id) { ws.off('message', receive); resolve(m); } };
    ws.on('message', receive); ws.send(JSON.stringify({ v: 2, id, ...value }));
  });
  const snapshots: any[] = []; ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.type === 'snapshot') snapshots.push(m); });
  try {
    await send({ type: 'hello', protocol: 2, modVersion: 'test', client: 'studio-messenger' });
    await send({ type: 'hello', protocol: 2, modVersion: 'test', client: 'studio-control' });
    for (const action of ['start', 'approve', 'connection.send', 'message.reset', 'draft.grant'])
      expect(await send({ type: 'studio.action', action, payload: x.auth(x.a) })).toMatchObject({ ok: false });
    expect(await send({ type: 'studio.action', action: 'message.list', payload: x.auth(x.a) })).toMatchObject({ ok: true });
    expect(snapshots.every(s => s.agents.length === 0 && s.tasks.length === 0 && s.repos.length === 0)).toBe(true);
  } finally { ws.close(); }
});
