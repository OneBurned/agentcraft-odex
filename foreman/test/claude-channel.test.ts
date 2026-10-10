import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ChannelMailbox, type ChannelOwner } from '../src/claude-channel-mailbox.js';
import { ClaudeChannelAdapter, channelHistory } from '../src/claude-channel.js';
import { TeamRegistry } from '../src/team.js';
import { AgentConnections, type Connection } from '../src/agent-connections.js';
import { acquireConversation } from '../src/claude-conversation.js';
import { writeJsonAtomic } from '../src/util/fsx.js';
import { tempDir, rmrf } from './helpers.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmrf(dir); });
function fixture() {
  const root = tempDir('channel-test-'); dirs.push(root);
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const sessionId: string = randomUUID();
  writeJsonAtomic(path.join(workspace, 'conversation.json'), { version: 1, sessionId });
  writeJsonAtomic(path.join(workspace, 'access.json'), { version: 1, repositories: [{ id: 'test', name: 'Test', path: root }] });
  for (const file of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) fs.writeFileSync(path.join(workspace, file), 'test');
  const team = new TeamRegistry(root), store = new AgentConnections(root, team);
  team.change('create', { revision: 0, agent: { name: 'Test', provider: 'claude', roles: ['reviewer'], enabled: true, visible: true,
    appearance: { skin: 'wren', color: '#112233', slim: false } } }, () => {});
  const agentId = team.snapshot().agents[0]!.id;
  store.bind({ id: agentId, revision: 1, connection: { provider: 'claude', transport: 'claude-channel', workspace, sessionId, executable: process.execPath } }, () => {});
  const c = store.read(agentId) as Extract<Connection, { transport: 'claude-channel' }>;
  acquireConversation(workspace, 'channel');
  const mailbox = new ChannelMailbox(workspace);
  const owner: ChannelOwner = { agentId, sessionId, profile: root, pid: process.pid, childPid: 12345,
    token: randomUUID(), generation: randomUUID(), updated: Date.now(), phase: 'running' };
  mailbox.writeOwner(owner); mailbox.heartbeat(owner);
  const probe = vi.fn(async () => ({ pid: 12345, cwd: workspace, kind: 'interactive', sessionId, status: 'idle' }));
  const messages = vi.fn(async () => [] as any[]);
  const events = { activity: vi.fn(), text: vi.fn(), history: vi.fn() };
  const adapter = () => new ClaudeChannelAdapter(c, store, events, probe, messages);
  const request = () => ({ id: randomUUID(), token: owner.token, generation: owner.generation, sessionId,
    text: 'hello', display: 'hello', created: Date.now() });
  return { root, workspace, owner, mailbox, probe, messages, events, adapter, request };
}
it('claims once across restarts and deduplicates replies without accepting altered/foreign results', () => {
  const f = fixture(), r = f.request(); f.mailbox.enqueue(r);
  expect(f.mailbox.claim(r.id)).toBe(true);
  const restarted = new ChannelMailbox(f.workspace);
  expect(restarted.claim(r.id)).toBe(false);
  expect(restarted.acceptReply(r.id, 'answer', f.owner).duplicate).toBe(false);
  expect(restarted.acceptReply(r.id, 'answer', f.owner).duplicate).toBe(true);
  expect(() => restarted.acceptReply(r.id, 'different', f.owner)).toThrow('другим текстом');
  expect(() => restarted.acceptReply(r.id, 'answer', { ...f.owner, generation: randomUUID() })).toThrow('активному');
  expect(() => restarted.enqueue({ ...r, text: 'other' })).toThrow('другим содержимым');
  expect(() => restarted.file('requests', '../../escape')).toThrow();
  restarted.cancel(r.id);
  expect(() => restarted.acceptReply(r.id, 'answer', f.owner)).toThrow('остановлено');
});
it('persists before delivery, waits for idle after reply and never republishes after restart', async () => {
  const f = fixture(), a = f.adapter();
  await a.send('question', 'message');
  const [id] = f.mailbox.list('requests'); expect(id).toBeTruthy();
  f.mailbox.claim(id!); f.mailbox.acceptReply(id!, 'answer', f.owner);
  f.probe.mockResolvedValue({ pid: 12345, cwd: f.workspace, kind: 'interactive', sessionId: f.owner.sessionId, status: 'working' });
  await a.poll(); expect(f.events.text).not.toHaveBeenCalled();
  f.probe.mockResolvedValue({ pid: 12345, cwd: f.workspace, kind: 'interactive', sessionId: f.owner.sessionId, status: 'idle' });
  await a.poll(); expect(f.events.text).toHaveBeenCalledExactlyOnceWith('answer', true);
  await f.adapter().poll(); expect(f.events.text).toHaveBeenCalledTimes(1);
  expect(f.mailbox.list('requests')).toHaveLength(1);
});
it('keeps an ambiguous delivery pending after a bridge restart; a new channel generation requires explicit continuation', async () => {
  const f = fixture(); await f.adapter().send('question', 'message');
  const [id] = f.mailbox.list('requests'); f.mailbox.claim(id!);
  await f.adapter().poll(); expect(f.mailbox.list('requests')).toHaveLength(1);
  const changed = { ...f.owner, generation: randomUUID() }; f.mailbox.writeOwner(changed); f.mailbox.heartbeat(changed);
  await f.adapter().poll();
  expect(f.events.activity).toHaveBeenLastCalledWith('paused', expect.stringContaining('могла выполниться'));
  expect(f.events.text).not.toHaveBeenCalled();
});
it('refuses offline, busy, wrong-PID and developer dispatch without creating a message', async () => {
  const f = fixture();
  f.probe.mockResolvedValue({ pid: 12345, cwd: f.workspace, kind: 'interactive', sessionId: f.owner.sessionId, status: 'working' });
  await expect(f.adapter().send('x', 'message')).rejects.toThrow('занята');
  f.probe.mockResolvedValue({ pid: 99999, cwd: f.workspace, kind: 'interactive', sessionId: f.owner.sessionId, status: 'idle' });
  await expect(f.adapter().send('x', 'message')).rejects.toThrow('не подтверждена');
  f.mailbox.writeOwner({ ...f.owner, updated: Date.now() - 20000 });
  await expect(f.adapter().send('x', 'message')).rejects.toThrow('launcher');
  await expect(f.adapter().execute('x', { role: 'developer', cwd: f.root })).rejects.toThrow('SDK');
  expect(f.mailbox.list('requests')).toEqual([]);
});
it('pause waits for the launcher receipt, cancels late replies, and stop clears the pending request', async () => {
  const f = fixture(), a = f.adapter(); await a.send('question', 'message');
  const id = f.mailbox.list('requests')[0]!; f.mailbox.claim(id);
  const pause = a.control('pause');
  await new Promise(r => setTimeout(r, 10));
  expect(f.events.activity.mock.calls.some(([phase]) => phase === 'paused')).toBe(false);
  expect(f.mailbox.cancelled(id)).toBe(true);
  const ctl = f.mailbox.list('controls')[0]!;
  f.mailbox.writeOwner({ ...f.owner, phase: 'stopped', childPid: undefined });
  writeJsonAtomic(f.mailbox.file('control-results', ctl), { id: ctl, ok: true });
  await pause; expect(f.events.activity).toHaveBeenLastCalledWith('paused', undefined);
  expect(() => f.mailbox.acceptReply(id, 'late', f.owner)).toThrow('остановлено');
  const stop = a.control('stop'); await new Promise(r => setTimeout(r, 10));
  const next = f.mailbox.list('controls').find(i => i !== ctl)!;
  writeJsonAtomic(f.mailbox.file('control-results', next), { id: next, ok: true }); await stop;
  const state = JSON.parse(fs.readFileSync(path.join(f.root, `agents/${f.owner.agentId}/claude-channel-state.json`), 'utf8'));
  expect(state.pending).toBeUndefined(); expect(state.stopped).toBe(true);
});
it('does not report pause when launcher failed to confirm process termination', async () => {
  const f = fixture(), a = f.adapter(); await a.send('question', 'message');
  const control = a.control('pause'); const rejected = expect(control).rejects.toThrow('still alive');
  await new Promise(r => setTimeout(r, 10));
  const id = f.mailbox.list('controls')[0]!;
  writeJsonAtomic(f.mailbox.file('control-results', id), { id, ok: false, error: 'still alive' });
  await rejected;
  expect(f.events.activity).toHaveBeenLastCalledWith('unavailable', 'still alive');
  expect(a.busy()).toBe(true);
});
it('only explicit resume creates a new event after a generation change, preserving the old request as cancelled', async () => {
  const f = fixture(), a = f.adapter(); await a.send('question', 'message');
  const old = f.mailbox.list('requests')[0]!; f.mailbox.claim(old);
  const nextOwner = { ...f.owner, generation: randomUUID() }; f.mailbox.writeOwner(nextOwner); f.mailbox.heartbeat(nextOwner);
  await a.poll(); expect(f.mailbox.list('requests')).toEqual([old]);
  await a.control('resume');
  const ids = f.mailbox.list('requests'); expect(ids).toHaveLength(2);
  expect(f.mailbox.cancelled(old)).toBe(true);
  const next = f.mailbox.request(ids.find(id => id !== old)!)!;
  expect(next.generation).toBe(nextOwner.generation); expect(next.text).toContain(old);
  expect(next.text).toContain('не повторяй уже выполненные действия');
});
it('start acknowledgement keeps the answer paused until interactive channel confirmation', async () => {
  const f = fixture(), a = f.adapter(); await a.send('question', 'message');
  f.mailbox.writeOwner({ ...f.owner, generation: randomUUID() }); f.mailbox.heartbeat(f.mailbox.owner()!);
  await a.poll();
  f.mailbox.writeOwner({ ...f.mailbox.owner()!, phase: 'stopped', childPid: undefined });
  const resume = a.control('resume'); await new Promise(r => setTimeout(r, 10));
  const id = f.mailbox.list('controls')[0]!;
  writeJsonAtomic(f.mailbox.file('control-results', id), { id, ok: true });
  expect(await resume).toMatchObject({ chatControl: 'paused', notice: expect.stringContaining('Подтверди') });
  expect(f.mailbox.list('requests')).toHaveLength(1);
});
it('tracks native terminal work after reopening a paused channel without publishing partial text as a final answer', async () => {
  const f = fixture(), a = f.adapter(); await a.send('question', 'message');
  const changed = { ...f.owner, generation: randomUUID() }; f.mailbox.writeOwner(changed); f.mailbox.heartbeat(changed);
  await a.poll();
  f.probe.mockResolvedValue({ pid: 12345, cwd: f.workspace, kind: 'interactive', sessionId: f.owner.sessionId, status: 'busy' });
  await a.poll();
  expect(a.busy()).toBe(true);
  expect(f.events.activity).toHaveBeenLastCalledWith('working', expect.stringContaining('терминале'));
  expect(f.messages).not.toHaveBeenCalled();
  expect(f.events.text).not.toHaveBeenCalled();
});
it('restores readable channel and terminal history without envelope, repeated reply or assistant afterword', () => {
  const f = fixture(), r = f.request(); f.mailbox.enqueue(r); f.mailbox.claim(r.id); f.mailbox.acceptReply(r.id, 'answer', f.owner);
  const row = (type: string, content: unknown, extra = {}) => ({ type, uuid: randomUUID(), message: { content }, ...extra });
  const reply = row('assistant', [{ type: 'tool_use', name: 'mcp__agentcraft__reply', input: { event_id: r.id, text: 'answer' } }]);
  const rows = [row('user', `<channel source="agentcraft" event_id="${r.id}">private instructions</channel>`, { origin: { kind: 'channel', server: 'agentcraft' } }),
    reply, reply, row('assistant', 'I sent it'), row('user', 'terminal question'), row('assistant', 'terminal answer')];
  expect(channelHistory(rows as any, f.mailbox).map(r => r.text)).toEqual(['hello', 'answer', 'terminal question', 'terminal answer']);
});
