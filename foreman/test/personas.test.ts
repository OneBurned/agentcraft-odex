import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PERSONA_EVENTS, PersonasFile, PersonaSpeech } from '../src/personas.js';
import { ObserverBackend } from '../src/agents/observer.js';
import type { Outbound } from '../src/protocol.js';
import { parseClientMessage } from '../src/protocol.js';
import { makeForeman, rmrf, tempDir } from './helpers.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
function data() {
  const events = Object.fromEntries(PERSONA_EVENTS.map(event => [event, [`${event}: first`, `${event}: second`]]));
  return { version: 1, minIntervalSeconds: 2, roles: {
    marlow: { description: 'Developer', events }, wren: { description: 'Reviewer', events },
  } };
}
function setup(contents: string | null = JSON.stringify(data())) {
  const dir = tempDir('ac-personas-'), file = path.join(dir, 'personas.json'); cleanup.push(() => rmrf(dir));
  if (contents !== null) fs.writeFileSync(file, contents);
  let now = 100_000;
  const emitted: Outbound[] = [], warn = vi.fn();
  const speech = new PersonaSpeech({ file, now: () => now, random: () => 0, emit: m => emitted.push(m), warn });
  return { file, speech, emitted, warn, advance: (ms = 2000) => { now += ms; } };
}
it('ships five distinct phrases for every event in both roles', () => {
  const template = PersonasFile.parse(JSON.parse(fs.readFileSync(new URL('../../tools/templates/personas.json', import.meta.url), 'utf8')));
  for (const profile of Object.values(template.agents)) for (const phrases of Object.values(profile.events)) {
    expect(phrases.length).toBeGreaterThanOrEqual(5); expect(phrases.length).toBeLessThanOrEqual(10);
  }
});
it('reads the legacy pair without rewriting and saves a third ID in version 2 preserving both profiles', () => {
  const h = setup(); const before = fs.readFileSync(h.file, 'utf8');
  const { notice, ...edit } = h.speech.edit('agent_third');
  expect(edit.description).toContain('Нейтральный');
  expect(h.speech.description('agent_third')).toBeUndefined();
  expect(fs.readFileSync(h.file, 'utf8')).toBe(before);
  h.speech.say('agent_third', 'rest'); expect(h.emitted.at(-1)).toMatchObject({ agentId: 'agent_third', text: 'Сейчас отдыхаю.' });
  edit.description = 'Third personality'; edit.events.rest = ['Third A', 'Third B'];
  h.speech.saveEdit(edit);
  const file = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  expect(file.version).toBe(2); expect(file.roles).toBeUndefined();
  expect(file.agents.marlow).toEqual(data().roles.marlow); expect(file.agents.wren).toEqual(data().roles.wren);
  expect(h.speech.description('agent_third')).toBe('Third personality');
  h.advance(); h.speech.say('agent_third', 'rest'); expect(h.emitted.at(-1)).toMatchObject({ text: 'Third A' });
  h.speech.say('another_agent', 'rest'); expect(h.emitted.at(-1)).toMatchObject({ text: 'Сейчас отдыхаю.' });
});
it('uses each of three IDs for independent pools and peer recipients, not provider or display name', () => {
  const agents = Object.fromEntries(['one', 'two', 'three'].map(id => [id, { description: id,
    events: Object.fromEntries(PERSONA_EVENTS.map(e => [e, [`${id} first`, `${id} second`]])) }]));
  const h = setup(JSON.stringify({ version: 2, minIntervalSeconds: 2, agents }));
  for (const [id, peer] of [['one', 'two'], ['two', 'three'], ['three', 'one']]) {
    expect(h.speech.say(id!, 'peer', peer)).toBe(true);
    expect(h.emitted.at(-1)).toMatchObject({ agentId: id, to: peer, text: `${id} first` });
  }
  h.advance(); h.speech.say('one', 'peer', 'three');
  expect(h.emitted.at(-1)).toMatchObject({ agentId: 'one', to: 'three', text: 'one second' });
});
it.each(['marlow', 'wren'] as const)('saves %s atomically, preserves the other role and immediately reloads speech/description', agentId => {
  const h = setup(); const before = PersonasFile.parse(JSON.parse(fs.readFileSync(h.file, 'utf8')));
  const edit = h.speech.edit(agentId); const { notice, ...payload } = edit;
  payload.description = 'Новый характер'; payload.events.rest = ['Новая реплика 1', 'Новая реплика 2'];
  const rename = vi.spyOn(fs, 'renameSync');
  const saved = h.speech.saveEdit(payload);
  expect(saved.revision).not.toBe(edit.revision); expect(saved.description).toBe('Новый характер');
  expect(rename).toHaveBeenCalledOnce(); expect(rename.mock.calls[0]![1]).toBe(h.file);
  expect(String(rename.mock.calls[0]![0])).toMatch(/\.tmp$/);
  const after = PersonasFile.parse(JSON.parse(fs.readFileSync(h.file, 'utf8')));
  expect(after.agents[agentId === 'marlow' ? 'wren' : 'marlow']).toEqual(before.agents[agentId === 'marlow' ? 'wren' : 'marlow']);
  expect(after.minIntervalSeconds).toBe(before.minIntervalSeconds);
  expect(h.speech.description(agentId)).toBe('Новый характер');
  h.speech.say(agentId, 'rest'); expect(h.emitted.at(-1)).toMatchObject({ text: 'Новая реплика 1' });
  expect(fs.readdirSync(path.dirname(h.file))).toEqual(['personas.json']);
});
it('rejects invalid editor inputs without touching the profile', () => {
  const h = setup(); const before = fs.readFileSync(h.file, 'utf8');
  const { notice, ...payload } = h.speech.edit('wren');
  const invalid = [
    { ...payload, agentId: '../other' }, { ...payload, description: '' }, { ...payload, description: 'x'.repeat(2501) },
    { ...payload, events: {} }, { ...payload, file: '../other.json' }, { ...payload, revision: '' },
    ...[['one'], Array.from({ length: 21 }, (_, i) => String(i)), ['same', ' same '], ['', 'valid'], ['x'.repeat(161), 'valid'], [4, 'valid']]
      .map(rest => ({ ...payload, events: { ...payload.events, rest } })),
  ];
  for (const edit of invalid) {
    expect(() => h.speech.saveEdit(edit)).toThrow(); expect(fs.readFileSync(h.file, 'utf8')).toBe(before);
  }
  expect(() => h.speech.saveEdit({ ...payload, events: { ...payload.events, rest: ['same', 'same'] } })).toThrow('не должны повторяться');
});
it('preserves external edits and refuses stale revisions even when editing the other role', () => {
  const h = setup(); const { notice, ...stale } = h.speech.edit('wren');
  const external = data(); external.roles.marlow.description = 'Changed elsewhere';
  const contents = JSON.stringify(external); fs.writeFileSync(h.file, contents);
  expect(() => h.speech.saveEdit(stale)).toThrow('Профиль изменился');
  expect(fs.readFileSync(h.file, 'utf8')).toBe(contents);
});
it('creates a missing file only on explicit save and never replaces a corrupted profile', () => {
  const h = setup(null); const { notice, ...edit } = h.speech.edit('wren');
  expect(notice).toContain('Файла пока нет'); expect(fs.existsSync(h.file)).toBe(false);
  h.speech.saveEdit(edit); expect(PersonasFile.safeParse(JSON.parse(fs.readFileSync(h.file, 'utf8'))).success).toBe(true);
  fs.writeFileSync(h.file, '{broken');
  expect(() => h.speech.edit('wren')).toThrow('повреждён');
  expect(() => h.speech.saveEdit(edit)).toThrow('повреждён'); expect(fs.readFileSync(h.file, 'utf8')).toBe('{broken');
});
it('keeps the original file and current speech usable if atomic replacement fails', () => {
  const h = setup(); const before = fs.readFileSync(h.file, 'utf8');
  const { notice, ...edit } = h.speech.edit('marlow'); edit.description = 'Not saved';
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  expect(() => h.speech.saveEdit(edit)).toThrow('Не удалось сохранить');
  expect(fs.readFileSync(h.file, 'utf8')).toBe(before); expect(h.speech.description('marlow')).toBe('Developer');
  expect(fs.readdirSync(path.dirname(h.file))).toEqual(['personas.json']);
});
it('enforces the total UTF-8 file limit and does not reset speech cooldowns on save', () => {
  const h = setup(); const big = data();
  for (const profile of Object.values(big.roles)) for (const event of PERSONA_EVENTS)
    profile.events[event] = Array.from({ length: 20 }, (_, i) => `${i} ${'я'.repeat(150)}`);
  // Seed one large role, then reject a second role that would exceed the whole-file byte cap.
  const first = data(); first.roles.marlow = big.roles.marlow;
  fs.writeFileSync(h.file, JSON.stringify(first)); const before = fs.readFileSync(h.file, 'utf8');
  const { notice, ...edit } = h.speech.edit('wren'); edit.events = PersonasFile.parse(big).agents.wren!.events;
  expect(() => h.speech.saveEdit(edit)).toThrow('128 КБ'); expect(fs.readFileSync(h.file, 'utf8')).toBe(before);
  h.speech.say('wren', 'rest');
  const { notice: unused, ...small } = h.speech.edit('wren'); small.events.rest = ['Updated first', 'Updated second'];
  h.speech.saveEdit(small); expect(h.speech.say('wren', 'rest')).toBe(false);
  h.advance(); expect(h.speech.say('wren', 'rest')).toBe(true); expect(h.emitted.at(-1)).toMatchObject({ text: 'Updated first' });
});
it('hot-reloads only the configured description for conversation and omits it on missing or invalid files', () => {
  const h = setup();
  expect(h.speech.description('marlow')).toBe('Developer');
  expect(h.speech.description('wren')).toBe('Reviewer');
  const next = data(); next.roles.wren.description = 'Updated reviewer';
  fs.writeFileSync(h.file, JSON.stringify(next));
  expect(h.speech.description('wren')).toBe('Updated reviewer');
  expect(h.emitted).toEqual([]);
  fs.writeFileSync(h.file, '{broken'); expect(h.speech.description('wren')).toBeUndefined();
  fs.unlinkSync(h.file); expect(h.speech.description('marlow')).toBeUndefined();
  fs.writeFileSync(h.file, JSON.stringify(next)); expect(h.speech.description('wren')).toBe('Updated reviewer');
});
it('selects only the actual event, rate-limits per stable ID and never repeats adjacent phrases', () => {
  const h = setup();
  expect(h.speech.say('marlow', 'task_started')).toBe(true);
  expect(h.speech.say('marlow', 'error')).toBe(false);
  expect(h.speech.say('wren', 'error')).toBe(true);
  h.advance(1999); expect(h.speech.say('marlow', 'task_started')).toBe(false);
  h.advance(1); expect(h.speech.say('marlow', 'task_started')).toBe(true);
  h.advance(); h.speech.say('marlow', 'error');
  expect(h.emitted.map(m => m.type === 'agent.say' ? m.text : '')).toEqual([
    'task_started: first', 'error: first', 'task_started: second', 'error: first',
  ]);
  expect(h.speech.say('Renamed Codex', 'task_finished')).toBe(false);
  h.advance(); // suppressed events are never queued and replayed later
  expect(h.emitted).toHaveLength(4);
});
it('selects all event pools and directs peer cues to the supplied nearby agent without feeding a conversation', () => {
  const h = setup();
  for (const event of PERSONA_EVENTS) { h.speech.say('wren', event, 'kit'); h.advance(); }
  expect(h.emitted.map(m => m.type === 'agent.say' && m.text)).toEqual(PERSONA_EVENTS.map(event => `${event}: first`));
  expect(h.emitted.at(-1)).toMatchObject({ type: 'agent.say', agentId: 'wren', to: 'kit' });
  expect(h.emitted.every(m => m.type === 'agent.say')).toBe(true);
});
it('does not invent a peer recipient or consume the cooldown when the recipient is missing', () => {
  const h = setup();
  expect(h.speech.say('wren', 'peer')).toBe(false);
  expect(h.speech.say('wren', 'peer', 'wren')).toBe(false);
  expect(h.emitted).toEqual([]);
  expect(h.speech.say('wren', 'peer', 'agent_new')).toBe(true);
  expect(h.emitted.at(-1)).toMatchObject({ type: 'agent.say', agentId: 'wren', to: 'agent_new' });
});

