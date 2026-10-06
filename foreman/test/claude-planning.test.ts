import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Studio } from '../src/studio.js';
import { ForemanServer } from '../src/server.js';
import { WorkspaceReader } from '../src/claude-workspace-access.js';
import { demoRepo, makeForeman, rmrf, tempDir } from './helpers.js';
import { silentLogger } from '../src/context.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });
async function setup() {
  const home = tempDir('ac-planning-'), repo = await demoRepo(), second = await demoRepo();
  const h = makeForeman(home, ['--backend', 'observer']); const original = await h.fm.repos.add(repo);
  const send = vi.fn(async () => ({})), control = vi.fn(async () => ({})), review = vi.fn(async () => ({ verdict: 'pass' as const, summary: 'OK' }));
  const studio = new Studio(h.fm, { send, control }, { run: review }, { run: async () => 'OK', stop: async () => {} });
  studio.data.profiles[1]!.enabled = true;
  h.fm.backend = { onStudioAction: (action: string, payload: Record<string, unknown>) => studio.action(action, payload) } as typeof h.fm.backend;
  const server = new ForemanServer(h.fm, { host: '127.0.0.1', port: 0, log: silentLogger }); h.cfg.port = await server.start();
  const workspace = path.join(home, 'workspace'); fs.mkdirSync(workspace);
  const binding = { version: 1, workspace, profile: h.cfg.dataDir, port: h.cfg.port, token: randomUUID() };
  const config = { version: 1, repositories: [{ id: 'trade', name: 'TradeRecord', path: repo, github: 'Owner/Trade' }, { id: 'craft', name: 'AgentCraft', path: second, github: 'Owner/Craft' }] };
  fs.writeFileSync(path.join(workspace, 'access.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(h.cfg.dataDir, 'claude-workspace.json'), JSON.stringify({ directory: workspace }));
  for (const dir of [workspace, h.cfg.dataDir]) fs.writeFileSync(path.join(dir, 'planning.json'), JSON.stringify(binding));
  const reader = await WorkspaceReader.open(workspace);
  cleanup.push(async () => { studio.stop(); await server.stop(); await h.fm.close(); rmrf(home); rmrf(path.dirname(repo)); rmrf(path.dirname(second)); });
  const input = { requestId: 'review-fix-1', project: 'craft', title: 'Исправление', description: 'Проверить поведение', expected: 'Проверки проходят' };
  const create = (overrides = {}) => reader.call('planning_create', { ...input, ...overrides }) as Promise<{ item: { id: string; stage: string; project: string }; duplicate: boolean }>;
  return { ...h, studio, reader, create, input, workspace, binding, original, send, review, control };
}
it('creates unapproved drafts over the real loopback protocol for the chosen project, with dependencies and persistent deduplication', async () => {
  const h = await setup();
  const a = await h.create(); expect(a.item).toMatchObject({ project: 'craft', stage: 'plan' });
  const t = h.fm.tasks.require(a.item.id); expect(t.createdBy).toBe('wren'); expect(t.assignee).toBe('marlow');
  expect(t.repoId).not.toBe(h.original.id); expect(h.fm.repos.defaultRepo()?.id).toBe(h.original.id);
  const b = await h.create({ requestId: 'review-fix-2', project: 'trade', deps: [a.item.id] });
  expect(h.fm.tasks.require(b.item.id).deps).toEqual([a.item.id]); expect(h.fm.tasks.require(b.item.id).repoId).toBe(h.original.id);
  const duplicate = await h.create(); expect(duplicate).toMatchObject({ duplicate: true, item: { id: a.item.id } });
  await expect(h.create({ title: 'Другой текст' })).rejects.toThrow('requestId');
  const saved = JSON.parse(fs.readFileSync(path.join(h.cfg.dataDir, 'state.json'), 'utf8'));
  expect(saved.backend.studio.items).toHaveLength(2);
  h.fm.store.data.backend.studio = saved.backend.studio;
  const restored = new Studio(h.fm, { send: h.send, control: h.control }, { run: h.review });
  expect(await restored.action('draft.create', { ...h.input, token: h.binding.token })).toMatchObject({ duplicate: true, item: { id: a.item.id } }); restored.stop();
  await h.studio.pump(); expect(h.send).not.toHaveBeenCalled(); expect(h.review).not.toHaveBeenCalled();
  expect(h.studio.data.mode).toBe('planning'); expect(h.studio.data.items.every(i => i.stage === 'plan')).toBe(true);
});
it('rejects wrong binding, project, dependencies, mode, disabled agent and injected action fields without side effects', async () => {
  const h = await setup();
  await expect(h.studio.action('draft.create', { ...h.input, token: randomUUID() })).rejects.toThrow('отклонён');
  await expect(h.create({ project: 'unconfigured' })).rejects.toThrow('не разрешён');
  await expect(h.create({ deps: ['t999'] })).rejects.toThrow('Зависимость');
  await expect(h.create({ action: 'start' })).rejects.toThrow();
  await expect(h.reader.call('planning_list', { action: 'approve' })).rejects.toThrow();
  for (const mode of ['running', 'paused'] as const) { h.studio.data.mode = mode; await expect(h.create()).rejects.toThrow('планирования'); }
  h.studio.data.mode = 'planning'; h.studio.data.active = 't999'; await expect(h.create()).rejects.toThrow('планирования'); delete h.studio.data.active;
  h.studio.data.profiles[1]!.enabled = false; await expect(h.create()).rejects.toThrow('Включи');
  expect(h.studio.data.items).toEqual([]); expect(h.fm.repos.list()).toHaveLength(1); expect(h.send).not.toHaveBeenCalled();
  fs.writeFileSync(path.join(h.workspace, 'planning.json'), JSON.stringify({ ...h.binding, token: randomUUID() }));
  await expect(h.reader.call('planning_list', {})).rejects.toThrow('отклонён');
});
it('lists all cards in bounded pages and fails clearly when planning is not connected', async () => {
  const h = await setup(); for (let n = 0; n < 3; n++) await h.create({ requestId: `card-${n}` });
  expect(await h.reader.call('planning_list', {})).toMatchObject({ mode: 'planning', total: 3, nextOffset: 2 });
  expect(await h.reader.call('planning_list', { offset: 2 })).toMatchObject({ items: [expect.objectContaining({ stage: 'plan' })], nextOffset: null });
  fs.unlinkSync(path.join(h.workspace, 'planning.json'));
  await expect(h.reader.call('planning_list', {})).rejects.toThrow('не подключено');
});
