import { DesktopChat, type ChatActivity, type ChatControl } from './codex-desktop.js';
import { ClaudeDialog, type DialogRunner } from './claude-dialog.js';
import { claudeWorkspace } from './claude-workspace.js';
import { findClaude, claudeLoggedIn } from './studio-review.js';
import { detectApiAuth } from './agents/claude/auth.js';
import { ARTIFACT_STYLE_RULE, personaPrompt } from './persona-prompt.js';
import type { ConversationMessage } from './claude-conversation.js';
import type { Connection, AgentConnections } from './agent-connections.js';
import { readJson, writeJsonAtomic } from './util/fsx.js';
import { CodexCliAdapter } from './codex-cli.js';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeDeveloper } from './agents/claude/developer.js';

export type ConnectionPhase = ChatActivity['phase'] | 'external';
export interface WorkRequest { role: 'developer' | 'reviewer'; cwd: string; taskId?: string; run?: string; }
export interface AdapterEvents {
  useClaudeLogin?: boolean;
  permission?(cwd: string, signal: AbortSignal): CanUseTool;
  personaDescription?(): string | undefined;
  activity(phase: ConnectionPhase, detail?: string): void;
  text(text: string, final: boolean): void;
  history(messages: ConversationMessage[]): void;
}
export interface AgentAdapter {
  start(): void;
  dispose(): Promise<void>;
  send(text: string, purpose: 'message' | 'task'): Promise<Record<string, unknown>>;
  execute?(text: string, work: WorkRequest): Promise<Record<string, unknown>>;
  control(action: ChatControl): Promise<Record<string, unknown>>;
  /** Pending local operations also prevent changing an agent before a poll observes work. */
  busy(): boolean;
  check?(): Promise<unknown>;
}
export type AdapterFactory = (c: Connection, store: AgentConnections, events: AdapterEvents) => AgentAdapter;