it('routes a validated peer scene to the actual nearby agent without changing execution', async () => {
  const h = makeForeman(tempDir('ac-persona-peer-'), ['--backend', 'observer']);
  cleanup.push(async () => { await h.fm.close(); rmrf(h.home); });
  h.fm.setAgent('wren', { active: true, paused: false, state: 'idle', station: 'lounge' });
  h.fm.setAgent('kit', { active: true, paused: false, state: 'idle', station: 'lounge' });
  const before = JSON.stringify(h.fm.store.data);
  await h.fm.handle({ v: 2, type: 'agent.scene', agentId: 'wren', peerAgentId: 'kit', event: 'peer' }, () => {});
  expect(h.events).toContainEqual(expect.objectContaining({ type: 'agent.say', agentId: 'wren', to: 'kit' }));
  expect(JSON.stringify(h.fm.store.data)).toBe(before);
});
it('hot-reloads edits, falls back on a malformed file and recovers without repeating warnings', () => {
  const h = setup(); h.speech.say('marlow', 'error');
  fs.writeFileSync(h.file, '{broken'); h.advance(20_000);
  expect(() => h.speech.say('marlow', 'error')).not.toThrow();
  expect(h.emitted.at(-1)).toMatchObject({ text: 'Возникла ошибка. Нужна проверка.' });
  h.advance(20_000); h.speech.say('wren', 'error'); expect(h.warn).toHaveBeenCalledTimes(1);
  const next = data(); next.roles.marlow.events.error = ['new error A', 'new error B'];
  fs.writeFileSync(h.file, JSON.stringify(next)); h.advance(20_000); h.speech.say('marlow', 'error');
  expect(h.emitted.at(-1)).toMatchObject({ text: 'new error A' });
  fs.unlinkSync(h.file); h.advance(20_000); h.speech.say('marlow', 'error');
  expect(h.warn).toHaveBeenCalledTimes(2);
});
it('handles missing, oversized and invalid-schema files with neutral failure phrases', () => {
  for (const contents of [null, '', 'x'.repeat(128001), JSON.stringify({ ...data(), minIntervalSeconds: 0 })]) {
    const h = setup(contents); h.speech.say('wren', 'error');
    expect(h.warn).toHaveBeenCalledOnce();
    expect(h.emitted.at(-1)).toMatchObject({ text: 'Возникла ошибка. Нужна проверка.' });
  }
  const h = setup(''); fs.unlinkSync(h.file); h.speech.say('marlow', 'error');
  expect(h.warn.mock.calls.at(-1)?.[0]).toContain('отсутствует');
  const invalid = data(); invalid.roles.marlow.events.error = ['duplicate', 'duplicate'];
  expect(PersonasFile.safeParse(invalid).success).toBe(false);
});
it('does not celebrate failed observer checks or historical completions, and isolates speech from records', async () => {
  const h = makeForeman(tempDir('ac-persona-events-'), ['--backend', 'observer']);
  const backend = new ObserverBackend(h.fm, path.join(h.home, 'no-binding.json'));
  cleanup.push(async () => { await h.fm.close(); rmrf(h.home); });
  await h.fm.start(backend);
  const say = vi.spyOn(h.fm.personas!, 'say');
  backend.onChatActivity({ key: 'chat/old', phase: 'completed' }); expect(say).not.toHaveBeenCalled();
  backend.onObserverUpdate({ v: 2, type: 'observer.update', key: 'chat/task', title: 'Task', state: 'error', ci: 'fail', activity: 'Failed' });
  backend.onChatActivity({ key: 'chat/old', phase: 'completed' });
  expect(say.mock.calls).toEqual([['marlow', 'error']]);
  const before = JSON.stringify(h.fm.store.data);
  h.fm.personas!.say('wren', 'review_changes');
  expect(JSON.stringify(h.fm.store.data)).toBe(before);
  expect(h.events.at(-1)).toMatchObject({ type: 'agent.say', agentId: 'wren' });
});
it('accepts only real idle scene kinds and ignores a busy or paused character without state mutation', async () => {
  const h = makeForeman(tempDir('ac-persona-scene-'), ['--backend', 'observer']);
  cleanup.push(async () => { await h.fm.close(); rmrf(h.home); });
  const say = vi.spyOn(h.fm.personas!, 'say');
  h.fm.setAgent('wren', { active: true, paused: false, state: 'idle', station: 'lounge' });
  const before = JSON.stringify(h.fm.store.data);
  const replies: Outbound[] = [];
  await h.fm.handle({ v: 2, id: 'scene', type: 'agent.scene', agentId: 'wren', event: 'dance' }, m => replies.push(m));
  expect(say).toHaveBeenCalledWith('wren', 'dance');
  expect(replies.at(-1)).toMatchObject({ type: 'ack', ok: true });
  expect(JSON.stringify(h.fm.store.data)).toBe(before);
  for (const patch of [{ state: 'editing' as const }, { state: 'idle' as const, paused: true }, { paused: false, active: false }]) {
    h.fm.setAgent('wren', patch);
    await h.fm.handle({ v: 2, type: 'agent.scene', agentId: 'wren', event: 'dance' }, () => {});
  }
  expect(say).toHaveBeenCalledTimes(1);
  expect(parseClientMessage({ v: 2, type: 'agent.scene', agentId: 'wren', event: 'task_finished' }).ok).toBe(false);
});
