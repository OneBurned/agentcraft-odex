import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { TeamRegistry } from '../src/team.js';
import { Foreman } from '../src/foreman.js';
import { ObserverBackend } from '../src/agents/observer.js';
import { ForemanServer } from '../src/server.js';
import { silentLogger } from '../src/context.js';
import { parseClientMessage, type Outbound } from '../src/protocol.js';
import { testConfig, tempDir, rmrf, until } from './helpers.js';

const dirs: string[] = [];
const cores: Foreman[] = [];
const dir = () => { const d = tempDir('ac-team-'); dirs.push(d); return d; };
const input = (name = 'Agent', provider: 'codex' | 'claude' = 'codex') => ({ name, provider, roles: ['developer'],
  enabled: true, visible: true, appearance: { skin: 'marlow', color: '#123456', slim: false } });
afterEach(async () => { for (const f of cores.splice(0)) await f.close(); for (const d of dirs.splice(0)) rmrf(d); });
function fresh() {
  const f = new Foreman({ config: testConfig(dir(), ['--backend', 'observer']), logger: silentLogger });
  cores.push(f); return f;
}

it.each(['{broken', '{"version":99}', '{"version":1,"agents":[]}'])('never converts an existing empty or damaged state into a team profile: %s', async contents => {
  const config = testConfig(dir(), ['--backend', 'observer']);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, 'state.json'), contents);
  const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const fm = new Foreman({ config, logger: silentLogger }); cores.push(fm);
    expect(fm.team).toBeUndefined();
    expect(fs.existsSync(path.join(config.dataDir, 'team.json'))).toBe(false);
    if (contents !== '{"version":1,"agents":[]}') {
      const backup = fs.readdirSync(config.dataDir).find(name => name.startsWith('state.json.corrupt-'))!;
      expect(fs.readFileSync(path.join(config.dataDir, backup), 'utf8')).toBe(contents);
    }
    await fm.close();
    const restarted = new Foreman({ config, logger: silentLogger }); cores.push(restarted);
    expect(restarted.team).toBeUndefined();
    expect(fs.existsSync(path.join(config.dataDir, 'team.json'))).toBe(false);
  } finally { warning.mockRestore(); }
});

it('retains the legacy model if a previous interrupted recovery left only a quarantined state', () => {
  const config = testConfig(dir(), ['--backend', 'observer']);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const backup = path.join(config.dataDir, 'state.json.corrupt-fixture');
  fs.writeFileSync(backup, '{broken');
  const fm = new Foreman({ config, logger: silentLogger }); cores.push(fm);
  expect(fm.team).toBeUndefined();
  expect(fs.readFileSync(backup, 'utf8')).toBe('{broken');
  expect(fs.existsSync(path.join(config.dataDir, 'team.json'))).toBe(false);
});

it('fresh observer starts empty, uses arbitrary provider/roles, and survives restart without demo NPCs', async () => {
  const f = fresh(); await f.start(new ObserverBackend(f));
  expect(f.agents()).toEqual([]);
  expect(f.cast).toEqual([]);
  for (const [i, provider] of ['codex', 'codex', 'claude'].entries())
    f.teamAction('team.create', { revision: i, agent: { ...input('Duplicate', provider as 'codex' | 'claude'), roles: i === 2 ? ['developer', 'reviewer'] : ['developer'] } });
  expect(f.agents()).toHaveLength(3);
  expect(new Set(f.agents().map(a => a.id)).size).toBe(3);
  expect(f.agents().map(a => a.provider)).toEqual(['codex', 'codex', 'claude']);
  expect(f.agents()[2]!.roles).toEqual(['developer', 'reviewer']);
  expect(f.resolveAgentId('Duplicate')).toBeUndefined();
  expect(f.resolveAgentId(f.agents()[0]!.id)).toBe(f.agents()[0]!.id);
  expect(f.agents().every(a => a.controls?.message === false)).toBe(true);
  await f.close();
  const restarted = new Foreman({ config: f.config, logger: silentLogger }); cores.push(restarted);
  expect(restarted.agents().map(a => a.id)).toEqual(f.agents().map(a => a.id));
});

