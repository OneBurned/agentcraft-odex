import { DesktopChat, type ChatActivity, type ChatControl } from './codex-desktop.js';
import { ClaudeDialog, type DialogRunner } from './claude-dialog.js';
import { claudeWorkspace } from './claude-workspace.js';
import { findClaude } from './studio-review.js';
import { ARTIFACT_STYLE_RULE } from './persona-prompt.js';
import type { ConversationMessage } from './claude-conversation.js';
import type { Connection, AgentConnections } from './agent-connections.js';
import { readJson, writeJsonAtomic } from './util/fsx.js';

export type ConnectionPhase = ChatActivity['phase'] | 'external';
export interface AdapterEvents {
  activity(phase: ConnectionPhase, detail?: string): void;
  text(text: string, final: boolean): void;
  history(messages: ConversationMessage[]): void;
}
export interface AgentAdapter {
  start(): void;
  dispose(): Promise<void>;
  send(text: string, purpose: 'message' | 'task'): Promise<Record<string, unknown>>;
  control(action: ChatControl): Promise<Record<string, unknown>>;
  /** Pending local operations also prevent changing an agent before a poll observes work. */
  busy(): boolean;
}
export type AdapterFactory = (c: Connection, store: AgentConnections, events: AdapterEvents) => AgentAdapter;

export class CodexAdapter implements AgentAdapter {
  readonly chat: DesktopChat;
  private pending = false;
  constructor(c: Extract<Connection, { provider: 'codex' }>, store: AgentConnections, events: AdapterEvents,
    overrides: Partial<ConstructorParameters<typeof DesktopChat>[0]> = {}) {
    this.chat = new DesktopChat({ configFile: store.file(store.team.get(c.agentId)!.connectionRef!),
      stateFile: store.file(`agents/${c.agentId}/codex-chat-state.json`),
      binding: () => { store.assertCurrent(c); return c; },
      onText: events.text, onActivity: a => events.activity(a.phase), onStatus: () => {}, ...overrides });
  }
  start() { this.chat.start(); }
  async dispose() { this.chat.stop(); }
  busy() { return this.pending; }
  async send(text: string, purpose: 'message' | 'task') {
    if (this.pending) throw new Error('Предыдущая команда агента ещё выполняется.');
    this.pending = true;
    try { return await this.chat.send(text, purpose); } finally { this.pending = false; }
  }
  async control(action: ChatControl) {
    if (this.pending) throw new Error('Предыдущая команда агента ещё выполняется.');
    this.pending = true;
    try { return await this.chat.control(action); } finally { this.pending = false; }
  }
}

