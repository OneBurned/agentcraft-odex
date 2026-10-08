import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { migrateTeam, restoreTeam, type MigrationChecks } from '../src/team-migration.js';
import { maintenanceFile } from '../src/profile-maintenance.js';
import { TeamRegistry } from '../src/team.js';
import { AgentConnections } from '../src/agent-connections.js';
import { Store } from '../src/store.js';
import { loadCast } from '../src/cast.js';
import { Foreman } from '../src/foreman.js';
import { ObserverBackend } from '../src/agents/observer.js';
import { DesktopChat } from '../src/codex-desktop.js';
import { ClaudeDialog } from '../src/claude-dialog.js';
import { acquireConversation, conversationLease } from '../src/claude-conversation.js';
import { silentLogger } from '../src/context.js';
import { tempDir, rmrf, testConfig } from './helpers.js';
import { writeJsonAtomic } from '../src/util/fsx.js';

const cleanup: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of cleanup.splice(0)) rmrf(d); });
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
function bytes(root: string) {
  const result: Record<string, string> = {};
  function walk(dir: string) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file); else result[path.relative(root, file)] = fs.readFileSync(file).toString('hex');
  } }
  walk(root); return result;
}
function fixture() {
  const base = tempDir('team-migration-'); cleanup.push(base);
  const cfg = testConfig(path.join(base, 'home'), ['--backend', 'observer']);
  const profile = cfg.dataDir, game = path.join(base, 'game'), workspace = path.join(base, 'reviewer');
  fs.mkdirSync(workspace); fs.mkdirSync(path.join(game, 'config'), { recursive: true });
  const bindingFile = path.join(base, 'binding.json'), threadId = randomUUID(), sessionId = randomUUID();
  writeJsonAtomic(bindingFile, { threadId, hostId: 'local', title: 'Synthetic conversation', pipePath: '\\\\.\\pipe\\codex-browser-use-fixture' });
  const store = new Store(profile);
  store.data.agents = loadCast(cfg.projectRoot).cast.map(c => ({ id: c.id, name: c.name, role: c.role, color: c.color,
    skin: c.id, paused: false, state: 'idle', activity: '', station: 'lounge', active: false }));
  store.data.agents[0]!.paused = true;
  store.data.tasks = [{ id: 't1', title: 'Synthetic task', description: 'Retain history', status: 'blocked', priority: 2,
    deps: [], assignee: 'marlow', created: 1, updated: 2, ci: 'pass', assigneeIdentity: { id: 'marlow', name: 'Coder', provider: 'codex' } } as any];
  store.data.replyAgentId = 'wren';
  store.data.sessions.wren = { sessionId, turns: 8, costUsd: 0, updatedAt: 2 };
  store.data.feed.push({ ts: 2, kind: 'message', agentId: 'wren', to: 'user', text: 'Synthetic answer' });
  store.data.backend.studio = { version: 1, mode: 'paused', reviewMode: 'manual', claudePath: process.execPath, notice: '',
    profiles: [{ id: 'marlow', name: 'Coder', skin: 'ded_vasyan', color: '#112233', enabled: true, visible: true },
      { id: 'wren', name: 'Клава', skin: 'wren', color: '#998877', enabled: true, visible: true }],
    personalPaused: ['marlow', 'wren'], suspended: { marlow: 't1' },
    dialog: { history: [{ role: 'user', text: 'Pending question' }], pending: 'Pending question', attempted: true, sessionId, sessionCursor: 'cursor' },
    items: [{ id: 't1', stage: 'question', expected: 'Keep data', run: randomUUID(), rounds: 1, checks: 'past checks' }] };
  store.close();
  writeJsonAtomic(path.join(profile, 'claude-workspace.json'), { directory: workspace });
  writeJsonAtomic(path.join(profile, 'codex-chat-state.json'), { threadId, seen: ['old-result'], control: { mode: 'paused', turnKey: threadId + '/turn' } });
  fs.copyFileSync(new URL('../../tools/portable-templates/personas.json', import.meta.url), path.join(profile, 'personas.json'));
  fs.mkdirSync(path.join(profile, 'memory/agents/wren'), { recursive: true }); fs.writeFileSync(path.join(profile, 'memory/agents/wren/note.md'), '# Note\r\nSynthetic memory\r\n');
  for (const file of ['CLAUDE.md', 'MEMORY.md', 'PROJECTS.md']) fs.writeFileSync(path.join(workspace, file), file + '\r\nSynthetic instructions');
  writeJsonAtomic(path.join(workspace, 'access.json'), { version: 1, repositories: [{ id: 'fixture', name: 'Fixture', path: base, github: 'example/fixture' }] });
  writeJsonAtomic(path.join(workspace, 'conversation.json'), { version: 1, sessionId });
  writeJsonAtomic(path.join(game, 'config/agentcraft-studio.json'), { looks: { wren: { slim: true, png: 'skin.png' } }, worlds: { world: { 'wren/desk': { x: 1, y: 2, z: 3 } } }, restPlaces: { world: { wren: [{ id: 'rest', dance: true }] } } });
  fs.mkdirSync(path.join(game, 'config/agentcraft-skins')); fs.writeFileSync(path.join(game, 'config/agentcraft-skins/skin.png'), Buffer.from([137,80,78,71,0,255]));
  fs.mkdirSync(path.join(game, 'saves/world'), { recursive: true }); writeJsonAtomic(path.join(game, 'saves/world/agentcraft-workspace.json'), { active: true, places: { 'marlow/desk': { x: 7 } } });
  fs.writeFileSync(path.join(game, 'saves/world/level.dat'), 'unrelated world data');
  const checks: MigrationChecks = { codex: vi.fn(async () => {}), claude: vi.fn(async () => {}), game: vi.fn() };
  const options = { profileDir: profile, gameDir: game, bindingFile, backupDir: path.join(base, 'backup'), projectRoot: cfg.projectRoot };
  return { base, profile, game, workspace, cfg, checks, options, threadId, sessionId,
    change: (fn: (s: any) => void) => { const s = read(path.join(profile, 'state.json')); fn(s); writeJsonAtomic(path.join(profile, 'state.json'), s); } };
}

