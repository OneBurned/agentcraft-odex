import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { TeamId, TeamRegistry, validateReference } from './team.js';
import { readBinding, chatConfigPath } from './codex-desktop.js';
import { claudeWorkspace } from './claude-workspace.js';
import { conversation, conversationLease } from './claude-conversation.js';
import { writeJsonAtomic } from './util/fsx.js';

const base = { version: z.literal(1), agentId: TeamId };
const codex = z.object({ ...base, provider: z.literal('codex'), transport: z.literal('codex-desktop'),
  threadId: z.string().uuid(), hostId: z.literal('local'), title: z.string().max(1000),
  pipePath: z.string().startsWith('\\\\.\\pipe\\codex-browser-use-') }).strict();
const claude = z.object({ ...base, provider: z.literal('claude'), transport: z.literal('claude-code'),
  workspace: z.string().refine(path.isAbsolute), sessionId: z.string().uuid(), executable: z.string().refine(path.isAbsolute).optional() }).strict();
export const Connection = z.discriminatedUnion('provider', [codex, claude]);
export type Connection = z.infer<typeof Connection>;
const request = z.object({ id: TeamId, revision: z.number().int().nonnegative(), connection: z.record(z.string(), z.unknown()) });

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
    return `${c.provider}:${c.provider === 'codex' ? c.threadId.toLowerCase() : c.sessionId.toLowerCase()}`;
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
  bind(raw: Record<string, unknown>, idle: (id: string) => void) {
    const { id, revision, connection } = request.strict().parse(raw);
    const record = Connection.parse({ ...(connection as object), version: 1, agentId: id });
    const agent = this.team.get(id);
    if (!agent || agent.archived || agent.provider !== record.provider) throw new Error('Unknown agent or wrong provider');
    idle(id); this.team.assertUnchanged();
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
    if (existing && (existing.provider !== 'codex' || existing.threadId !== binding.threadId)) throw new Error('Agent already has another conversation');
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
