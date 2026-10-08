import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { TeamRegistry } from '../src/team.js';
import { AgentConnections } from '../src/agent-connections.js';
import { acquireConversation, conversationLease } from '../src/claude-conversation.js';
import { tempDir, rmrf } from './helpers.js';
import { writeJsonAtomic } from '../src/util/fsx.js';

const dirs: string[] = [];
const dir = () => { const d = tempDir('agent-connection-'); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmrf(d); });
export const agentInput = (provider: 'codex' | 'claude' = 'codex') => ({ name: 'Agent', provider, roles: ['developer'], enabled: true, visible: true, appearance: { skin: 'marlow', color: '#123456', slim: false } });
const binding = (threadId = randomUUID()) => ({ provider: 'codex', transport: 'codex-desktop', threadId, hostId: 'local', title: 'Test', pipePath: '\\\\.\\pipe\\codex-browser-use-test' });
function fixture(provider: 'codex' | 'claude' = 'codex') {
  const root = dir(), team = new TeamRegistry(root), store = new AgentConnections(root, team);
  team.change('create', { revision: 0, agent: agentInput(provider) }, () => {});
  team.change('create', { revision: 1, agent: agentInput(provider) }, () => {});
  const [a, b] = team.snapshot().agents;
  const bind = (id: string, connection: object) => store.bind({ id, revision: team.snapshot().revision, connection }, () => {});
  return { root, team, store, a: a!.id, b: b!.id, bind };
}
function workspace(sessionId = randomUUID()) {
  const root = dir();
  writeJsonAtomic(path.join(root, 'access.json'), { version: 1, repositories: [{ id: 'test', name: 'Test', path: root, github: 'example/test' }] });
  writeJsonAtomic(path.join(root, 'conversation.json'), { version: 1, sessionId });
  for (const file of ['CLAUDE.md', 'MEMORY.md', 'PROJECTS.md']) fs.writeFileSync(path.join(root, file), 'Local instructions');
  return { provider: 'claude', transport: 'claude-code', workspace: root, sessionId };
}
it('persists separate Codex bindings and reserves archived conversations', () => {
  const f = fixture(); const first = binding(), second = binding();
  f.bind(f.a, first); f.bind(f.b, second);
  expect(f.store.read(f.a)).toMatchObject(first);
  expect(f.store.read(f.b)).toMatchObject(second);
  const refs = f.team.snapshot().agents.map(a => a.connectionRef); expect(new Set(refs).size).toBe(2);
  f.team.change('archive', { id: f.a, revision: f.team.snapshot().revision }, () => {});
  expect(() => f.bind(f.b, first)).toThrow('уже назначен');
  const restarted = new AgentConnections(f.root, new TeamRegistry(f.root));
  expect(restarted.read(f.b)).toMatchObject(second);
});
it('rejects two Claude agents using one session, one workspace, or a leased conversation', () => {
  const f = fixture('claude'), first = workspace(), second = workspace();
  f.bind(f.a, first); f.bind(f.b, second);
  expect(() => f.bind(f.b, workspace(first.sessionId))).toThrow('уже назначен');
  const lease = acquireConversation(second.workspace, 'terminal');
  expect(() => f.bind(f.b, second)).toThrow('терминала');
  expect(conversationLease(first.workspace)).toBeUndefined();
  expect(conversationLease(second.workspace)?.owner).toBe('terminal'); lease.release();
});
it('imports only the selected Codex binding, preserves source/cursor, and is idempotent', () => {
  const f = fixture(), source = path.join(dir(), 'codex-chat.json'); const c = binding();
  const { provider, transport, ...old } = c;
  writeJsonAtomic(source, old);
  const original = fs.readFileSync(source, 'utf8');
  const cursor = { threadId: old.threadId, seen: ['one/two'], control: { mode: 'paused', turnKey: 'one' } };
  writeJsonAtomic(path.join(f.root, 'codex-chat-state.json'), cursor);
  f.store.importCodex(f.a, 2, () => {}, source);
  expect(f.store.read(f.b)).toBeUndefined();
  expect(fs.readFileSync(source, 'utf8')).toBe(original);
  expect(JSON.parse(fs.readFileSync(path.join(f.root, `agents/${f.a}/codex-chat-state.json`), 'utf8'))).toEqual(cursor);
  f.store.importCodex(f.a, 3, () => {}, source);
  expect(f.team.snapshot().revision).toBe(3);
  expect(fs.readdirSync(path.join(f.root, 'backups'))).toHaveLength(1);
  expect(() => f.store.importCodex(f.b, 3, () => {}, source)).toThrow('уже назначен');
});
it('preserves the activated record on stale revision, busy mutation, and malformed config', () => {
  const f = fixture(); f.bind(f.a, binding()); const original = f.team.snapshot();
  expect(() => f.store.bind({ id: f.a, revision: 2, connection: binding() }, () => {})).toThrow('revision');
  expect(() => f.store.bind({ id: f.a, revision: 3, connection: binding() }, () => { throw new Error('busy'); })).toThrow('busy');
  expect(f.team.snapshot()).toEqual(original);
  const record = f.store.read(f.a)!;
  fs.writeFileSync(f.store.file(original.agents[0]!.connectionRef!), '{}');
  expect(() => f.store.assertCurrent(record)).toThrow();
});
it('detects external team edits and conversation replacement before using an adapter', () => {
  const f = fixture('claude'), c = workspace(); f.bind(f.a, c); const record = f.store.read(f.a)!;
  writeJsonAtomic(path.join(c.workspace, 'conversation.json'), { version: 1, sessionId: randomUUID() });
  expect(() => f.store.assertCurrent(record)).toThrow('Сессия Claude');
  const changed = f.team.snapshot(); changed.agents[0]!.enabled = false;
  writeJsonAtomic(f.team.file, changed);
  expect(() => f.store.assertCurrent(record)).toThrow('outside the bridge');
});
it('does not activate a legacy import when its source cursor is damaged', () => {
  const f = fixture(), source = path.join(dir(), 'binding.json');
  const { provider, transport, ...old } = binding(); writeJsonAtomic(source, old);
  fs.writeFileSync(path.join(f.root, 'codex-chat-state.json'), '{broken');
  expect(() => f.store.importCodex(f.a, 2, () => {}, source)).toThrow();
  expect(f.team.get(f.a)?.connectionRef).toBeNull(); expect(f.team.snapshot().revision).toBe(2);
});
it('binds an unrelated agent when another record is damaged but retains known session reservations', () => {
  const f = fixture(), first = binding(); f.bind(f.a, first);
  fs.writeFileSync(f.store.file(f.team.get(f.a)!.connectionRef!), '{broken');
  f.bind(f.b, binding());
  expect(() => f.bind(f.b, first)).toThrow('уже назначен');
  f.store.unbind(f.a, f.team.snapshot().revision, () => {});
  f.bind(f.b, first);
});
it('checks duplicate Claude session IDs even when the other workspace is missing', () => {
  const f = fixture('claude'), first = workspace(); f.bind(f.a, first);
  expect(dirs).toContain(first.workspace);
  fs.renameSync(first.workspace, path.join(dir(), 'moved'));
  f.bind(f.b, workspace());
  expect(() => f.bind(f.b, workspace(first.sessionId))).toThrow('уже назначен');
});