export class CodexAdapter implements AgentAdapter {
  readonly chat: DesktopChat;
  private pending = false;
  constructor(c: Extract<Connection, { transport: 'codex-desktop' }>, store: AgentConnections, events: AdapterEvents,
    overrides: Partial<ConstructorParameters<typeof DesktopChat>[0]> = {}) {
    this.chat = new DesktopChat({ configFile: store.file(store.team.get(c.agentId)!.connectionRef!),
      stateFile: store.file(`agents/${c.agentId}/codex-chat-state.json`),
      binding: () => { store.assertCurrent(c); return c; },
      personaDescription: events.personaDescription,
      onText: events.text, onActivity: a => events.activity(a.phase), onStatus: () => {}, ...overrides });
  }
  start() { this.chat.start(); }
  async dispose() { this.chat.stop(); }
  busy() { return this.pending; }
  async check() {
    if (this.pending) throw new Error('Предыдущая команда агента ещё выполняется.');
    this.pending = true;
    try { return await this.chat.check(); } finally { this.pending = false; }
  }
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

interface ClaudeState { sessionId: string; cursor?: string; pending?: string; purpose?: 'message' | 'task'; paused?: boolean; work?: WorkRequest; error?: string; }
export class ClaudeAdapter implements AgentAdapter {
  private runner: DialogRunner;
  private developer: DialogRunner;
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
    private events: AdapterEvents, runner?: DialogRunner, developer?: DialogRunner) {
    this.file = store.file(`agents/${c.agentId}/claude-state.json`);
    const saved = readJson<ClaudeState>(this.file);
    this.state = saved?.sessionId === c.sessionId ? saved : { sessionId: c.sessionId };
    // Interrupted bridge runs require an explicit resume, never automatic model invocation.
    if (this.state.pending) { this.state.paused = true; this.save(); }
    this.runner = runner ?? new ClaudeDialog(() => findClaude(c.executable), () => {
      this.store.assertCurrent(c); return claudeWorkspace(c.workspace);
    });
    this.developer = developer ?? new ClaudeDeveloper({ agentId: c.agentId, workspace: c.workspace,
      useClaudeLogin: events.useClaudeLogin ?? false,
      file: store.file(`agents/${c.agentId}/claude-developer.json`), executable: () => findClaude(c.executable),
      assertCurrent: () => store.assertCurrent(c), permission: (cwd, signal) => {
        if (!events.permission) throw new Error('Игровые разрешения Claude не подключены.');
        return events.permission(cwd, signal);
      } });
  }
  private save() { this.store.file(`agents/${this.c.agentId}/claude-state.json`); writeJsonAtomic(this.file, this.state); }
  private phase(phase: ConnectionPhase, detail?: string) { if (!this.closed) this.events.activity(phase, detail); }
  busy() { return !!this.running || this.controlling || this.stopUnconfirmed || !!this.runner.isRunning?.() || !!this.developer.isRunning?.(); }
  async check() {
    if (this.closed || this.busy() || this.polling) throw new Error('Агент занят. Повтори проверку позже.');
    this.controlling = true;
    try {
      this.store.assertCurrent(this.c);
      const external = this.runner.externalStatus?.();
      if (external) throw new Error(external);
      const executable = findClaude(this.c.executable);
      if (!executable) throw new Error('Claude Code не найден. Укажи путь к claude.exe.');
      if (!await claudeLoggedIn(executable)) throw new Error('В Claude Code не выполнен вход. Выполни claude auth login в терминале.');
      this.store.assertCurrent(this.c);
      const api = detectApiAuth();
      return { notice: 'Рабочее пространство, сессия и вход Claude Code проверены. Модель не вызывалась.',
        developer: api.ok ? 'Авторизация SDK настроена; доступ к API этой проверкой не подтверждается.' : this.events.useClaudeLogin
          ? 'SDK использует явно разрешённый вход Claude Code.' : 'Для разработки требуется авторизация SDK в настройках моста.' };
    } finally { this.controlling = false; }
  }
  start() { void this.poll(); this.timer = setInterval(() => void this.poll(), 5000); this.timer.unref(); }
  async poll() {
    if (this.closed || this.polling || this.running || this.controlling) return;
    this.polling = true;
    try {
      this.store.assertCurrent(this.c);
      if (this.stopUnconfirmed || this.runner.isRunning?.() || this.developer.isRunning?.()) { this.phase('unavailable', 'Остановка процесса ещё не подтверждена. Повтори Стоп.'); return; }
      const external = this.runner.externalStatus?.();
      if (external) { this.ready = false; this.phase('external', external); return; }
      await this.syncHistory();
      this.ready = true;
      this.phase(this.state.error ? 'error' : this.state.paused ? 'paused' : 'idle', this.state.error);
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
  execute(text: string, work: WorkRequest) { return this.send(text, 'task', false, work); }
  async send(text: string, purpose: 'message' | 'task', retry = false, work?: WorkRequest): Promise<Record<string, unknown>> {
    this.store.assertCurrent(this.c);
    const external = this.runner.externalStatus?.();
    if (external) throw new Error(external);
    if (this.closed || this.busy() || this.polling) throw new Error(this.runner.externalStatus?.() || 'Агент занят. Дождись завершения команды.');
    if (!this.ready) throw new Error('Подключение Claude ещё не подтверждено.');
    if (this.state.paused && !retry) throw new Error('Сначала продолжи или останови приостановленный ответ.');
    this.state.pending = text; this.state.purpose = purpose; this.state.work = work; this.state.paused = false; delete this.state.error; this.save();
    this.abort = new AbortController();
    this.phase('working');
    const signal = this.abort.signal;
    // Store running synchronously before any completion handler can publish a result.
    this.running = Promise.resolve().then(async () => {
      const style = purpose === 'message' ? personaPrompt(this.events.personaDescription?.()) : '';
      const runner = work?.role === 'developer' ? this.developer : this.runner;
      const result = await runner.run(text, signal, { text, context: '', retry, style: style || ARTIFACT_STYLE_RULE, work });
      if (this.closed || this.controlling || signal.aborted) return;
      this.store.assertCurrent(this.c);
      if (runner === this.runner && this.runner.shared?.()) await this.syncHistory();
      else this.events.text(result, true);
      delete this.state.pending; this.save(); this.phase('completed');
    }).catch(e => {
      if (!this.closed && !this.controlling && !signal.aborted) { this.state.paused = true; this.state.error = (e as Error).message; this.save(); this.phase('error', this.state.error); }
    }).finally(() => { this.running = undefined; });
    return { chatDelivered: true, agentId: this.c.agentId, sessionId: this.c.sessionId };
  }
  async control(action: ChatControl): Promise<Record<string, unknown>> {
    this.store.assertCurrent(this.c);
    const external = this.state.work?.role === 'developer' ? undefined : this.runner.externalStatus?.();
    if (external) throw new Error(external);
    if (this.closed || this.controlling || this.polling) throw new Error('Предыдущая команда ещё выполняется.');
    if (action === 'resume') {
      if (!this.state.paused || !this.state.pending) throw new Error('У агента нет приостановленного ответа.');
      return this.send(this.state.pending, this.state.purpose ?? 'message', true, this.state.work);
    }
    this.controlling = true;
    try {
      // Abort prevents a pre-spawn await from launching a late child. stop() verifies child exit.
      this.abort?.abort();
      await this.stopRunners();
      this.stopUnconfirmed = false;
      delete this.state.error;
      this.state.paused = action === 'pause' && !!this.state.pending;
      if (action === 'stop') delete this.state.pending;
      this.save(); this.phase(this.state.paused ? 'paused' : 'stopped');
      return { chatControl: this.state.paused ? 'paused' : 'stopped', agentId: this.c.agentId };
    } catch (e) { this.stopUnconfirmed = true; this.phase('unavailable', `Остановка не подтверждена: ${(e as Error).message}`); throw e; }
    finally { this.controlling = false; }
  }
  async dispose() {
    this.closed = true; clearInterval(this.timer);
    this.abort?.abort(); await this.stopRunners();
  }
  private async stopRunners() {
    // Attempt both stops even if one throws synchronously; don't await a live turn after failed stop.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.developer.stop()),
      Promise.resolve().then(() => this.runner.stop()),
    ]);
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, errors.map(e => e instanceof Error ? e.message : String(e)).join('; '));
    await this.running;
  }
}

export const createAdapter: AdapterFactory = (c, store, events) => c.transport === 'codex-cli'
  ? new CodexCliAdapter(c, store, events) : c.transport === 'codex-desktop'
  ? new CodexAdapter(c, store, events) : new ClaudeAdapter(c, store, events);