it('migrates the complete synthetic pair, keeping every historical reference and external byte', async () => {
  const f = fixture(), before = read(path.join(f.profile, 'state.json')), original = bytes(f.profile), world = bytes(f.game), workspace = bytes(f.workspace);
  const result = await migrateTeam(f.options, f.checks);
  expect(result).toMatchObject({ migrated: true, agents: ['marlow', 'wren'], queue: 'paused' });
  const team = new TeamRegistry(f.profile), connections = new AgentConnections(f.profile, team);
  expect(team.snapshot().agents.map(a => [a.id, a.provider, a.roles])).toEqual([['marlow', 'codex', ['developer']], ['wren', 'claude', ['planner', 'reviewer']]]);
  expect(team.get('marlow')).toMatchObject({ name: 'Coder', appearance: { skin: 'ded_vasyan', color: '#112233' } });
  expect(team.get('wren')).toMatchObject({ name: 'Клава', appearance: { slim: true } });
  expect(connections.read('marlow')).toMatchObject({ threadId: f.threadId });
  expect(connections.read('wren')).toMatchObject({ workspace: f.workspace, sessionId: f.sessionId });
  const state = read(path.join(f.profile, 'state.json'));
  expect(state.agents.map((a: any) => a.id)).toEqual(['marlow', 'wren']);
  for (const key of ['tasks', 'sessions', 'feed', 'messages', 'decisions', 'replyAgentId']) expect(state[key]).toEqual(before[key]);
  expect(state.backend.studio).toEqual(before.backend.studio);
  for (const [name, data] of Object.entries(original)) if (name !== 'state.json') expect(bytes(f.profile)[name]).toBe(data);
  expect(bytes(f.game)).toEqual(world); expect(bytes(f.workspace)).toEqual(workspace); expect(conversationLease(f.workspace)).toBeUndefined();
});

it('is byte-for-byte idempotent with no extra backups, probes, agents or connections', async () => {
  const f = fixture(); await migrateTeam(f.options, f.checks);
  const before = bytes(f.base), calls = vi.mocked(f.checks.codex).mock.calls.length;
  expect(await migrateTeam(f.options, f.checks)).toMatchObject({ alreadyMigrated: true, migrated: false });
  expect(bytes(f.base)).toEqual(before); expect(f.checks.codex).toHaveBeenCalledTimes(calls);
});

it('restores original bytes including CRLF, memory, PNG, settings and removed default roster; saves post-update data separately', async () => {
  const f = fixture(), profile = bytes(f.profile), world = bytes(f.game), workspace = bytes(f.workspace);
  await migrateTeam(f.options, f.checks);
  fs.writeFileSync(path.join(f.workspace, 'MEMORY.md'), 'new memory');
  fs.writeFileSync(path.join(f.profile, 'new-note.txt'), 'new data');
  fs.writeFileSync(path.join(f.game, 'config/agentcraft-skins/new.png'), 'new skin');
  writeJsonAtomic(path.join(f.game, 'config/agentcraft-studio.json'), { worlds: {} });
  const result = await restoreTeam(f.options, f.checks);
  expect(result.restored).toBe(true); expect(fs.existsSync(path.join(result.recovery, 'manifest.json'))).toBe(true);
  expect(bytes(f.profile)).toEqual(profile); expect(bytes(f.game)).toEqual(world); expect(bytes(f.workspace)).toEqual(workspace);
  expect(fs.existsSync(maintenanceFile(f.profile))).toBe(false);
});

