import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Foreman } from './foreman.js';
import { AgentConnections, type Connection } from './agent-connections.js';
import { createAdapter, type AgentAdapter, type AdapterFactory, type ConnectionPhase } from './agent-adapters.js';
import type { ChatControl } from './codex-desktop.js';
import { textChunks } from './codex-desktop.js';
import type { ConversationMessage } from './claude-conversation.js';
import { conversationLease } from './claude-conversation.js';
import type { ObserverUpdate, AgentState, Station } from './protocol.js';
import { readJson, writeJsonAtomic } from './util/fsx.js';

interface Slot { connection: Connection; ref: string; adapter: AgentAdapter; phase: ConnectionPhase; notice: string; history: ConversationMessage[]; rest?: NodeJS.Timeout; }
const History = z.array(z.object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string() }));
const stations: Record<ObserverUpdate['state'], Station> = { thinking: 'meeting', reading: 'library', editing: 'desk', running: 'terminal', testing: 'testbench', waiting_user: 'user', blocked: 'desk', review: 'mergestation', done: 'desk', error: 'terminal' };

/** Each slot owns its adapter, control state, history and callbacks. No provider-global recipient. */
export class AgentRuntime {
  readonly connections: AgentConnections;
  private slots = new Map<string, Slot>();
  private errors = new Map<string, string>();
  private closed = false;
  constructor(private fm: Foreman, private factory: AdapterFactory = createAdapter) {
    if (!fm.team) throw new Error('Team required');
    this.connections = new AgentConnections(fm.config.dataDir, fm.team);
  }
  private historyFile(id: string) {
    const c = this.connections.read(id)!;
    return this.connections.file(`agents/${id}/history/${c.provider}-${c.provider === 'codex' ? c.threadId : c.sessionId}.json`);
  }
  start() { this.reconcile(); }
  reconcile() {
    if (this.closed) return;
    this.connections.validateAll();
    for (const [id, slot] of this.slots) {
      const a = this.fm.team!.get(id);
      if (!a || a.archived || !a.enabled || a.connectionRef !== slot.ref) {
        clearTimeout(slot.rest); this.slots.delete(id);
        void slot.adapter.dispose().catch(e => this.fm.log.error(`Agent ${id}: ${(e as Error).message}`));
      }
    }
    for (const a of this.fm.team!.snapshot().agents) {
      if (a.archived) continue;
      let slot = this.slots.get(a.id);
      if (!slot && a.enabled && a.connectionRef) {
        try {
          const connection = this.connections.read(a.id)!;
          this.connections.assertCurrent(connection);
          const history = History.parse(readJson(this.historyFile(a.id)) ?? []);
          const current = () => !this.closed && this.slots.get(a.id) === slot;
          const adapter = this.factory(connection, this.connections, {
            activity: (phase, notice) => { if (current()) this.activity(a.id, phase, notice); },
            text: (text, final) => { if (current()) this.answer(a.id, text, final); },
            history: rows => { if (current()) { slot!.history = rows.slice(-200); this.saveHistory(a.id); } },
          });
          slot = { connection, ref: a.connectionRef, adapter, history, phase: 'unavailable', notice: 'Проверяю подключение' };
          this.slots.set(a.id, slot); this.errors.delete(a.id); adapter.start();
        } catch (e) { this.errors.set(a.id, (e as Error).message); }
      }
      this.controls(a.id);
    }
  }
  private controls(id: string) {
    const slot = this.slots.get(id), enabled = this.fm.team!.get(id)?.enabled;
    const ready = !!slot && !['unavailable', 'external'].includes(slot.phase);
    const busy = !!slot?.adapter.busy();
    const working = slot && ['working', 'waiting'].includes(slot.phase);
    const hint = slot?.notice || this.errors.get(id) || (enabled ? 'Не подключён' : 'Выключен');
    this.fm.setAgent(id, { controls: { message: !!enabled && ready && !busy && slot?.phase !== 'paused',
      pause: ready && !!working, resume: ready && slot?.phase === 'paused' && !busy,
      stop: (ready && (!!working || slot?.phase === 'paused' || slot?.phase === 'error')) ||
        slot?.connection.provider === 'claude' && slot.phase === 'unavailable' && slot.adapter.busy(), hint },
      ...(!slot ? { activity: hint, state: 'idle', paused: false } : {}) });
  }
  private activity(id: string, phase: ConnectionPhase, notice?: string) {
    const slot = this.slots.get(id)!;
    const previous = slot.phase;
    slot.phase = phase;
    const labels: Record<ConnectionPhase, string> = { working: 'Обрабатываю сообщение', waiting: 'Нужен ответ в приложении', completed: 'Ответ готов', interrupted: 'Ответ прерван', error: 'Ошибка исполнителя', idle: 'Ожидаю сообщение', unavailable: 'Связь недоступна; состояние неизвестно', paused: 'Ответ приостановлен', stopped: 'Выполнение остановлено', external: 'Разговор открыт в терминале/Code' };
    slot.notice = notice || labels[phase];
    const state: AgentState = phase === 'working' ? 'thinking' : phase === 'waiting' ? 'waiting_user' : phase === 'completed' ? 'done' : phase === 'error' ? 'error' : 'idle';
    if (phase !== previous || notice) {
      clearTimeout(slot.rest);
      this.fm.setAgent(id, { state, paused: phase === 'paused', station: phase === 'waiting' ? 'user' : phase === 'idle' ? 'lounge' : 'desk', activity: slot.notice });
      if (phase === 'completed') {
        slot.rest = setTimeout(() => { if (this.slots.get(id) === slot && slot.phase === 'completed') this.fm.setAgent(id, { station: 'lounge' }); }, 10000);
        slot.rest.unref();
      }
    }
    this.controls(id);
  }
  private saveHistory(id: string) { const slot = this.slots.get(id)!; slot.history = slot.history.slice(-200); writeJsonAtomic(this.historyFile(id), slot.history); }
  private append(id: string, role: 'user' | 'assistant', text: string) {
    const slot = this.slots.get(id)!;
    // Claude's native history callback arrives before its new-answer event.
    if (slot.history.at(-1)?.role !== role || slot.history.at(-1)?.text !== text) slot.history.push({ id: randomUUID(), role, text });
    this.saveHistory(id);
  }
  private answer(id: string, text: string, final: boolean) {
    this.append(id, 'assistant', text);
    this.fm.bus.feed('message', text, { agentId: id, to: 'user' });
    for (const chunk of textChunks(text, 1900)) this.fm.agentLog(id, final ? 'result' : 'text', chunk);
  }
  private slot(id: string): Slot {
    const a = this.fm.team!.get(id);
    if (!a || !a.enabled || a.archived) throw new Error('Выбери включённого агента по его ID.');
    const slot = this.slots.get(id);
    if (!slot) throw new Error(this.errors.get(id) || 'Агент не подключён.');
    this.connections.assertCurrent(slot.connection);
    return slot;
  }
  assertIdle(id: string) {
    const slot = this.slots.get(id);
    if (slot && (slot.adapter.busy() || !['idle', 'completed', 'stopped', 'paused'].includes(slot.phase)))
      throw new Error('Агент занят или остановка не подтверждена. Сначала останови его работу.');
    const c = this.connections.read(id);
    if (c) this.connections.assertCurrent(c);
    if (c?.provider === 'claude' && conversationLease(c.workspace)) throw new Error('Разговор занят. Сначала верни его из терминала/Code.');
  }
  assertCanBind(id: string, candidate: unknown) {
    const slot = this.slots.get(id);
    // App restarts change the pipe, not the conversation. Allow repairing only that identity;
    // never switch an unknown/busy agent to a different chat or detach an in-flight command.
    if (slot?.phase === 'unavailable' && !slot.adapter.busy() && slot.connection.provider === 'codex' &&
      candidate && typeof candidate === 'object' && 'provider' in candidate && candidate.provider === 'codex' &&
      'threadId' in candidate && candidate.threadId === slot.connection.threadId) {
      this.connections.assertCurrent(slot.connection); return;
    }
    this.fm.assertTeamAgentIdle(id);
  }
  async send(id: string, text: string, purpose: 'message' | 'task' = 'message') {
    const slot = this.slot(id);
    text = z.string().trim().min(1).max(12000).parse(text);
    let result;
    try { result = await slot.adapter.send(text, purpose); }
    catch (e) {
      // A timeout is not proof of non-delivery. Do not allow reassignment on an old idle status.
      if (!this.closed && this.slots.get(id) === slot) this.activity(id, 'unavailable', (e as Error).message);
      throw e;
    }
    if (this.closed || this.slots.get(id) !== slot) throw new Error('Подключение изменено во время отправки; проверь исходный разговор.');
    this.fm.bus.send('user', id, text); this.append(id, 'user', text);
    for (const chunk of textChunks('Вы: ' + text, 1900)) this.fm.agentLog(id, 'text', chunk);
    this.fm.store.data.replyAgentId = id; this.fm.store.markDirty();
    this.activity(id, 'working');
    return { ...result, agentId: id };
  }
  async control(id: string, action: ChatControl) {
    const slot = this.slot(id);
    try {
      const result = await slot.adapter.control(action);
      if (action === 'resume') this.activity(id, 'working');
      return { ...result, agentId: id };
    }
    finally { if (this.slots.get(id) === slot) this.controls(id); }
  }
  view(id: string) {
    const agent = this.fm.team!.get(id);
    if (!agent) throw new Error('Unknown agent');
    const slot = this.slots.get(id);
    if (!slot) {
      const connection = this.connections.read(id);
      return { agentId: id, provider: agent.provider, phase: agent.archived ? 'archived' : !agent.enabled ? 'disabled' : 'not_connected',
        notice: this.errors.get(id) || 'Не подключён', history: connection ? History.parse(readJson(this.historyFile(id)) ?? []) : [] };
    }
    this.connections.assertCurrent(slot.connection);
    return { agentId: id, provider: slot.connection.provider, transport: slot.connection.transport, phase: slot.phase, notice: slot.notice, history: structuredClone(slot.history) };
  }
  observe(update: ObserverUpdate) {
    if (!update.agentId) throw new Error('Для команды обязательно укажи agentId.');
    const id = update.agentId, slot = this.slot(id);
    if (!['working', 'waiting'].includes(slot.phase)) throw new Error('Нет подтверждённой активной работы этого агента.');
    const repo = update.repoId ? this.fm.repos.get(update.repoId) : this.fm.repos.defaultRepo();
    if (update.repoId && !repo) throw new Error('Unknown repository');
    const key = `${id}/${update.key}`;
    let task = this.fm.tasks.list().find(t => t.observerKey === key);
    if (task && task.repoId !== repo?.id) throw new Error('Observer key belongs to another repository');
    if (!task) { task = this.fm.tasks.create({ title: update.title, createdBy: id, assignee: id, repoId: repo?.id }); task.observerKey = key; }
    const status = update.state === 'done' ? 'done' : update.state === 'review' ? 'review' : ['blocked', 'error', 'waiting_user'].includes(update.state) ? 'blocked' : 'doing';
    this.fm.tasks.update(task.id, { title: update.title, summary: update.summary, ci: update.ci });
    this.fm.tasks.setStatus(task.id, status, { force: true, summary: update.summary });
    this.fm.setAgent(id, { state: update.state === 'review' ? 'reading' : update.state, station: stations[update.state], activity: update.activity, taskId: task.id, repoId: repo?.id ?? null });
    if (update.log) this.fm.agentLog(id, 'text', update.log);
    if (update.summary) this.fm.agentLog(id, 'result', update.summary);
    this.fm.bus.feed('task', update.activity, { agentId: id });
    return { agentId: id, taskId: task.id, state: update.state };
  }
  async stop() {
    this.closed = true;
    for (const slot of this.slots.values()) clearTimeout(slot.rest);
    await Promise.all([...this.slots.values()].map(slot => slot.adapter.dispose()));
    this.slots.clear();
  }
}
