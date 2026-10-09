import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { Foreman } from '../src/foreman.js';
import { ObserverBackend } from '../src/agents/observer.js';
import { ForemanServer } from '../src/server.js';
import { silentLogger } from '../src/context.js';
import { demoRepo, tempDir, testConfig, rmrf } from './helpers.js';
import { WorkspaceReader } from '../src/claude-workspace-access.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(provider: 'codex' | 'claude' = 'codex') {
  const home = tempDir('codex-planning-'), cwd = await demoRepo(), other = await demoRepo();
  const f = new Foreman({ config: testConfig(home, ['--backend', 'observer']), logger: silentLogger });
  const send = vi.fn(async () => ({}));
  const backend = new ObserverBackend(f, undefined, (_c, _store, events) => ({ start: () => events.activity('idle'),
    busy: () => false, dispose: async () => {}, send, execute: send, control: async () => ({}) }));
  await f.start(backend);
  const action = (action: string, payload: Record<string, unknown> = {}) => backend.onStudioAction(action, payload);
  const ids: string[] = [];
  const workspaces = new Map<string, string>();
  const bind = async (id: string) => {
    if (provider === 'codex') return action('connection.bind', { id, revision: f.team!.snapshot().revision,
      connection: { provider: 'codex', transport: 'codex-desktop', threadId: randomUUID(), hostId: 'local', title: 'Fixture', pipePath: '\\\\.\\pipe\\codex-browser-use-planning-fixture' } });
    const workspace = path.join(home, id); fs.mkdirSync(workspace, { recursive: true }); workspaces.set(id, workspace);
    for (const name of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) fs.writeFileSync(path.join(workspace, name), id);
    fs.writeFileSync(path.join(workspace, 'access.json'), JSON.stringify({ version: 1, repositories: [{ id: 'allowed', name: 'Allowed', path: cwd }] }));
    const sessionId = randomUUID(); fs.writeFileSync(path.join(workspace, 'conversation.json'), JSON.stringify({ version: 1, sessionId }));
    return action('connection.bind', { id, revision: f.team!.snapshot().revision, connection: { provider, transport: 'claude-code', workspace, sessionId } });
  };
  for (const role of ['planner', 'planner', 'developer']) {
    f.teamAction('team.create', { revision: f.team!.snapshot().revision, agent: { name: role, provider, roles: role === 'planner' ? ['planner', 'reviewer'] : [role], enabled: true, visible: true,
      appearance: { skin: 'marlow', color: '#123456', slim: false } } });
    const id = f.team!.snapshot().agents.at(-1)!.id; ids.push(id); await bind(id);
  }
  const [agentId, secondId, developerId] = ids as [string, string, string];
  const project = await f.repos.add(cwd), secondProject = await f.repos.add(other);
  const server = new ForemanServer(f, { host: '127.0.0.1', port: 0, validateOutbound: true, log: silentLogger }); const port = await server.start();
  cleanup.push(async () => { await server.stop(); await f.close(); rmrf(home); rmrf(path.dirname(cwd)); rmrf(path.dirname(other)); });
  const grant = (id = agentId, projects = [project.id]) => action('draft.grant', { agentId: id, projects });
  const permit = await grant();
  const auth = (p = permit) => ({ agentId: p.agentId, token: p.token });
  const input = { requestId: 'one', project: project.id, title: 'Черновик', description: 'Проверить поведение', expected: 'Ожидаемый результат' };
  const create = (p: Record<string, unknown> = {}, permission = permit) => action('draft.create', { ...input, ...auth(permission), ...p });
  const data = () => f.store.data.backend.roleQueue as any;
  const update = (patch: Record<string, unknown>) => f.teamAction('team.update', { id: agentId, revision: f.team!.snapshot().revision, patch });
  const cli = (...args: string[]) => promisify(execFile)(process.execPath, [path.join(f.config.projectRoot, 'tools/studio.mjs'), ...args], { windowsHide: true, timeout: 15000 });
  const jsonFile = (name: string, value: unknown) => { const file = path.join(home, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  return { f, backend, action, grant, permit, auth, input, create, data, update, bind, agentId, secondId, developerId, project, secondProject, home, port, send, cli, jsonFile, workspaces };
}

it('Claude workspace tools use the selected session and permit, deduplicate and expose no operator controls', async () => {
  const x = await fixture('claude'), workspace = x.workspaces.get(x.agentId)!;
  const file = path.join(workspace, 'planning.json');
  await x.cli('draft', 'grant', '--port', String(x.port), '--file', x.jsonFile('grant.json', { agentId: x.agentId, projects: [x.project.id] }), '--out', file);
  const reader = await WorkspaceReader.open(workspace);
  expect(await reader.call('planning_list', {})).toMatchObject({ projects: [{ id: x.project.id, workspaceProject: 'allowed' }], items: [] });
  const result: any = await reader.call('planning_create', x.input);
  expect(result.item.stage).toBe('plan');
  expect(await reader.call('planning_create', x.input)).toMatchObject({ duplicate: true, item: { id: result.item.id } });
  expect(x.f.tasks.require(result.item.id).createdBy).toBe(x.agentId);
  await expect(reader.call('planning_create', { ...x.input, requestId: 'two' })).rejects.toThrow('Одноразовое');
  await expect(reader.call('planning_create', { ...x.input, developerId: x.agentId })).rejects.toThrow();
  await expect(reader.call('planning_list', { action: 'start' })).rejects.toThrow();
  expect(x.send).not.toHaveBeenCalled(); expect(x.data().active).toBeUndefined();
  expect(await reader.call('memory_read', {})).toBe(x.agentId);
  const other = x.workspaces.get(x.secondId)!;
  fs.copyFileSync(file, path.join(other, 'planning.json'));
  await expect((await WorkspaceReader.open(other)).call('planning_list', {})).rejects.toThrow('пространство');
  expect(await (await WorkspaceReader.open(other)).call('memory_read', {})).toBe(x.secondId);
  fs.writeFileSync(path.join(workspace, 'conversation.json'), JSON.stringify({ version: 1, sessionId: randomUUID() }));
  await expect(reader.call('planning_list', {})).rejects.toThrow('Сессия');
  await expect(x.create()).rejects.toThrow('Сессия');
});

it('Claude grants and every use check current workspace access, agent identity and project visibility', async () => {
  const x = await fixture('claude');
  await expect(x.grant(x.agentId, [x.secondProject.id])).rejects.toThrow('Проект');
  await expect(x.grant(x.developerId)).rejects.toThrow('planner');
  await expect(x.create({ agentId: x.secondId })).rejects.toThrow('Разрешение');
  await x.action('create', { title: 'Private card', description: 'Hidden', expected: 'Hidden', repoId: x.secondProject.id });
  const privateId = x.data().items.at(-1).id;
  expect(await x.action('draft.list', x.auth())).toMatchObject({ total: 0, items: [] });
  await expect(x.create({ deps: [privateId] })).rejects.toThrow('Зависимость');
  const workspace = x.workspaces.get(x.agentId)!;
  fs.writeFileSync(path.join(workspace, 'access.json'), JSON.stringify({ version: 1, repositories: [{ id: 'changed', name: 'Changed', path: x.secondProject.path }] }));
  await expect(x.create()).rejects.toThrow('Проект');
  x.update({ roles: ['reviewer'] }); await expect(x.create()).rejects.toThrow('planner');
  expect(x.data().items).toHaveLength(1); expect(x.send).not.toHaveBeenCalled();
});

it('Claude planner deduplication survives restart, connection rebinding invalidates the old permit', async () => {
  const x = await fixture('claude');
  const r: any[] = await Promise.all([x.create(), x.create()]);
  expect(r.map(a => a.duplicate)).toEqual([false, true]);
  await x.backend.stop(); await x.backend.start(); await x.action('plan');
  expect(await x.create()).toMatchObject({ duplicate: true, item: { id: r[0].item.id } });
  await x.bind(x.agentId); await expect(x.create()).rejects.toThrow('Подключение');
});

it('CLI grants a private one-card permit, lists projects and creates a draft with a retriable requestId', async () => {
  const x = await fixture(), permitFile = path.join(x.home, 'permit.json');
  const grantInput = x.jsonFile('grant.json', { agentId: x.agentId, projects: [x.project.id] });
  const issued = await x.cli('draft', 'grant', '--port', String(x.port), '--file', grantInput, '--out', permitFile);
  expect(JSON.parse(issued.stdout)).toEqual({ ok: true, action: 'draft.grant' });
  const secret = JSON.parse(fs.readFileSync(permitFile, 'utf8'));
  expect(issued.stdout).not.toContain(secret.token);
  const list = JSON.parse((await x.cli('draft', 'list', '--permit', permitFile)).stdout);
  expect(list).toMatchObject({ mode: 'planning', projects: [{ id: x.project.id }], items: [] });
  const inputFile = x.jsonFile('draft.json', x.input);
  const args = ['draft', 'create', '--permit', permitFile, '--file', inputFile];
  const result = JSON.parse((await x.cli(...args)).stdout);
  expect(result).toMatchObject({ duplicate: false, item: { stage: 'plan', expected: x.input.expected, project: x.project.id } });
  expect(JSON.parse((await x.cli(...args)).stdout)).toMatchObject({ duplicate: true, item: { id: result.item.id } });
  expect(x.f.tasks.require(result.item.id).createdBy).toBe(x.agentId);
  expect(x.data().items).toHaveLength(1); expect(x.data().active).toBeUndefined(); expect(x.send).not.toHaveBeenCalled();
  expect(JSON.stringify(await x.action('get'))).not.toContain('draftPermits');
  expect(fs.readFileSync(path.join(x.f.config.dataDir, 'state.json'), 'utf8')).not.toContain(secret.token);
  const original = fs.readFileSync(permitFile, 'utf8');
  await expect(x.cli('draft', 'grant', '--port', String(x.port), '--file', grantInput, '--out', permitFile)).rejects.toMatchObject({ code: 1 });
  expect(fs.readFileSync(permitFile, 'utf8')).toBe(original);
});

it('bounded pool permits allow dependent drafts, retry without spending quota and persist across restart', async () => {
  const x = await fixture('claude'), workspace = x.workspaces.get(x.agentId)!;
  const permit = await x.action('draft.grant', { agentId: x.agentId, projects: [x.project.id], maxDrafts: 2, ttlMinutes: 1440 });
  fs.writeFileSync(path.join(workspace, 'planning.json'), JSON.stringify({ ...permit, port: x.port }));
  const reader = await WorkspaceReader.open(workspace);
  const first: any = await reader.call('planning_create', x.input);
  const second = { ...x.input, requestId: 'second', deps: [first.item.id] };
  const results: any[] = await Promise.all([reader.call('planning_create', second), reader.call('planning_create', second)]);
  expect(results.map(r => r.duplicate)).toEqual([false, true]);
  expect(await reader.call('planning_list', {})).toMatchObject({ permit: { maxDrafts: 2, remaining: 0 }, total: 2 });
  await expect(reader.call('planning_create', { ...x.input, requestId: 'third' })).rejects.toThrow('Лимит');
  await x.backend.stop(); await x.backend.start(); await x.action('plan');
  expect(await reader.call('planning_create', x.input)).toMatchObject({ duplicate: true, item: { id: first.item.id } });
  await expect(reader.call('planning_create', { ...x.input, requestId: 'third' })).rejects.toThrow('Лимит');
  const renewed = await x.action('draft.grant', { agentId: x.agentId, projects: [x.project.id], maxDrafts: 2 });
  expect(await x.create({}, renewed)).toMatchObject({ duplicate: true });
  expect(await x.action('draft.list', x.auth(renewed))).toMatchObject({ permit: { remaining: 2 } });
  expect(x.data().items.every((i: any) => i.stage === 'plan' && !i.developerId && !i.reviewerId)).toBe(true);
  expect(x.send).not.toHaveBeenCalled();
});

it('rejects invalid pool bounds and preserves legacy consumed single-card permits', async () => {
  const x = await fixture();
  for (const extra of [{ maxDrafts: 0 }, { maxDrafts: 101 }, { maxDrafts: 1.5 }, { ttlMinutes: 0 }, { ttlMinutes: 1441 }])
    await expect(x.action('draft.grant', { agentId: x.agentId, projects: [x.project.id], ...extra })).rejects.toThrow();
  await x.create();
  const permit: any = Object.values(x.data().draftPermits)[0];
  delete permit.requestIds; delete permit.maxDrafts; permit.requestId = 'one';
  expect(await x.create()).toMatchObject({ duplicate: true });
  await expect(x.create({ requestId: 'two' })).rejects.toThrow('Одноразовое');
});

it.each(['normal', 'tampered', 'deferred', 'published-save-failure'])('restores authenticated legacy planning on role-queue startup (%s)', async scenario => {
  const x = await fixture('claude'), workspace = x.workspaces.get(x.agentId)!;
  if (scenario === 'deferred') {
    await x.create();
    x.data().items[0].attempt = { agentId: x.agentId, phase: 'developer', run: randomUUID(), connection: 'fixture', base: 'fixture' };
  }
  await x.backend.stop(); x.f.config.port = x.port;
  x.f.store.data.backend.teamMigration = { version: 1, kind: 'legacy-pair' };
  const binding = { version: 1, workspace, profile: x.f.config.dataDir, port: x.port, token: randomUUID() };
  fs.writeFileSync(path.join(x.f.config.dataDir, 'claude-workspace.json'), JSON.stringify({ directory: workspace }));
  fs.writeFileSync(path.join(x.f.config.dataDir, 'planning.json'), JSON.stringify(binding));
  const file = path.join(workspace, 'planning.json');
  const original = JSON.stringify({ ...binding, ...(scenario === 'tampered' ? { token: randomUUID() } : {}) });
  fs.writeFileSync(file, original);
  let injected = false;
  const flush = x.f.store.flush.bind(x.f.store);
  if (scenario === 'published-save-failure') vi.spyOn(x.f.store, 'flush').mockImplementation(() => {
    if (!injected && JSON.parse(fs.readFileSync(file, 'utf8')).version === 2) {
      injected = true; throw new Error('Simulated post-publication save failure');
    }
    return flush();
  });
  await x.backend.start();
  expect(x.data().mode).toBe('paused'); expect(x.send).not.toHaveBeenCalled();
  if (scenario === 'tampered') {
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(x.data().notice).toContain('Не удалось перенести'); return;
  }
  if (scenario === 'deferred') {
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(x.data().notice).toContain('отложен');
    delete x.data().items[0].attempt;
    await x.action('plan');
  }
  if (scenario === 'published-save-failure') expect(injected).toBe(true);
  const converted = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(converted).toMatchObject({ version: 2, agentId: x.agentId, maxDrafts: 20, port: x.port });
  const backup = fs.readdirSync(workspace).find(n => n.startsWith('planning.json.legacy-'))!;
  expect(fs.readFileSync(path.join(workspace, backup), 'utf8')).toBe(original);
  await x.action('plan');
  expect(await (await WorkspaceReader.open(workspace)).call('planning_list', {})).toMatchObject({ projects: [{ id: x.project.id }], permit: { remaining: 20 } });
  await x.backend.stop(); await x.backend.start();
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(converted);
});

it('one token cannot create a second card; independent agents and dependent cards have separate keys', async () => {
  const x = await fixture(); const first: any = await x.create();
  await expect(x.create({ requestId: 'two' })).rejects.toThrow('Одноразовое');
  await expect(x.create({ title: 'Changed' })).rejects.toThrow('requestId');
  const next = await x.grant(x.agentId, [x.secondProject.id]);
  const second: any = await x.create({ requestId: 'two', project: x.secondProject.id, deps: [first.item.id] }, next);
  expect(second.item.deps).toEqual([first.item.id]);
  const other = await x.grant(x.secondId); await x.create({}, other);
  const page: any = await x.action('draft.list', x.auth());
  expect(page).toMatchObject({ total: 3, nextOffset: 2 });
  expect((await x.action('draft.list', { ...x.auth(), offset: 2 })).nextOffset).toBeNull();
  expect(x.data().items.every((i: any) => i.stage === 'plan' && !i.noReview && !i.developerId && !i.reviewerId)).toBe(true);
});

it('serializes concurrent creates and persists deduplication across a bridge restart', async () => {
  const x = await fixture();
  const results: any[] = await Promise.all([x.create(), x.create()]);
  expect(results.map(r => r.duplicate)).toEqual([false, true]);
  const saved = JSON.parse(fs.readFileSync(path.join(x.f.config.dataDir, 'state.json'), 'utf8'));
  await x.backend.stop(); x.f.store.data.backend.roleQueue = saved.backend.roleQueue; await x.backend.start();
  await expect(x.create()).rejects.toThrow('планирования'); // restart pauses the queue
  await x.action('plan');
  expect(await x.create()).toMatchObject({ duplicate: true, item: { id: results[0].item.id } });
  expect(await x.create({}, await x.grant())).toMatchObject({ duplicate: true });
  expect(x.data().items).toHaveLength(1);
});

it('rejects foreign project, unknown or out-of-pool dependencies and injected card controls without consuming the permit', async () => {
  const x = await fixture();
  const outside = x.f.tasks.create({ title: 'Outside queue', createdBy: 'user' });
  for (const payload of [{ project: x.secondProject.id }, { deps: ['t999'] }, { deps: [outside.id] },
    { noReview: true }, { developerId: x.developerId }, { action: 'approve' }, { expected: '' }])
    await expect(x.create(payload)).rejects.toThrow();
  await expect(x.action('draft.list', { ...x.auth(), action: 'start' })).rejects.toThrow();
  expect(x.data().items).toHaveLength(0);
  expect(await x.create()).toMatchObject({ duplicate: false });
});

it.each(['paused', 'running', 'active', 'attempt'])('denies reads, grants and creates in %s state', async state => {
  const x = await fixture();
  if (state === 'active') x.data().active = 't999';
  else if (state === 'attempt') {
    await x.create(); x.data().items[0].attempt = { agentId: x.agentId, phase: 'developer', run: randomUUID() };
  } else x.data().mode = state;
  await expect(x.grant()).rejects.toThrow('планирования');
  await expect(x.action('draft.list', x.auth())).rejects.toThrow('планирования');
  await expect(x.create()).rejects.toThrow('планирования');
  expect(x.send).not.toHaveBeenCalled();
});

it('requires planner role, enabled identity and the original connection on every use', async () => {
  const x = await fixture();
  await expect(x.grant(x.developerId)).rejects.toThrow('planner');
  await expect(x.create({ agentId: x.secondId })).rejects.toThrow('Разрешение');
  await expect(x.create({ token: randomUUID() })).rejects.toThrow('Разрешение');
  await expect(x.action('draft.create', x.input)).rejects.toThrow();
  x.update({ roles: ['developer'] }); await expect(x.create()).rejects.toThrow('planner');
  x.update({ roles: ['planner'], enabled: false }); await expect(x.create()).rejects.toThrow('planner');
  x.update({ enabled: true }); await x.bind(x.agentId); await expect(x.create()).rejects.toThrow('Подключение');
  expect(x.data().items).toHaveLength(0);
});

it('expires permits and refuses external team changes and replaced repository paths', async () => {
  const x = await fixture();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Number(x.permit.expiresAt));
  await expect(x.create()).rejects.toThrow('истекло'); clock.mockRestore();
  const original = x.project.path; x.project.path = x.secondProject.path;
  await expect(x.create()).rejects.toThrow('Каталог'); x.project.path = original;
  const teamFile = x.f.team!.file, team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  team.agents[0].roles = ['developer']; fs.writeFileSync(teamFile, JSON.stringify(team));
  await expect(x.create()).rejects.toThrow('changed outside');
  expect(x.data().items).toHaveLength(0);
});