interface ClaudeState { sessionId: string; cursor?: string; pending?: string; purpose?: 'message' | 'task'; paused?: boolean; }
export class ClaudeAdapter implements AgentAdapter {
  private runner: DialogRunner;
  private timer?: NodeJS.Timeout;
  private abort?: AbortController;
  private running?: Promise<void>;
  private controlling = false;
  private polling = false;
  private closed = false;
  private ready = false;
  private historyReady = false;
  private stopUnconfirmed = false;
  private state: ClaudeState;
  private file: string;
  constructor(private c: Extract<Connection, { provider: 'claude' }>, private store: AgentConnections,
    private events: AdapterEvents, runner?: DialogRunner) {
    this.file = store.file(`agents/${c.agentId}/claude-state.json`);
    const saved = readJson<ClaudeState>(this.file);
    this.state = saved?.sessionId === c.sessionId ? saved : { sessionId: c.sessionId };
    // Interrupted bridge runs require an explicit resume, never automatic model invocation.
    if (this.state.pending) { this.state.paused = true; this.save(); }
    this.runner = runner ?? new ClaudeDialog(() => findClaude(c.executable), () => {
      this.store.assertCurrent(c); return claudeWorkspace(c.workspace);
    });
  }
  private save() { this.store.file(`agents/${this.c.agentId}/claude-state.json`); writeJsonAtomic(this.file, this.state); }
  private phase(phase: ConnectionPhase, detail?: string) { if (!this.closed) this.events.activity(phase, detail); }
  busy() { return !!this.running || this.controlling || this.stopUnconfirmed || !!this.runner.isRunning?.() || !!this.runner.externalStatus?.(); }
  start() { void this.poll(); this.timer = setInterval(() => void this.poll(), 5000); this.timer.unref(); }
  async poll() {
    if (this.closed || this.polling || this.running || this.controlling) return;
    this.polling = true;
    try {
      this.store.assertCurrent(this.c);
      if (this.stopUnconfirmed || this.runner.isRunning?.()) { this.phase('unavailable', 'Остановка процесса ещё не подтверждена. Повтори Стоп.'); return; }
      const external = this.runner.externalStatus?.();
      if (external) { this.ready = false; this.phase('external', external); return; }
      await this.syncHistory();
      this.ready = true;
      this.phase(this.state.paused ? 'paused' : 'idle');
    } catch (e) { this.ready = false; this.phase('unavailable', (e as Error).message); }
    finally { this.polling = false; }
  }
  private async syncHistory() {
    const rows = await this.runner.history?.();
    if (this.closed || !rows) return;
    this.store.assertCurrent(this.c);
    const index = this.state.cursor ? rows.findIndex(m => m.id === this.state.cursor) : -1;
    this.events.history(rows);
    if (index >= 0 || this.historyReady && !this.state.cursor)
      for (const row of rows.slice(index + 1)) if (row.role === 'assistant') this.events.text(row.text, true);
    this.historyReady = true;
    this.state.cursor = rows.at(-1)?.id; this.save();
  }
  async send(text: string, purpose: 'message' | 'task', retry = false): Promise<Record<string, unknown>> {
    this.store.assertCurrent(this.c);
    if (this.closed || this.busy() || this.polling) throw new Error(this.runner.externalStatus?.() || 'Агент занят. Дождись завершения команды.');
    if (!this.ready) throw new Error('Подключение Claude ещё не подтверждено.');
    if (this.state.paused && !retry) throw new Error('Сначала продолжи или останови приостановленный ответ.');
    this.state.pending = text; this.state.purpose = purpose; this.state.paused = false; this.save();
    this.abort = new AbortController();
    this.phase('working');
    const signal = this.abort.signal;
    // Store running synchronously before any completion handler can publish a result.
    this.running = Promise.resolve().then(async () => {
      const result = await this.runner.run(text, signal, { text, context: '', retry, style: ARTIFACT_STYLE_RULE });
      if (this.closed || this.controlling || signal.aborted) return;
      this.store.assertCurrent(this.c);
      if (this.runner.shared?.()) await this.syncHistory();
      else this.events.text(result, true);
      delete this.state.pending; this.save(); this.phase('completed');
    }).catch(e => {
      if (!this.closed && !this.controlling && !signal.aborted) { this.state.paused = true; this.save(); this.phase('error', (e as Error).message); }
    }).finally(() => { this.running = undefined; });
    return { chatDelivered: true, agentId: this.c.agentId, sessionId: this.c.sessionId };
  }
  async control(action: ChatControl): Promise<Record<string, unknown>> {
    this.store.assertCurrent(this.c);
    const external = this.runner.externalStatus?.();
    if (external) throw new Error(external);
    if (this.closed || this.controlling || this.polling) throw new Error('Предыдущая команда ещё выполняется.');
    if (action === 'resume') {
      if (!this.state.paused || !this.state.pending) throw new Error('У агента нет приостановленного ответа.');
      return this.send(this.state.pending, this.state.purpose ?? 'message', true);
    }
    this.controlling = true;
    try {
      // Abort prevents a pre-spawn await from launching a late child. stop() verifies child exit.
      this.abort?.abort();
      await this.runner.stop();
      await this.running;
      this.stopUnconfirmed = false;
      this.state.paused = action === 'pause' && !!this.state.pending;
      if (action === 'stop') delete this.state.pending;
      this.save(); this.phase(this.state.paused ? 'paused' : 'stopped');
      return { chatControl: this.state.paused ? 'paused' : 'stopped', agentId: this.c.agentId };
    } catch (e) { this.stopUnconfirmed = true; this.phase('unavailable', `Остановка не подтверждена: ${(e as Error).message}`); throw e; }
    finally { this.controlling = false; }
  }
  async dispose() {
    this.closed = true; clearInterval(this.timer);
    this.abort?.abort(); await this.runner.stop(); await this.running;
  }
}

export const createAdapter: AdapterFactory = (c, store, events) => c.provider === 'codex'
  ? new CodexAdapter(c, store, events) : new ClaudeAdapter(c, store, events);
