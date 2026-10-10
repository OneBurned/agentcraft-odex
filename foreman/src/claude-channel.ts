import { randomUUID } from 'node:crypto';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentAdapter, AdapterEvents, WorkRequest } from './agent-adapters.js';
import type { AgentConnections, Connection } from './agent-connections.js';
import type { ChatControl } from './codex-desktop.js';
import { conversationLease, publicMessages, type ConversationMessage } from './claude-conversation.js';
import { ChannelMailbox, ChannelReceipt, ChannelRequest, type ChannelOwner } from './claude-channel-mailbox.js';
import { channelSession, type ChannelSession } from './claude-channel-status.js';
import { findClaude } from './studio-review.js';
import { readJson, writeJsonAtomic } from './util/fsx.js';
import { claudeWorkspace } from './claude-workspace.js';
import { workArguments } from './claude-dialog.js';
import { ARTIFACT_STYLE_RULE, personaPrompt } from './persona-prompt.js';

type Binding = Extract<Connection, { transport: 'claude-channel' }>;
const State = z.object({ sessionId: z.string().uuid(), pending: ChannelRequest.optional(), paused: z.boolean().default(false),
  stopped: z.boolean().default(false), stopUnconfirmed: z.boolean().default(false), cursor: z.string().optional(), error: z.string().optional() });
type State = z.infer<typeof State>;
type Probe = (executable: string, workspace: string, sessionId: string) => Promise<ChannelSession | undefined>;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Maps channel tool replies into the same public history as terminal text, without MCP envelopes. */
export function channelHistory(rows: Awaited<ReturnType<typeof getSessionMessages>>, mailbox: ChannelMailbox): ConversationMessage[] {
  const result: ConversationMessage[] = [];
  let channelTurn = false;
  for (const row of rows) {
    if (row.parent_tool_use_id) continue;
    const origin = (row as unknown as { origin?: { kind?: string; server?: string } }).origin;
    const content = (row.message as { content?: unknown })?.content;
    if (row.type === 'user' && origin?.kind === 'channel' && origin.server === 'agentcraft') {
      channelTurn = true;
      const id = typeof content === 'string' ? /event_id="([0-9a-f-]+)"/.exec(content)?.[1] : undefined;
      if (id && z.string().uuid().safeParse(id).success) {
        const request = mailbox.request(id);
        if (request) result.push({ id: row.uuid, role: 'user', text: request.display });
      }
      continue;
    }
    const plain = publicMessages([row]);
    if (row.type === 'user' && plain.length) channelTurn = false;
    if (row.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) if (b?.type === 'tool_use' && b.name === 'mcp__agentcraft__reply') {
        const id = b.input?.event_id;
        if (typeof id === 'string' && z.string().uuid().safeParse(id).success) {
          const reply = mailbox.reply(id);
          if (reply && !result.some(r => r.id === `channel:${id}`)) result.push({ id: `channel:${id}`, role: 'assistant', text: reply.text });
        }
      }
    }
    if (!channelTurn) result.push(...plain);
  }
  return result;
}