it.each(['/planner', '/'])('planner channel %s denies other intents even without the token or after another hello', async endpoint => {
  const x = await fixture(); const ws = new WebSocket(`ws://127.0.0.1:${x.port}${endpoint}`);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const call = (payload: any) => new Promise<any>(resolve => {
    const id = randomUUID(); let snapshot: unknown;
    const receive = (raw: WebSocket.RawData) => { const m = JSON.parse(raw.toString());
      if (m.type === 'snapshot') snapshot = m;
      if (m.type === 'ack' && m.re === id) { ws.off('message', receive); resolve(payload.type === 'hello' ? snapshot : m); } };
    ws.on('message', receive); ws.send(JSON.stringify({ v: 2, id, ...payload }));
  });
  const observed: string[] = []; ws.on('message', raw => observed.push(JSON.parse(raw.toString()).type));
  try {
    const hello = { type: 'hello', protocol: 2, modVersion: 'test', client: 'studio-control' };
    await call({ type: 'studio.action', action: 'draft.list', payload: x.auth() });
    const snap = await call(hello); expect(snap.agents).toEqual([]); expect(snap.repos).toEqual([]);
    const first: any = await x.create();
    for (const action of ['approve', 'start', 'edit', 'cancel', 'create', 'draft.grant', 'team.update', 'connection.send']) {
      expect(await call({ type: 'studio.action', action, payload: { ...x.auth(), id: first.item.id } })).toMatchObject({ ok: false });
      await expect(x.action(action, { ...x.auth(), id: first.item.id })).rejects.toThrow();
    }
    await call(hello);
    expect(await call({ type: 'studio.action', action: 'start', payload: {} })).toMatchObject({ ok: false });
    expect(await call({ type: 'agent.action', action: 'resume', agentId: x.agentId })).toMatchObject({ ok: false });
    expect(await call({ type: 'studio.action', action: 'draft.list', payload: {} })).toMatchObject({ ok: false });
    expect(await call({ type: 'studio.action', action: 'draft.list', payload: x.auth() })).toMatchObject({ ok: true });
    expect(observed.every(type => ['snapshot', 'ack'].includes(type))).toBe(true);
    expect(x.data().items[0].stage).toBe('plan'); expect(x.data().mode).toBe('planning'); expect(x.send).not.toHaveBeenCalled();
  } finally { ws.close(); }
});

