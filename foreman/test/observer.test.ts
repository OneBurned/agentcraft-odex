import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObserverBackend, REST_DELAY_MS } from '../src/agents/observer.js';
import { parseClientMessage, type ClientMessage, type ObserverUpdate, type Outbound } from '../src/protocol.js';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

const homes: string[] = [];
const harnesses: Harness[] = [];
async function setup(home = tempDir('ac-observer-')) {
  if (!homes.includes(home)) homes.push(home);
  const h = makeForeman(home, ['--backend', 'observer']);
  harnesses.push(h);
  const backend = new ObserverBackend(h.fm, `${home}/no-chat-binding.json`);
  await h.fm.start(backend);
  return { ...h, backend };
}
const update = (patch: Partial<ObserverUpdate> = {}): ObserverUpdate => ({
  v: 1, type: 'observer.update', id: 'u1', key: 'chat/task', title: 'Проверка TradeRecord',
  state: 'editing', activity: 'Редактирую интеграцию', ...patch,
});
async function send(h: Harness, msg: ClientMessage) {
  const replies: Outbound[] = [];
  await h.fm.handle(msg, m => replies.push(m));
  return replies.find(m => m.type === 'ack');
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.fm.close();
  for (const home of homes.splice(0)) rmrf(home);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Codex observer', () => {
  it('publishes task, activity and actual check results without creating worktrees or decisions', async () => {
    const h = await setup();
    expect((await send(h, update()))?.ok).toBe(true);
    expect(h.fm.requireAgent('marlow')).toMatchObject({ name: 'Codex', state: 'editing', station: 'desk' });
    await send(h, update({ state: 'testing', ci: 'running' }));
    await send(h, update({ state: 'done', ci: 'pass', summary: 'Проверки пройдены' }));
    expect(h.fm.tasks.list()).toHaveLength(1);
    expect(h.fm.tasks.list()[0]).toMatchObject({ status: 'done', ci: 'pass', summary: 'Проверки пройдены' });
    expect(h.fm.currentGoal()).toMatchObject({ status: 'done', progress: 1 });
    expect(h.fm.decisions.open()).toHaveLength(0);
    expect(h.fm.repos.list()).toHaveLength(0);
  });

  it('restores the same task after restart, waits for a fresh report and supports recovery from a blocked check', async () => {
    const h = await setup();
    await send(h, update({ state: 'error', ci: 'fail' }));
    const taskId = h.fm.tasks.list()[0]!.id;
    await h.fm.close();
    const resumed = await setup(h.home);
    expect(resumed.fm.requireAgent('marlow').state).toBe('idle');
    await send(resumed, update({ state: 'testing', ci: 'running' }));
    expect(resumed.fm.tasks.list()).toHaveLength(1);
    expect(resumed.fm.tasks.list()[0]).toMatchObject({ id: taskId, status: 'doing', ci: 'running' });
  });

  it('refuses game control before any state mutation', async () => {
    const h = await setup();
    await send(h, update());
    const before = JSON.stringify(h.fm.store.data);
    await expect(h.fm.submitGoal('CLI goal')).rejects.toThrow('Observer mode');
    for (const msg of [
      { type: 'goal.submit', text: 'Change code' },
      { type: 'agent.action', agentId: 'marlow', action: 'pause' },
      { type: 'task.action', taskId: 't1', action: 'cancel' },
      { type: 'user.message', to: 'all', text: 'Deploy' },
      { type: 'decision.answer', decisionId: 'd1', option: 'Merge' },
    ]) {
      expect((await send(h, { v: 1, id: 'control', ...msg } as ClientMessage))?.ok).toBe(false);
    }
    expect(JSON.stringify(h.fm.store.data)).toBe(before);
  });

  it('expires stale activity without claiming that external work completed', async () => {
    const h = await setup();
    await send(h, update());
    vi.spyOn(h.fm.ctx, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    h.backend.expireActivity();
    expect(h.fm.requireAgent('marlow').state).toBe('idle');
    expect(h.fm.tasks.list()[0]!.status).toBe('doing');
  });

  it('walks to the desk for a chat, holds there after the answer, then rests without completing development tasks', async () => {
    const h = await setup(); vi.useFakeTimers();
    await send(h, update());
    h.backend.onChatActivity({ key: 'chat/old', phase: 'completed' });
    h.backend.onChatActivity({ key: 'chat/new', phase: 'working', startedAt: h.fm.ctx.now() + 1 });
    expect(h.fm.requireAgent('marlow')).toMatchObject({ state: 'thinking', station: 'desk' });
    expect(h.fm.requireAgent('marlow').taskId).toBeUndefined();
    h.backend.onChatActivity({ key: 'chat/new', phase: 'completed' });
    expect(h.fm.requireAgent('marlow')).toMatchObject({ state: 'done', station: 'desk' });
    vi.advanceTimersByTime(REST_DELAY_MS - 1);
    h.backend.onChatActivity({ key: 'chat/new', phase: 'completed' });
    expect(h.fm.requireAgent('marlow').station).toBe('desk');
    vi.advanceTimersByTime(1);
    expect(h.fm.requireAgent('marlow').station).toBe('lounge');
    expect(h.fm.tasks.list()[0]!.status).toBe('doing');
  });

  it('keeps detailed stages, temporarily waits for native approval, then restores the stage', async () => {
    const h = await setup();
    h.backend.onChatActivity({ key: 'chat/1', phase: 'working' });
    await send(h, update({ state: 'testing' }));
    h.backend.onChatActivity({ key: 'chat/1', phase: 'working' });
    expect(h.fm.requireAgent('marlow')).toMatchObject({ state: 'testing', station: 'testbench' });
    h.backend.onChatActivity({ key: 'chat/1', phase: 'waiting' });
    expect(h.fm.requireAgent('marlow')).toMatchObject({ state: 'waiting_user', station: 'user' });
    await send(h, update({ state: 'testing' }));
    expect(h.fm.requireAgent('marlow').state).toBe('waiting_user');
    h.backend.onChatActivity({ key: 'chat/1', phase: 'working' });
    expect(h.fm.requireAgent('marlow')).toMatchObject({ state: 'testing', station: 'testbench' });
    await send(h, update({ state: 'waiting_user' }));
    h.backend.onChatActivity({ key: 'chat/1', phase: 'completed' });
    expect(h.fm.requireAgent('marlow').state).toBe('waiting_user');
    h.backend.onChatActivity({ key: 'chat/2', phase: 'working', startedAt: Date.now() + 1 });
    expect(h.fm.requireAgent('marlow')).toMatchObject({ state: 'thinking', station: 'desk' });
  });

  it('keeps a fresh report arriving before the first poll of a new turn, but clears the old turn on a quick reply', async () => {
    const h = await setup();
    h.backend.onChatActivity({ key: 'chat/old', phase: 'completed' });
    const startedAt = h.fm.ctx.now();
    await send(h, update({ state: 'reading' }));
    h.backend.onChatActivity({ key: 'chat/new', phase: 'working', startedAt });
    expect(h.fm.requireAgent('marlow')).toMatchObject({ state: 'reading', station: 'library' });
    await send(h, update({ state: 'waiting_user' }));
    h.backend.onChatActivity({ key: 'chat/new', phase: 'completed', startedAt });
    // Codex timestamps have second precision: the next turn can share the same timestamp.
    h.backend.onChatActivity({ key: 'chat/next', phase: 'working', startedAt });
    expect(h.fm.requireAgent('marlow')).toMatchObject({ state: 'thinking', station: 'desk' });
  });

  it('cancels delayed rest when a new message or explicit stage arrives', async () => {
    const h = await setup(); vi.useFakeTimers();
    h.backend.onChatActivity({ key: 'chat/1', phase: 'working' });
    h.backend.onChatActivity({ key: 'chat/1', phase: 'completed' });
    vi.advanceTimersByTime(5000);
    h.backend.onChatActivity({ key: 'chat/2', phase: 'working' });
    vi.advanceTimersByTime(REST_DELAY_MS);
    expect(h.fm.requireAgent('marlow')).toMatchObject({ state: 'thinking', station: 'desk' });
    await send(h, update({ state: 'done' }));
    vi.advanceTimersByTime(5000);
    await send(h, update({ state: 'reading' }));
    vi.advanceTimersByTime(REST_DELAY_MS);
    expect(h.fm.requireAgent('marlow')).toMatchObject({ state: 'reading', station: 'library' });
  });

  it('does not mistake interrupted work or connection loss for completion and resumes after reconnect', async () => {
    const h = await setup(); vi.useFakeTimers();
    h.backend.onChatActivity({ key: 'chat/1', phase: 'completed' });
    expect(h.fm.requireAgent('marlow').state).toBe('idle');
    h.backend.onChatActivity({ key: 'chat/2', phase: 'working' });
    h.backend.onChatActivity({ key: 'chat/2', phase: 'interrupted' });
    expect(h.fm.requireAgent('marlow').state).toBe('blocked');
    h.backend.onChatActivity({ key: 'chat/3', phase: 'working' });
    h.backend.onChatActivity({ key: '', phase: 'unavailable' });
    expect(h.fm.requireAgent('marlow')).toMatchObject({ state: 'idle', station: 'desk' });
    h.backend.onChatActivity({ key: 'chat/3', phase: 'working' });
    expect(h.fm.requireAgent('marlow').state).toBe('thinking');
    h.backend.onChatActivity({ key: 'chat/3', phase: 'completed' });
    h.backend.onChatActivity({ key: '', phase: 'unavailable' });
    vi.advanceTimersByTime(REST_DELAY_MS);
    expect(h.fm.requireAgent('marlow').station).toBe('desk');
    h.backend.onChatActivity({ key: 'chat/3', phase: 'completed' });
    vi.advanceTimersByTime(REST_DELAY_MS);
    expect(h.fm.requireAgent('marlow').station).toBe('lounge');
  });

  it('keeps an active chat at the desk after detailed progress expires', async () => {
    const h = await setup();
    h.backend.onChatActivity({ key: 'chat/1', phase: 'working' });
    await send(h, update({ state: 'reading' }));
    vi.spyOn(h.fm.ctx, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    h.backend.onChatActivity({ key: 'chat/1', phase: 'working' });
    h.backend.expireActivity();
    expect(h.fm.requireAgent('marlow')).toMatchObject({ state: 'thinking', station: 'desk' });
    expect(h.fm.tasks.list()[0]!.status).toBe('doing');
  });

  it('rejects observer events on other backends and rejects invalid payloads', async () => {
    const home = tempDir('ac-observer-'); homes.push(home);
    const h = makeForeman(home, ['--backend', 'sim']); harnesses.push(h);
    expect((await send(h, update()))?.ok).toBe(false);
    expect(h.fm.tasks.list()).toHaveLength(0);
    expect(parseClientMessage(update({ title: ' ' })).ok).toBe(false);
    expect(parseClientMessage(update({ log: 'x'.repeat(2001) })).ok).toBe(false);
  });

  it('routes pause/resume/stop only to the real bound chat controller', async () => {
    const h = await setup();
    const control = vi.spyOn(h.backend, 'onChatControl').mockResolvedValue({ chatControl: 'paused' });
    for (const action of ['pause', 'resume', 'stop']) {
      const ack = await send(h, { v: 1, id: action, type: 'agent.action', agentId: 'marlow', action } as ClientMessage);
      expect(ack?.ok).toBe(true); expect(control).toHaveBeenLastCalledWith(action);
    }
    const rejected = await send(h, { v: 1, id: 'bad', type: 'agent.action', agentId: 'kit', action: 'stop' });
    expect(rejected?.ok).toBe(false); expect(control).toHaveBeenCalledTimes(3);
    h.backend.onChatActivity({ key: 'chat/1', phase: 'paused' });
    expect(h.fm.requireAgent('marlow')).toMatchObject({ paused: true, active: true, state: 'idle' });
    h.backend.onChatActivity({ key: 'chat/2', phase: 'working' });
    expect(h.fm.requireAgent('marlow')).toMatchObject({ paused: false, state: 'thinking', station: 'desk' });
  });
});