it('edits, disables, archives and restores, preserving task identities and emitting removal', () => {
  const f = fresh(); const events: Outbound[] = []; f.subscribe(m => events.push(m));
  f.teamAction('team.create', { revision: 0, agent: input('Original') });
  const id = f.agents()[0]!.id;
  const task = f.tasks.create({ title: 'Completed work', assignee: id, createdBy: id });
  expect(() => f.teamAction('team.archive', { revision: 1, id })).toThrow('незавершённую');
  f.tasks.setStatus(task.id, 'done');
  f.setAgent(id, { state: 'done', taskId: task.id });
  f.teamAction('team.update', { revision: 1, id, patch: { name: 'Renamed', provider: 'claude', roles: ['developer', 'reviewer'], appearance: { skin: 'wren', color: '#654321', slim: true } } });
  expect(f.agent(id)).toMatchObject({ name: 'Renamed', provider: 'claude', slim: true });
  f.teamAction('team.disable', { revision: 2, id });
  expect(f.agent(id)).toMatchObject({ active: false, visible: true, enabled: false });
  expect(() => f.tasks.create({ title: 'No', createdBy: 'user', assignee: id })).toThrow('disabled');
  f.teamAction('team.archive', { revision: 3, id });
  expect(f.agent(id)).toBeUndefined();
  expect(events).toContainEqual({ type: 'agent.remove', agentId: id });
  expect(f.snapshot().agents).toEqual([]);
  expect(task.assigneeIdentity).toEqual({ id, name: 'Original', provider: 'codex' });
  expect(task.creatorIdentity).toEqual(task.assigneeIdentity);
  expect(() => f.tasks.setStatus(task.id, 'doing', { force: true })).toThrow('archived');
  const before = f.team!.get(id);
  f.teamAction('team.restore', { revision: 4, id, visible: false });
  expect(f.team!.get(id)).toMatchObject({ id, archived: false, enabled: false, visible: false, memoryDir: before!.memoryDir, personaRef: before!.personaRef });
  expect(f.agent(id)?.name).toBe('Renamed');
  expect(events.at(-1)).toMatchObject({ type: 'agent.upsert', agent: { id } });
});

it('editing one agent preserves another agent’s running state and rejects changing that busy agent', () => {
  const f = fresh();
  f.teamAction('team.create', { revision: 0, agent: input('First') });
  f.teamAction('team.create', { revision: 1, agent: input('Second') });
  const [first, second] = f.agents();
  f.setAgent(first!.id, { state: 'editing', station: 'desk', activity: 'Working', paused: true });
  f.teamAction('team.update', { revision: 2, id: second!.id, patch: { name: 'Renamed' } });
  expect(f.agent(first!.id)).toMatchObject({ state: 'editing', station: 'desk', activity: 'Working', paused: true });
  for (const action of ['team.disable', 'team.archive', 'team.update'])
    expect(() => f.teamAction(action, { revision: 3, id: first!.id, patch: { provider: 'claude' } })).toThrow('Агент занят');
});

it('concurrent clients cannot overwrite each other; external edits require a restart', () => {
  const root = dir(); const team = new TeamRegistry(root);
  team.change('create', { revision: 0, agent: input() }, () => {});
  const other = new TeamRegistry(root);
  team.change('update', { revision: 1, id: team.snapshot().agents[0]!.id, patch: { name: 'First writer' } }, () => {});
  expect(() => other.change('create', { revision: 1, agent: input() }, () => {})).toThrow('changed outside');
  expect(new TeamRegistry(root).snapshot().agents[0]!.name).toBe('First writer');
});

