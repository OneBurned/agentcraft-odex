// Explicit progress reports plus an opt-in desktop chat relay. No model or execution loop.
import { ClientError, type Backend, type Foreman } from '../foreman.js';
import type { AgentState, ObserverUpdate, Station, TaskStatus } from '../protocol.js';
import { DesktopChat, chatConfigPath, textChunks, type ChatActivity, type ChatControl } from '../codex-desktop.js';
import path from 'node:path';
import { Studio } from '../studio.js';

const stations: Record<ObserverUpdate['state'], Station> = {
  thinking: 'meeting', reading: 'library', editing: 'desk', running: 'terminal',
  testing: 'testbench', waiting_user: 'user', blocked: 'desk', review: 'mergestation',
  done: 'lounge', error: 'terminal',
};
const guidance = 'Codex: работа идёт в чате; здесь — последние переданные статусы.';
export const REST_DELAY_MS = 10_000;
const DETAIL_TTL_MS = 5 * 60_000;

export class ObserverBackend implements Backend {
  readonly name = 'observer' as const;
  private timer?: NodeJS.Timeout;
  private chat?: DesktopChat;
  private studio?: Studio;
  private chatGuidance = guidance;
  private restTimer?: NodeJS.Timeout;
  private lastChat?: ChatActivity;
  private chatAvailable = false;
  private chatSeenAt = 0;
  private detail?: { at: number; turnKey?: string; state: AgentState; station: Station; activity: string };
  constructor(private fm: Foreman, private chatFile = chatConfigPath()) {}

  async start(): Promise<void> {
    const lead = this.fm.requireAgent('marlow');
    lead.name = 'Codex';
    lead.title = 'TradeRecord · наблюдение';
    for (const a of this.fm.agents()) {
      this.fm.setAgent(a.id, { active: a.id === lead.id, paused: false, state: 'idle',
        station: 'lounge', activity: a.id === lead.id ? 'Ожидаю статус из чата Codex' : 'Не задействован',
        taskId: null, worktree: null });
    }
    // Publish the display name even when an already-idle roster needed no activity patch.
    this.fm.ctx.emit({ type: 'agent.upsert', agent: { ...lead } });
    this.fm.setStatus({ auth: 'ok', message: guidance });
    this.timer = setInterval(() => this.expireActivity(), 30_000);
    this.timer.unref();
    this.chat = new DesktopChat({ configFile: this.chatFile, stateFile: path.join(this.fm.config.dataDir, 'codex-chat-state.json'),
      onStatus: message => { this.chatGuidance = message; this.fm.setStatus({ auth: 'ok', message }); },
      onActivity: activity => this.onChatActivity(activity),
      onText: (text, final) => {
        this.fm.bus.feed('message', text, { agentId: 'marlow', to: 'user' });
        for (const chunk of textChunks(text, 1900)) this.fm.agentLog('marlow', final ? 'result' : 'text', chunk);
      },
    });
    this.chat.start();
    this.studio = new Studio(this.fm, { send: text => this.chat!.send(text), control: action => this.chat!.control(action) });
    this.studio.start();
  }

  expireActivity(): void {
    const a = this.fm.requireAgent('marlow');
    if (this.detail && this.fm.ctx.now() - this.detail.at > DETAIL_TTL_MS &&
      ['thinking', 'reading', 'editing', 'running', 'testing'].includes(a.state)) {
      this.detail = undefined;
      if (this.chatAvailable && this.lastChat?.phase === 'working' && this.fm.ctx.now() - this.chatSeenAt < 15_000) {
        this.fm.act(a.id, 'thinking', 'desk', 'Codex обрабатывает сообщение');
      } else this.fm.act(a.id, 'idle', 'lounge', 'Нет новых статусов; см. чат Codex');
    }
  }

  private cancelRest(): void { clearTimeout(this.restTimer); this.restTimer = undefined; }

  private restLater(): void {
    this.cancelRest();
    this.restTimer = setTimeout(() => {
      this.restTimer = undefined;
      const a = this.fm.requireAgent('marlow');
      if (a.state === 'done') this.fm.act(a.id, 'done', 'lounge', a.activity);
    }, REST_DELAY_MS);
    this.restTimer.unref();
  }

