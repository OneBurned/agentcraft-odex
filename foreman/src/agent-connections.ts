import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { TeamId, TeamRegistry, validateReference } from './team.js';
import { readBinding, chatConfigPath } from './codex-desktop.js';
import { claudeWorkspace } from './claude-workspace.js';
import { conversation, conversationLease } from './claude-conversation.js';
import { readJson, writeJsonAtomic } from './util/fsx.js';

const base = { version: z.literal(1), agentId: TeamId };
const codex = z.object({ ...base, provider: z.literal('codex'), transport: z.literal('codex-desktop'),
  threadId: z.string().uuid(), hostId: z.literal('local'), title: z.string().max(1000),
  pipePath: z.string().startsWith('\\\\.\\pipe\\codex-browser-use-') }).strict();
const claude = z.object({ ...base, provider: z.literal('claude'), transport: z.literal('claude-code'),
  workspace: z.string().refine(path.isAbsolute), sessionId: z.string().uuid(), executable: z.string().refine(path.isAbsolute).optional() }).strict();
const codexCli = z.object({ ...base, provider: z.literal('codex'), transport: z.literal('codex-cli'),
  workspace: z.string().refine(path.isAbsolute), sessionId: z.string().uuid(),
  executable: z.string().refine(path.isAbsolute).refine(p => !/\.(cmd|bat|ps1)$/i.test(p), 'Use the native Codex executable, not a shell wrapper'),
  sandbox: z.enum(['read-only', 'workspace-write']).default('read-only') }).strict();
export const Connection = z.discriminatedUnion('transport', [codex, codexCli, claude]);
export type Connection = z.infer<typeof Connection>;
export const connectionSession = (c: Connection) => c.transport === 'codex-desktop' ? c.threadId : c.sessionId;
const request = z.object({ id: TeamId, revision: z.number().int().nonnegative(), connection: z.record(z.string(), z.unknown()) });
const endpoint = z.object({ connectionRef: z.string(), threadId: z.string().uuid(), hostId: z.literal('local'), pipePath: codex.shape.pipePath }).strict();

