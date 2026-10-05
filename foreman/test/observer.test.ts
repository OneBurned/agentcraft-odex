import { afterEach, describe, expect, it } from 'vitest';
import { ObserverBackend } from '../src/agents/observer.js';
import { parseClientMessage, type ClientMessage, type ObserverUpdate, type Outbound } from '../src/protocol.js';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

const homes: string[] = [];
const harnesses: Harness[] = [];
async function setup(home = tempDir('ac-observer-')) {
  if (!homes.includes(home)) homes.push(home);
  const h = makeForeman(home, ['--backend', 'observer']);
  harnesses.push(h);
  const backend = new ObserverBackend(h.fm);
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
    h.fm.tasks.list()[0]!.updatedAt = Date.now() - 6 * 60_000;
    h.backend.expireActivity();
    expect(h.fm.requireAgent('marlow').state).toBe('idle');
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
});