it.each(['mode', 'active', 'stage', 'task'])('refuses an active %s before backup or mutation', async kind => {
  const f = fixture(); f.change(s => {
    if (kind === 'mode') s.backend.studio.mode = 'running';
    if (kind === 'active') s.backend.studio.active = 't1';
    if (kind === 'stage') s.backend.studio.items[0].stage = 'review';
    if (kind === 'task') s.tasks[0].status = 'doing';
  });
  const before = bytes(f.base);
  await expect(migrateTeam(f.options, f.checks)).rejects.toThrow('активна'); expect(bytes(f.base)).toEqual(before);
});

it('refuses a live bridge, Minecraft or unknown/busy Codex without changing files', async () => {
  const f = fixture(); writeJsonAtomic(path.join(f.profile, 'foreman.json'), { pid: process.pid });
  let before = bytes(f.base);
  await expect(migrateTeam(f.options, f.checks)).rejects.toThrow('Останови мост'); expect(bytes(f.base)).toEqual(before);
  fs.unlinkSync(path.join(f.profile, 'foreman.json'));
  before = bytes(f.base);
  await expect(migrateTeam(f.options, { ...f.checks, game: () => { throw new Error('Minecraft busy'); } })).rejects.toThrow('Minecraft busy');
  await expect(migrateTeam(f.options, { ...f.checks, codex: async () => { throw new Error('Codex busy'); } })).rejects.toThrow('Codex busy');
  expect(bytes(f.base)).toEqual(before);
});

it('preserves terminal/Desktop leases byte-for-byte and requires explicit return before migration', async () => {
  const f = fixture(), lease = acquireConversation(f.workspace, 'desktop'), before = bytes(f.base);
  await expect(migrateTeam(f.options, f.checks)).rejects.toThrow('Разговор Claude занят');
  expect(bytes(f.base)).toEqual(before); lease.release();
});

it('does not invent a missing Claude conversation or discard unsupported/custom agents', async () => {
  const f = fixture(); f.change(s => { s.agents.find((a: any) => a.id === 'juniper').skin = 'custom'; });
  let before = bytes(f.base); await expect(migrateTeam(f.options, f.checks)).rejects.toThrow('решение пользователя'); expect(bytes(f.base)).toEqual(before);
  f.change(s => { s.agents.find((a: any) => a.id === 'juniper').skin = 'juniper'; });
  fs.unlinkSync(path.join(f.workspace, 'conversation.json')); before = bytes(f.base);
  await expect(migrateTeam(f.options, f.checks)).rejects.toThrow('общий разговор'); expect(bytes(f.base)).toEqual(before);
});

it('rejects corrupt backups before changing any original file or taking a maintenance lock', async () => {
  const f = fixture(); await migrateTeam(f.options, f.checks);
  fs.appendFileSync(path.join(f.options.backupDir, 'files/0'), 'corrupt'); const before = bytes(f.base);
  await expect(restoreTeam(f.options, f.checks)).rejects.toThrow('Контрольная сумма'); expect(bytes(f.base)).toEqual(before);
});

it('retains playable queue, paused cards, pending reply, personas and notes on migrated runtime restart', async () => {
  const f = fixture(); await migrateTeam(f.options, f.checks);
  vi.spyOn(DesktopChat.prototype, 'start').mockImplementation(() => {});
  const send = vi.spyOn(DesktopChat.prototype, 'send'); const run = vi.spyOn(ClaudeDialog.prototype, 'run');
  const fm = new Foreman({ config: f.cfg, logger: silentLogger }), backend = new ObserverBackend(fm);
  try {
    await fm.start(backend);
    const view: any = await backend.onStudioAction('get', {});
    expect(fm.agents().map(a => a.id)).toEqual(['marlow', 'wren']);
    expect(fm.agent('marlow')?.name).toBe('Coder'); expect(fm.agent('wren')?.name).toBe('Клава');
    expect(fm.agent('marlow')?.paused).toBe(true); expect(fm.agent('wren')?.paused).toBe(true);
    expect(view.mode).toBe('paused'); expect(view.items[0]).toMatchObject({ id: 't1', stage: 'question', checks: 'past checks' });
    expect(view.skins).toEqual(expect.arrayContaining(['marlow', 'wren', 'ded_vasyan']));
    expect(view.suspended).toEqual({ marlow: 't1' }); expect(view.dialog.pending).toBe('Pending question');
    expect(view.notes).toHaveLength(1); expect(fm.snapshot().replyAgentId).toBe('wren');
    expect((await backend.onStudioAction('persona.get', { agentId: 'wren' })).description).toBeTruthy();
    expect(() => fm.teamAction('team.create', {})).toThrow('прежних исполнителей');
    expect(send).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  } finally { await fm.close(); }
});