it('does not treat an unknown or near-matching planner URL as the operator endpoint', async () => {
  const x = await fixture();
  for (const suffix of ['/planner/', '/planner?operator=true']) {
    const ws = new WebSocket(`ws://127.0.0.1:${x.port}${suffix}`);
    const error = await new Promise<Error>((resolve, reject) => { ws.once('error', resolve); ws.once('open', () => { ws.close(); reject(new Error('Unexpected operator connection')); }); });
    expect(error.message).toContain('Unexpected server response: 401'); // ws verifyClient(false)
  }
});

it('CLI refuses using a permit with operator commands and preserves operator approval', async () => {
  const x = await fixture(); const permission = x.jsonFile('permit.json', { ...x.permit, port: x.port });
  for (const action of ['approve', 'start', 'edit', 'cancel', 'draft.grant'])
    await expect(x.cli(action, '--permit', permission)).rejects.toMatchObject({ code: 1 });
  await expect(x.cli('draft', 'create', '--file', x.jsonFile('draft.json', x.input))).rejects.toMatchObject({ code: 1 });
  await expect(x.cli('draft', 'list', '--permit', permission, '--port', String(x.port + 1))).rejects.toMatchObject({ code: 1 });
  const result: any = await x.create(); await x.action('approve', { id: result.item.id });
  expect(x.data().items[0].stage).toBe('queued');
});
