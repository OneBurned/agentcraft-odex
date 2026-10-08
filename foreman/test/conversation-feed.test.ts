import { afterEach, expect, it } from 'vitest';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';
import { FeedItem } from '../src/protocol.js';
import fs from 'node:fs';

const all: Harness[] = [];
it('persists the last user-directed agent by ID beyond feed eviction and restart', async () => {
  const h = makeForeman(tempDir('ac-reply-')); all.push(h);
  expect(h.fm.snapshot()).toMatchObject({ replyAgentId: 'marlow' });
  h.fm.bus.feed('message', 'Ответ', { agentId: 'wren', to: 'user' });
  h.fm.bus.send('user', 'marlow', 'Вопрос');
  h.fm.bus.feed('message', 'Между агентами', { agentId: 'marlow', to: 'wren' });
  h.fm.bus.feed('message', 'Другой агент команды', { agentId: 'kit', to: 'user' });
  for (let i = 0; i < 305; i++) h.fm.bus.feed('task', 'Статус', { agentId: 'marlow' });
  expect(h.fm.snapshot()).toMatchObject({ replyAgentId: 'kit' });
  h.fm.store.flush();
  const restored = makeForeman(h.home);
  try {
    expect(restored.fm.snapshot()).toMatchObject({ replyAgentId: 'kit' });
    restored.fm.bus.feed('decision', 'Вопрос', { agentId: 'marlow', to: 'user' });
    expect(restored.fm.snapshot()).toMatchObject({ replyAgentId: 'marlow' });
    restored.fm.bus.feed('message', 'Итог ревью', { agentId: 'wren', to: 'user' });
    expect(restored.fm.snapshot()).toMatchObject({ replyAgentId: 'wren' });
  } finally { await restored.fm.close(); }
});
it('migrates an older profile from its retained feed in append order, not names or timestamps', async () => {
  const h = makeForeman(tempDir('ac-reply-migrate-')); all.push(h);
  h.fm.bus.feed('message', 'Ответ', { agentId: 'marlow', to: 'user' });
  h.fm.bus.feed('message', 'Ответ', { agentId: 'wren', to: 'user' });
  h.fm.store.flush();
  const saved = JSON.parse(fs.readFileSync(h.fm.store.file, 'utf8')); delete saved.replyAgentId;
  saved.feed.forEach((f: { ts: number }) => { f.ts = 42; });
  fs.writeFileSync(h.fm.store.file, JSON.stringify(saved));
  const restored = makeForeman(h.home);
  try { expect(restored.fm.snapshot()).toMatchObject({ replyAgentId: 'wren' }); }
  finally { await restored.fm.close(); }
});
afterEach(async () => { for (const h of all.splice(0)) { await h.fm.close(); rmrf(h.home); } });
it('keeps full multiline messages from either agent and the user through snapshot and restart while retaining compact previews', async () => {
  const h = makeForeman(tempDir('ac-full-feed-')); all.push(h);
  const text = 'Первый абзац\n\n' + Array.from({ length: 100 }, (_, i) => `${i + 1}. Подробный пункт`).join('\n') + '\n\nПоследний абзац';
  for (const agentId of ['marlow', 'wren']) h.fm.bus.feed('message', text, { agentId, to: 'user' });
  h.fm.bus.send('user', 'wren', text);
  h.fm.store.flush();
  for (const item of h.fm.store.data.feed.slice(-3)) {
    expect(item.text.length).toBeLessThanOrEqual(400); expect(FeedItem.parse(item).fullText).toBe(text);
  }
  const restored = makeForeman(h.home);
  try { expect(restored.fm.store.data.feed.slice(-3).map(f => f.fullText)).toEqual([text, text, text]); }
  finally { await restored.fm.close(); }
  expect(h.fm.bus.feed('task', text).fullText).toBeUndefined();
});
it('bounds snapshot history by evicting whole old messages, preserving complete retained answers', () => {
  const h = makeForeman(tempDir('ac-feed-budget-')); all.push(h);
  const body = 'Длинный ответ\n'.repeat(1500);
  for (let i = 0; i < 50; i++) h.fm.bus.feed('message', `${i}\n${body}`, { agentId: 'wren', to: 'user' });
  expect(Buffer.byteLength(JSON.stringify(h.fm.store.data.feed))).toBeLessThanOrEqual(1_000_000);
  expect(h.fm.store.data.feed.length).toBeLessThan(50);
  expect(h.fm.store.data.feed.at(-1)?.fullText).toBe(`49\n${body}`);
  expect(h.fm.store.data.feed.every(f => f.fullText?.endsWith(body))).toBe(true);
});