  onChatActivity(activity: ChatActivity): void {
    this.studio?.onActivity(activity);
    if (this.studio?.ownsActiveTask()) {
      this.cancelRest();
      if (activity.phase === 'waiting') this.fm.act('marlow', 'waiting_user', 'user', 'Нужно подтверждение в приложении Codex');
      return;
    }
    if (this.fm.decisions.open().some(d => d.tool === 'studio' && d.agentId === 'marlow')) {
      this.cancelRest(); this.fm.act('marlow', 'waiting_user', 'user', 'Нужно твоё решение по задаче'); return;
    }
    const previous = this.lastChat;
    const a = this.fm.requireAgent('marlow');
    if (activity.phase === 'paused' || activity.phase === 'stopped') {
      if (previous && (previous.key !== activity.key || previous.phase !== activity.phase)) this.fm.personas?.say(a.id, activity.phase === 'paused' ? 'pause' : 'stop');
      this.cancelRest(); this.detail = undefined;
      this.lastChat = activity; this.chatAvailable = true;
      this.fm.setAgent(a.id, { state: 'idle', paused: activity.phase === 'paused', station: 'desk',
        activity: activity.phase === 'paused' ? 'Задача в Codex приостановлена' : 'Выполнение в Codex остановлено' });
      return;
    }
    if (activity.phase === 'unavailable') {
      this.chatAvailable = false;
      this.cancelRest();
      if (!this.detail && previous && previous.phase !== 'idle') {
        this.fm.act(a.id, 'idle', a.station, 'Связь с чатом недоступна; статус неизвестен');
      }
      return;
    }
    const wasAvailable = this.chatAvailable;
    if (['working', 'waiting'].includes(activity.phase)) this.fm.setAgent(a.id, { paused: false });
    this.chatAvailable = true;
    this.lastChat = activity;
    this.chatSeenAt = this.fm.ctx.now();
    if (wasAvailable && previous?.key === activity.key && previous.phase === activity.phase) return;
    // Do not replay a historic completion on startup or a binding switch.
    const newTurn = previous?.key !== activity.key;
    const sameThread = previous?.key.split('/')[0] === activity.key.split('/')[0];
    if (newTurn && !['working', 'waiting'].includes(activity.phase) && !sameThread) {
      if (previous && !this.detail) {
        this.cancelRest();
        this.fm.act(a.id, 'idle', 'lounge', 'Ожидаю сообщение в подключённом чате');
      }
      return;
    }
    if (newTurn && ((previous?.phase === 'completed' && this.detail?.turnKey === previous.key) || !activity.startedAt ||
      (this.detail?.at ?? 0) < activity.startedAt)) this.detail = undefined;
    if (this.detail) this.detail.turnKey = activity.key;
    if (activity.phase === 'working') {
      if (previous && newTurn) this.fm.personas?.say(a.id, 'task_started');
      this.cancelRest();
      if (this.detail) {
        const d = this.detail;
        this.fm.act(a.id, d.state, d.station, d.activity);
        if (d.state === 'done') this.restLater();
      } else {
        this.fm.setAgent(a.id, { state: 'thinking', station: 'desk', activity: 'Codex обрабатывает сообщение',
          taskId: null, repoId: null });
      }
    } else if (activity.phase === 'waiting') {
      this.fm.personas?.say(a.id, 'question');
      this.cancelRest();
      this.fm.act(a.id, 'waiting_user', 'user', 'Нужен твой ответ или подтверждение в Codex');
    } else if (activity.phase === 'completed') {
      if (this.detail && ['waiting_user', 'blocked', 'error'].includes(this.detail.state)) return;
      if (this.detail?.state === 'done') {
        if (a.station !== 'lounge' && !this.restTimer) this.restLater();
        return;
      }
      this.fm.act(a.id, 'done', 'desk', 'Ответ готов');
      this.fm.personas?.say(a.id, 'task_finished');
      this.restLater();
    } else if (activity.phase === 'interrupted' || activity.phase === 'error') {
      this.fm.personas?.say(a.id, activity.phase === 'error' ? 'error' : 'stop');
      this.cancelRest();
      this.fm.act(a.id, activity.phase === 'error' ? 'error' : 'blocked', 'desk',
        activity.phase === 'error' ? 'Ошибка в чате; проверь Codex' : 'Ответ остановлен; проверь Codex');
    }
  }