it('refuses stale revision, malformed schema, duplicate roles, invalid paths and unknown file versions without replacing data', () => {
  const root = dir(); const team = new TeamRegistry(root);
  team.change('create', { revision: 0, agent: input() }, () => {});
  const original = fs.readFileSync(team.file, 'utf8');
  expect(() => team.change('create', { revision: 0, agent: input() }, () => {})).toThrow('revision conflict');
  expect(() => team.change('create', { revision: 1, agent: { ...input(), roles: ['developer', 'developer'] } }, () => {})).toThrow();
  expect(() => team.change('create', { revision: 1, agent: { ...input(), injected: true } }, () => {})).toThrow();
  expect(fs.readFileSync(team.file, 'utf8')).toBe(original);
  for (const mutation of [
    (d: any) => { d.version = 99; },
    (d: any) => { d.agents[0].memoryDir = '../outside'; },
    (d: any) => { d.agents.push(d.agents[0]); },
    (d: any) => { d.agents[0].archived = true; },
  ]) {
    const data = JSON.parse(original); mutation(data);
    const text = JSON.stringify(data); fs.writeFileSync(team.file, text);
    expect(() => new TeamRegistry(root)).toThrow('original file preserved');
    expect(fs.readFileSync(team.file, 'utf8')).toBe(text);
  }
});

it('rejects junction references and preserves archived memory on restore', () => {
  const root = dir(); const outside = dir(); const team = new TeamRegistry(root);
  const created = team.change('create', { revision: 0, agent: input() }, () => {});
  const a = created.agents[0]!;
  fs.mkdirSync(path.join(root, a.memoryDir), { recursive: true });
  const file = path.join(root, a.memoryDir, 'note.md'); fs.writeFileSync(file, 'remember');
  team.change('archive', { revision: 1, id: a.id }, () => {});
  team.change('restore', { revision: 2, id: a.id }, () => {});
  expect(fs.readFileSync(file, 'utf8')).toBe('remember');
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  const data = team.snapshot(); data.agents[0]!.instructionsDir = 'linked/instructions';
  fs.writeFileSync(team.file, JSON.stringify(data));
  expect(() => new TeamRegistry(root)).toThrow('junction');
});

it('keeps historical recipient IDs and accepts scene peers from a dynamic roster', async () => {
  const f = fresh();
  f.teamAction('team.create', { revision: 0, agent: input() });
  const id = f.agents()[0]!.id;
  f.bus.feed('message', 'Hello', { agentId: id, to: 'user' });
  expect(f.snapshot().replyAgentId).toBe(id);
  expect(parseClientMessage({ v: 2, type: 'agent.scene', agentId: id, peerAgentId: 'other', event: 'peer' }).ok).toBe(true);
  await f.close();
  const restored = new Foreman({ config: f.config, logger: silentLogger }); cores.push(restored);
  expect(restored.snapshot().replyAgentId).toBe(id);
});

it('reports actionable protocol mismatch over WebSocket and never executes the old request', async () => {
  const f = fresh();
  const server = new ForemanServer(f, { host: '127.0.0.1', port: 0, validateOutbound: true, log: silentLogger });
  const port = await server.start(); const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: any[] = []; ws.on('message', d => received.push(JSON.parse(d.toString())));
  try {
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ v: 1, type: 'hello', protocol: 1, modVersion: 'old', id: 'old' }));
    await until(() => received.some(m => m.type === 'error'));
    expect(received.find(m => m.type === 'error').message).toContain('Update both');
    expect(received.some(m => m.type === 'snapshot')).toBe(false);
    ws.send(JSON.stringify({ v: 2, type: 'hello', protocol: 2, modVersion: 'new' }));
    await until(() => received.some(m => m.type === 'snapshot'));
    ws.send(JSON.stringify({ v: 2, type: 'studio.action', id: 'create', action: 'team.create', payload: { revision: 0, agent: input() } }));
    await until(() => received.some(m => m.type === 'ack' && m.re === 'create'));
    expect(received.find(m => m.type === 'ack' && m.re === 'create').ok).toBe(true);
    expect(received.some(m => m.type === 'agent.upsert')).toBe(true);
  } finally { ws.close(); await server.stop(); }
});
