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
  for (const profile of Object.values(template.roles)) for (const phrases of Object.values(profile.events)) {
    expect(phrases.length).toBeGreaterThanOrEqual(5); expect(phrases.length).toBeLessThanOrEqual(10);
  }
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
it('selects all event pools and directs peer cues to the other role without feeding a conversation', () => {
  const h = setup();
  for (const event of PERSONA_EVENTS) { h.speech.say('wren', event); h.advance(); }
  expect(h.emitted.map(m => m.type === 'agent.say' && m.text)).toEqual(PERSONA_EVENTS.map(event => `${event}: first`));
  expect(h.emitted.at(-1)).toMatchObject({ type: 'agent.say', agentId: 'wren', to: 'marlow' });
  expect(h.emitted.every(m => m.type === 'agent.say')).toBe(true);
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
  backend.onObserverUpdate({ v: 1, type: 'observer.update', key: 'chat/task', title: 'Task', state: 'error', ci: 'fail', activity: 'Failed' });
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
  await h.fm.handle({ v: 1, id: 'scene', type: 'agent.scene', agentId: 'wren', event: 'dance' }, m => replies.push(m));
  expect(say).toHaveBeenCalledWith('wren', 'dance');
  expect(replies.at(-1)).toMatchObject({ type: 'ack', ok: true });
  expect(JSON.stringify(h.fm.store.data)).toBe(before);
  for (const patch of [{ state: 'editing' as const }, { state: 'idle' as const, paused: true }, { paused: false, active: false }]) {
    h.fm.setAgent('wren', patch);
    await h.fm.handle({ v: 1, type: 'agent.scene', agentId: 'wren', event: 'dance' }, () => {});
  }
  expect(say).toHaveBeenCalledTimes(1);
  expect(parseClientMessage({ v: 1, type: 'agent.scene', agentId: 'wren', event: 'task_finished' }).ok).toBe(false);
});