  onObserverUpdate(update: ObserverUpdate): Record<string, unknown> {
    if (this.studio?.ownsActiveTask()) {
      if (update.state === 'error' || update.ci === 'fail') this.fm.personas?.say('marlow', 'error');
      if (update.state !== 'done') this.fm.act('marlow', update.state === 'review' ? 'reading' : update.state, stations[update.state], update.activity);
      return { taskId: this.studio.data.active, state: update.state };
    }
    const repo = update.repoId ? this.fm.repos.get(update.repoId) : this.fm.repos.defaultRepo();
    if (update.repoId && !repo) throw new ClientError(`no repo "${update.repoId}"`);
    let task = this.fm.tasks.list().find(t => t.observerKey === update.key);
    if (task && task.repoId !== repo?.id) throw new ClientError('observer key already belongs to another repository');
    const previousStatus = task?.status, previousCi = task?.ci;
    const previousState = this.fm.requireAgent('marlow').state;
    if (!task) {
      const goal = this.fm.createGoal(update.title, repo?.id);
      task = this.fm.tasks.create({ title: update.title, createdBy: 'marlow', assignee: 'marlow',
        goalId: goal.id, repoId: repo?.id });
      task.observerKey = update.key;
      this.fm.store.markDirty();
      this.fm.setGoal(goal.id, { status: 'active' });
    }
    const status: TaskStatus = update.state === 'done' ? 'done' : update.state === 'review' ? 'review'
      : ['blocked', 'error', 'waiting_user'].includes(update.state) ? 'blocked' : 'doing';
    if (update.state === 'error' || update.ci === 'fail') {
      if (previousStatus !== status || previousCi !== update.ci || (update.state === 'error' && previousState !== 'error')) this.fm.personas?.say('marlow', 'error');
    } else if (update.state === 'waiting_user' && previousState !== 'waiting_user') {
      this.fm.personas?.say('marlow', 'question');
    } else if (status !== previousStatus) {
      if (status === 'doing') this.fm.personas?.say('marlow', 'task_started');
      else if (status === 'done') this.fm.personas?.say('marlow', 'task_finished');
    }
    // Observer tasks have no managed worktree. Statuses reflect external work, including retries.
    this.fm.tasks.update(task.id, { title: update.title, summary: update.summary, ci: update.ci });
    this.fm.tasks.setStatus(task.id, status, { force: true,
      reason: status === 'blocked' ? update.activity : undefined, summary: update.summary });
    if (task.goalId) this.fm.setGoal(task.goalId, { text: update.title, status: status === 'done' ? 'done' : 'active' });
    const state: AgentState = update.state === 'review' ? 'reading' : update.state;
    this.cancelRest();
    const station = update.state === 'done' ? 'desk' : stations[update.state];
    this.detail = { at: this.fm.ctx.now(), state, station, activity: update.activity,
      turnKey: this.lastChat && ['working', 'waiting'].includes(this.lastChat.phase) ? this.lastChat.key : undefined };
    this.fm.setAgent('marlow', { active: true, paused: false, state, station,
      activity: update.activity, taskId: task.id, repoId: repo?.id ?? null });
    if (update.state === 'done') this.restLater();
    if (this.chatAvailable && this.lastChat?.phase === 'waiting') {
      this.cancelRest();
      this.fm.act('marlow', 'waiting_user', 'user', 'Нужен твой ответ или подтверждение в Codex');
    }
    if (update.log) this.fm.agentLog('marlow', update.state === 'error' ? 'error' : 'text', update.log);
    if (update.summary) this.fm.agentLog('marlow', 'result', update.summary);
    this.fm.bus.feed('task', update.activity, { agentId: 'marlow' });
    this.fm.setStatus({ auth: 'ok', message: this.chatGuidance });
    return { taskId: task.id, goalId: task.goalId, state: update.state };
  }

  async onChatMessage(text: string, agentId = 'marlow', reply = false): Promise<Record<string, unknown>> {
    try {
      if (agentId === 'wren') {
        if (!this.studio) throw new Error('Мост ещё запускается.');
        return await this.studio.messageClaude(text);
      }
      if (!this.chat) throw new Error('Чат не подключён.');
      if (reply && !this.studio) throw new Error('Мост ещё запускается.');
      const result = reply ? await this.studio!.replyCodex(text) : await this.chat.send(text);
      this.fm.bus.send('user', 'marlow', text);
      for (const chunk of textChunks('Вы: ' + text, 1900)) this.fm.agentLog('marlow', 'text', chunk);
      return result;
    } catch (e) { throw new ClientError((e as Error).message); }
  }
  async onChatControl(action: ChatControl, agentId = 'marlow'): Promise<Record<string, unknown>> {
    try {
      const id = ['wren', 'claude'].includes(agentId.toLowerCase()) ? 'wren' : 'marlow';
      const handled = await this.studio?.controlAgent(id, action);
      if (handled) return handled;
      if (id === 'wren') throw new Error('Мост Claude ещё запускается.');
      if (!this.chat) throw new Error('Чат не подключён.');
      return await this.chat.control(action);
    } catch (e) { throw new ClientError((e as Error).message); }
  }
  async onStudioAction(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.studio) throw new ClientError('Пульт ещё запускается.');
    return this.studio.action(action, payload);
  }
  async stop(): Promise<void> { clearInterval(this.timer); this.cancelRest(); this.studio?.stop(); this.chat?.stop(); }
  async submitGoal(): Promise<void> { throw new ClientError(guidance); }
  onUserMessage(): void {}
  onDecisionSettled(d: import('../protocol.js').Decision): void { this.studio?.onDecision(d); }
  onTaskAction(): void {}
  onAgentAction(): void {}
}