/** Immutable records: team.json's reference is the only activation point. No secrets on the wire. */
export class AgentConnections {
  private known = new Map<string, Connection>();
  constructor(readonly root: string, readonly team: TeamRegistry) {}
  file(ref: string) { validateReference(this.root, ref); return path.join(this.root, ref); }
  read(id: string): Connection | undefined {
    const agent = this.team.get(id);
    if (!agent?.connectionRef) return undefined;
    const file = this.file(agent.connectionRef);
    if (fs.statSync(file).size > 32000) throw new Error('Connection file is too large');
    const record = Connection.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (record.agentId !== id || record.provider !== agent.provider) throw new Error('Connection owner/provider mismatch');
    this.known.set(id, record);
    return record;
  }
  private identity(c: Connection) {
    return `${c.provider}:${connectionSession(c).toLowerCase()}`;
  }
  private workspace(c: Extract<Connection, { provider: 'claude' }>) {
    let real: string;
    try { real = fs.realpathSync(c.workspace); } catch { real = path.resolve(c.workspace); }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  }
  assertCurrent(expected: Connection): Connection {
    this.team.assertAgentUnchanged(expected.agentId);
    const actual = this.read(expected.agentId);
    if (!actual || !isDeepStrictEqual(actual, expected)) throw new Error('Подключение изменено извне. Перезапусти мост после проверки конфигурации.');
    if (actual.provider === 'claude' && conversation(actual.workspace)?.sessionId !== actual.sessionId)
      throw new Error('Сессия Claude не соответствует подключению агента. Переподключи выбранного агента.');
    return actual;
  }
  desktopBinding(c: Extract<Connection, { transport: 'codex-desktop' }>) {
    this.assertCurrent(c);
    const saved = readJson(this.file(`agents/${c.agentId}/codex-endpoint.json`));
    if (!saved) return c;
    const e = endpoint.parse(saved);
    // A new immutable connection never inherits a previous connection's endpoint.
    if (e.connectionRef !== this.team.get(c.agentId)!.connectionRef) return c;
    if (e.threadId !== c.threadId || e.hostId !== c.hostId) throw new Error('Endpoint identity mismatch');
    return { ...c, pipePath: e.pipePath };
  }
  prepareDesktopRefresh(raw: Record<string, unknown>) {
    const p = endpoint.omit({ connectionRef: true }).extend({ id: TeamId, revision: z.number().int().nonnegative() }).strict().parse(raw);
    this.team.assertUnchanged();
    const c = this.read(p.id), ref = this.team.get(p.id)?.connectionRef;
    const validate = () => {
      this.team.assertUnchanged();
      if (p.revision !== this.team.snapshot().revision) throw new Error('Team revision conflict');
      if (!c || c.transport !== 'codex-desktop' || c.threadId !== p.threadId || c.hostId !== p.hostId || !ref)
        throw new Error('Обновлять канал можно только для того же чата Codex.');
      this.assertCurrent(c);
      if (this.team.get(p.id)?.connectionRef !== ref) throw new Error('Подключение изменилось во время проверки.');
    };
    validate();
    return { id: p.id, binding: { ...(c as Extract<Connection, { transport: 'codex-desktop' }>), pipePath: p.pipePath },
      activate: () => { validate(); writeJsonAtomic(this.file(`agents/${p.id}/codex-endpoint.json`),
        { connectionRef: ref, threadId: p.threadId, hostId: p.hostId, pipePath: p.pipePath }); } };
  }
  bind(raw: Record<string, unknown>, idle: (id: string) => void) {
    const { id, revision, connection } = request.strict().parse(raw);
    const record = Connection.parse({ ...connection, version: 1, agentId: id });
    const agent = this.team.get(id);
    if (!agent || agent.archived || agent.provider !== record.provider) throw new Error('Unknown agent or wrong provider');
    idle(id); this.team.assertUnchanged();
    if (record.transport === 'codex-cli' && !fs.statSync(record.workspace).isDirectory()) throw new Error('Codex CLI workspace must be a directory');
    if (record.provider === 'claude') {
      claudeWorkspace(record.workspace);
      if (conversation(record.workspace)?.sessionId !== record.sessionId) throw new Error('conversation.json must name this Claude session');
      if (conversationLease(record.workspace)) throw new Error('Сначала верни этот разговор Claude из терминала/Code в игру.');
    }
    for (const a of this.team.snapshot().agents) {
      if (a.id === id) continue;
      let other;
      try { other = this.read(a.id); }
      catch { other = a.connectionRef ? this.known.get(a.id) : undefined; }
      if (other && (this.identity(record) === this.identity(other) || record.provider === 'claude' && other.provider === 'claude' && this.workspace(record) === this.workspace(other)))
        throw new Error(`Разговор уже назначен агенту ${a.name} (${a.id}). Выбери отдельный чат/сессию.`);
    }
    let existing;
    try { existing = this.read(id); } catch { /* An inactive damaged binding can be replaced. */ }
    if (isDeepStrictEqual(existing, record)) {
      if (revision !== this.team.snapshot().revision) throw new Error('Team revision conflict');
      return this.team.snapshot();
    }
    const ref = `connections/${id}-${randomUUID()}.json`;
    writeJsonAtomic(this.file(ref), record);
    const result = this.team.connect(id, ref, revision, idle);
    this.known.set(id, record);
    return result;
  }
  unbind(id: string, revision: number, idle: (id: string) => void) { return this.team.connect(id, null, revision, idle); }
  /** Explicit, idempotent legacy import into ONE selected agent; preserves source and cursor. */
  importCodex(id: string, revision: number, idle: (id: string) => void, source = chatConfigPath()) {
    const binding = readBinding(source);
    if (!binding) throw new Error('Legacy Codex binding not found');
    const existing = this.read(id);
    if (existing && (existing.transport !== 'codex-desktop' || existing.threadId !== binding.threadId)) throw new Error('Agent already has another conversation');
    const cursor = this.file(`agents/${id}/codex-chat-state.json`);
    const oldCursor = path.join(this.root, 'codex-chat-state.json');
    this.team.assertUnchanged();
    if (revision !== this.team.snapshot().revision) throw new Error('Team revision conflict');
    idle(id);
    let previousState;
    if (!fs.existsSync(cursor) && fs.existsSync(oldCursor)) {
      if (fs.statSync(oldCursor).size > 1000000) throw new Error('Legacy cursor is too large');
      previousState = z.object({ threadId: z.string(), seen: z.array(z.string()).max(1500),
        control: z.object({ mode: z.enum(['paused', 'stopped']), turnKey: z.string() }).optional() }).parse(JSON.parse(fs.readFileSync(oldCursor, 'utf8')));
    }
    // Back up before activating. Import never removes or rewrites the original binding.
    if (!existing) {
      const backup = this.file(`backups/codex-binding-${id}-${randomUUID()}.json`);
      writeJsonAtomic(backup, binding);
    }
    // Prepare cursor before the registry activation; a failed import cannot activate without it.
    if (previousState?.threadId === binding.threadId) writeJsonAtomic(cursor, previousState);
    return this.bind({ id, revision, connection: { ...binding, provider: 'codex', transport: 'codex-desktop' } }, idle);
  }
}