it('blocks bridge startup during an incomplete migration instead of loading partial files', () => {
  const f = fixture(); writeJsonAtomic(maintenanceFile(f.profile), { pid: process.pid });
  const before = bytes(f.base);
  expect(() => new Foreman({ config: f.cfg, logger: silentLogger })).toThrow('восстановление не завершено');
  expect(bytes(f.base)).toEqual(before);
});

it('rolls back an activation failure to the original profile and keeps the complete backup', async () => {
  const f = fixture(), before = bytes(f.profile), rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === path.join(f.profile, 'team.json')) throw Object.assign(new Error('injected disk failure'), { code: 'EROFS' });
    rename(from, to);
  });
  await expect(migrateTeam(f.options, f.checks)).rejects.toThrow('injected disk failure');
  expect(bytes(f.profile)).toEqual(before); expect(fs.existsSync(path.join(f.options.backupDir, 'manifest.json'))).toBe(true);
  expect(fs.existsSync(maintenanceFile(f.profile))).toBe(false); expect(conversationLease(f.workspace)).toBeUndefined();
});

it('detects a concurrent source update rather than writing stale state after the readiness probe', async () => {
  const f = fixture();
  vi.mocked(f.checks.codex).mockImplementationOnce(async () => { f.change(s => { s.backend.studio.notice = 'Written by another owner'; }); });
  await expect(migrateTeam(f.options, f.checks)).rejects.toThrow('настройки изменились');
  expect(read(path.join(f.profile, 'state.json')).backend.studio.notice).toBe('Written by another owner');
  expect(fs.existsSync(path.join(f.profile, 'team.json'))).toBe(false);
});

it('preserves pause flags missing from the old personalPaused list', async () => {
  const f = fixture(); f.change(s => { delete s.backend.studio.personalPaused; });
  await migrateTeam(f.options, f.checks);
  expect(read(path.join(f.profile, 'state.json')).backend.studio.personalPaused).toEqual(['marlow', 'wren']);
});

it('refuses rollback while busy and releases the maintenance guard on a preflight refusal', async () => {
  const f = fixture(); await migrateTeam(f.options, f.checks); const before = bytes(f.base);
  const lease = acquireConversation(f.workspace, 'terminal');
  await expect(restoreTeam(f.options, f.checks)).rejects.toThrow('Разговор Claude занят'); lease.release();
  expect(bytes(f.base)).toEqual(before);
  expect(fs.existsSync(maintenanceFile(f.profile))).toBe(false);
});

it('rejects link traversal and backup folders inside managed data', async () => {
  const f = fixture();
  await expect(migrateTeam({ ...f.options, backupDir: path.join(f.profile, 'backup') }, f.checks)).rejects.toThrow('вне папок');
  const target = path.join(f.base, 'external'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'sentinel'), 'untouched');
  fs.symlinkSync(target, path.join(f.profile, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(migrateTeam(f.options, f.checks)).rejects.toThrow('junction');
  expect(fs.readFileSync(path.join(target, 'sentinel'), 'utf8')).toBe('untouched');
});

it('checks the refreshed per-agent Codex address on rollback but restores the original binding bytes', async () => {
  const f = fixture(), original = fs.readFileSync(f.options.bindingFile);
  await migrateTeam(f.options, f.checks);
  const team = new TeamRegistry(f.profile), connections = new AgentConnections(f.profile, team);
  const refreshed = { ...connections.read('marlow')!, pipePath: '\\\\.\\pipe\\codex-browser-use-refreshed' };
  connections.bind({ id: 'marlow', revision: team.snapshot().revision, connection: refreshed }, () => {});
  await restoreTeam(f.options, f.checks);
  expect(f.checks.codex).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: f.threadId, pipePath: refreshed.pipePath }));
  expect(fs.readFileSync(f.options.bindingFile)).toEqual(original);
});

it('refuses an extra paused owner even if it is absent from the persisted roster', async () => {
  const f = fixture(); f.change(s => { s.backend.studio.personalPaused.push('custom_agent'); });
  const before = bytes(f.base);
  await expect(migrateTeam(f.options, f.checks)).rejects.toThrow('custom_agent'); expect(bytes(f.base)).toEqual(before);
});