export class ClaudeChannelAdapter implements AgentAdapter {
  private state: State;
  private file: string;
  readonly mailbox: ChannelMailbox;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private controlling = false;
  private closed = false;
  private observedBusy = false;
  private initialized = false;
  constructor(private c: Binding, private store: AgentConnections, private events: AdapterEvents,
    private probe: Probe = channelSession,
    private messages = getSessionMessages) {
    this.file = store.file(`agents/${c.agentId}/claude-channel-state.json`);
    const saved = readJson(this.file);
    this.state = State.parse(saved ?? { sessionId: c.sessionId });
    if (this.state.sessionId !== c.sessionId) this.state = State.parse({ sessionId: c.sessionId });
    this.mailbox = new ChannelMailbox(c.workspace);
  }
  private save() { this.store.assertCurrent(this.c); writeJsonAtomic(this.file, this.state); }
  private owner() {
    this.store.assertCurrent(this.c);
    const o = this.mailbox.owner(), lease = conversationLease(this.c.workspace);
    if (!o || !this.mailbox.matches(o, { ...this.c, profile: this.store.root }) ||
      lease?.owner !== 'channel' || lease.pid !== o.pid || Date.now() - o.updated > 10000)
      throw new Error('Открой launcher канала Claude для этого агента.');
    return o;
  }
  private async session(owner: ChannelOwner) {
    const exe = findClaude(this.c.executable);
    if (!exe) throw new Error('Claude Code не найден.');
    const row = await this.probe(exe, this.c.workspace, this.c.sessionId);
    if (!row || row.pid !== owner.childPid) throw new Error('Исходная сессия канала не подтверждена. Проверь терминал Claude.');
    return row;
  }
  private async ready() {
    const o = this.owner();
    if (!this.mailbox.ready(o)) throw new Error('Подтверди запуск канала в терминале Claude, затем повтори команду.');
    const session = await this.session(o), current = this.owner();
    if (this.closed || current.token !== o.token || current.generation !== o.generation || !this.mailbox.ready(current))
      throw new Error('Подключение канала изменилось во время проверки.');
    return { owner: current, session };
  }
  private phase(phase: Parameters<AdapterEvents['activity']>[0], detail?: string) { if (!this.closed) this.events.activity(phase, detail); }
  busy() { return this.controlling || this.state.stopUnconfirmed || this.observedBusy || !!this.state.pending && !this.state.paused; }
  start() { void this.poll(); this.timer = setInterval(() => void this.poll(), 2000); this.timer.unref(); }
  // The terminal remains owned by its launcher when the bridge closes. Pending IDs stay durable.
  async dispose() { this.closed = true; clearInterval(this.timer); }
  async check() { const { session } = await this.ready(); return { notice: 'Терминальный канал и UUID подтверждены.', status: session.status }; }
  async poll() {
    if (this.closed || this.polling || this.controlling) return;
    this.polling = true;
    try {
      const o = this.owner();
      if (this.state.stopUnconfirmed || o.phase === 'error') throw new Error(o.error || 'Остановка не подтверждена. Повтори Стоп.');
      if (this.state.paused || this.state.stopped) {
        this.observedBusy = false;
        if (this.mailbox.ready(o)) {
          const native = await this.session(o);
          if (this.closed || this.controlling) return;
          this.observedBusy = native.status !== 'idle';
          if (this.observedBusy) { this.phase('working', 'Claude работает по сообщению в терминале.'); return; }
          await this.syncHistory(true);
        }
        this.phase(this.state.paused ? 'paused' : 'stopped', this.state.error || (this.state.paused
          ? 'Приостановлено. Продолжить откроет ту же сессию; подтверди канал в терминале.'
          : 'Остановлено. Продолжить откроет разговор без повторения задачи.')); return;
      }
      if (!this.mailbox.ready(o)) throw new Error(o.error || 'Канал не готов. Проверь терминал Claude.');
      const row = await this.session(o);
      if (this.closed || this.controlling) return;
      this.observedBusy = row.status !== 'idle';
      const p = this.state.pending;
      if (p) {
        if (p.token !== o.token || p.generation !== o.generation) {
          this.state.paused = true; this.state.error = 'Сеанс канала изменился. Предыдущая доставка могла выполниться; проверь историю перед Продолжить.';
          this.save(); this.phase('paused', this.state.error); return;
        }
        const reply = this.mailbox.reply(p.id);
        if (reply && row.status === 'idle') {
          await this.syncHistory(false);
          if (this.closed) return;
          // Persist receipt first: a bridge crash cannot invoke the queue completion twice.
          delete this.state.pending; this.save();
          if (!this.closed) this.events.text(reply.text, true);
          this.phase('completed'); return;
        }
        this.phase(row.status === 'waiting' || row.status === 'blocked' ? 'waiting' : 'working',
          this.mailbox.claimed(p.id) ? 'Сообщение отправлено в терминальную сессию; ожидаю полный ответ.' : 'Сообщение ожидает передачи в канал.');
        return;
      }
      if (!this.observedBusy) await this.syncHistory(true);
      this.phase(this.observedBusy ? (row.status === 'waiting' || row.status === 'blocked' ? 'waiting' : 'working') : 'idle');
    } catch (e) { this.phase('unavailable', (e as Error).message); }
    finally { this.polling = false; }
  }
  private async syncHistory(emit: boolean) {
    const rows = channelHistory(await this.messages(this.c.sessionId, { dir: this.c.workspace }), this.mailbox);
    if (this.closed) return;
    const index = rows.findIndex(r => r.id === this.state.cursor);
    this.events.history(rows);
    if (emit && (index >= 0 || this.initialized && !this.state.cursor))
      for (const row of rows.slice(index + 1)) if (row.role === 'assistant' && !row.id.startsWith('channel:')) this.events.text(row.text, true);
    this.state.cursor = rows.at(-1)?.id; this.initialized = true; this.save();
  }
  async execute(text: string, work: WorkRequest) {
    if (work.role === 'developer') throw new Error('Терминальный канал поддерживает разговор, планирование и ревью. Для разработки используй подключение Claude SDK.');
    workArguments(work, claudeWorkspace(this.c.workspace));
    return this.send(text, 'task');
  }
  async send(text: string, purpose: 'message' | 'task' | 'peer'): Promise<Record<string, unknown>> {
    if (this.closed || this.controlling || this.state.stopUnconfirmed || this.state.pending || this.state.paused || this.state.stopped) throw new Error('Сначала заверши или продолжи текущий разговор.');
    this.controlling = true;
    try {
      const { owner, session } = await this.ready();
      if (session.status !== 'idle') throw new Error('Claude занята в терминале. Дождись завершения хода.');
      const style = purpose === 'message' ? personaPrompt(this.events.personaDescription?.()) : ARTIFACT_STYLE_RULE;
      const request = ChannelRequest.parse({ id: randomUUID(), token: owner.token, generation: owner.generation,
        sessionId: this.c.sessionId, text: `${style}\n${this.events.messageInstructions?.() ?? ''}\n\n${text}`, display: text, created: Date.now() });
      this.state.pending = request; delete this.state.error; this.save();
      this.mailbox.enqueue(request); this.phase('working');
      return { chatDelivered: true, delivery: 'queued', messageId: request.id, sessionId: this.c.sessionId };
    } finally { this.controlling = false; }
  }
  private async command(owner: ChannelOwner, action: 'start' | 'stop') {
    const id = randomUUID();
    writeJsonAtomic(this.mailbox.file('controls', id), { id, token: owner.token, generation: owner.generation, action });
    for (let n = 0; n < 100; n++) {
      const receipt = this.mailbox.read(this.mailbox.file('control-results', id), ChannelReceipt);
      if (receipt) { if (!receipt.ok) throw new Error(receipt.error || 'Команда не выполнена'); return; }
      await delay(200);
    }
    throw new Error('Launcher не подтвердил команду. Проверь его окно и повтори.');
  }
  async control(action: ChatControl): Promise<Record<string, unknown>> {
    if (this.closed || this.controlling) throw new Error('Предыдущая команда ещё выполняется.');
    this.controlling = true;
    try {
      while (this.polling) await delay(25);
      const o = this.owner();
      if (action === 'resume') {
        if (this.state.stopUnconfirmed) throw new Error('Сначала подтверди остановку кнопкой Стоп.');
        if (!this.state.paused && !this.state.stopped) throw new Error('У агента нет приостановленного ответа.');
        if (!this.mailbox.ready(o)) {
          await this.command(o, 'start');
          const notice = 'Claude открывается в прежнем терминале. Подтверди канал и снова нажми Продолжить.';
          this.phase(this.state.paused ? 'paused' : 'stopped', notice);
          return { chatControl: this.state.paused ? 'paused' : 'stopped', notice };
        }
        const { owner, session } = await this.ready();
        if (session.status !== 'idle') throw new Error('Дождись окончания хода в терминале.');
        const previous = this.state.pending;
        if (previous) {
          this.mailbox.cancel(previous.id);
          const next = ChannelRequest.parse({ ...previous, id: randomUUID(), token: owner.token, generation: owner.generation,
            created: Date.now(), text: `Пользователь явно продолжает прерванный запрос ${previous.id}. Проверь историю: не повторяй уже выполненные действия.\n${previous.text}` });
          this.state.pending = next; this.state.paused = false; this.state.stopped = false; delete this.state.error; this.save(); this.mailbox.enqueue(next);
        } else { this.state.paused = false; this.state.stopped = false; this.save(); }
        this.phase(previous ? 'working' : 'idle');
        return { chatControl: 'resumed' };
      }
      // Cancel delivery first, then confirm actual process-tree termination through its owner.
      if (this.state.pending) this.mailbox.cancel(this.state.pending.id);
      await this.command(o, 'stop');
      const stopped = this.owner();
      if (stopped.phase !== 'stopped' || stopped.childPid) throw new Error('Остановка процесса не подтверждена.');
      this.observedBusy = false; this.state.stopUnconfirmed = false; this.state.paused = action === 'pause'; this.state.stopped = action === 'stop'; delete this.state.error;
      if (action === 'stop') delete this.state.pending;
      this.save(); this.phase(this.state.paused ? 'paused' : 'stopped');
      return { chatControl: this.state.paused ? 'paused' : 'stopped' };
    } catch (e) {
      if (action !== 'resume') { this.state.stopUnconfirmed = true; this.save(); }
      this.phase(this.state.stopUnconfirmed ? 'unavailable' : this.state.paused ? 'paused' : this.state.stopped ? 'stopped' : 'unavailable', (e as Error).message); throw e;
    }
    finally { this.controlling = false; }
  }
}
