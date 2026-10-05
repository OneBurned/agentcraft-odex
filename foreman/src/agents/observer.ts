// One-way, explicit progress reports from an existing Codex chat. No model or execution loop.
import { ClientError, type Backend, type Foreman } from '../foreman.js';
import type { AgentState, ObserverUpdate, Station, TaskStatus } from '../protocol.js';

const stations: Record<ObserverUpdate['state'], Station> = {
  thinking: 'meeting', reading: 'library', editing: 'desk', running: 'terminal',
  testing: 'testbench', waiting_user: 'user', blocked: 'desk', review: 'mergestation',
  done: 'lounge', error: 'terminal',
};
const guidance = 'Codex: работа идёт в чате; здесь — последние переданные статусы.';

export class ObserverBackend implements Backend {
  readonly name = 'observer' as const;
  private timer?: NodeJS.Timeout;
  constructor(private fm: Foreman) {}

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
  }

  expireActivity(): void {
    const a = this.fm.requireAgent('marlow');
    const task = a.taskId ? this.fm.tasks.get(a.taskId) : undefined;
    if (task && this.fm.ctx.now() - task.updatedAt > 5 * 60_000 &&
      ['thinking', 'reading', 'editing', 'running', 'testing'].includes(a.state)) {
      this.fm.act(a.id, 'idle', 'lounge', 'Нет новых статусов; см. чат Codex');
    }
  }

  onObserverUpdate(update: ObserverUpdate): Record<string, unknown> {
    const repo = update.repoId ? this.fm.repos.get(update.repoId) : this.fm.repos.defaultRepo();
    if (update.repoId && !repo) throw new ClientError(`no repo "${update.repoId}"`);
    let task = this.fm.tasks.list().find(t => t.observerKey === update.key);
    if (task && task.repoId !== repo?.id) throw new ClientError('observer key already belongs to another repository');
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
    // Observer tasks have no managed worktree. Statuses reflect external work, including retries.
    this.fm.tasks.update(task.id, { title: update.title, summary: update.summary, ci: update.ci });
    this.fm.tasks.setStatus(task.id, status, { force: true,
      reason: status === 'blocked' ? update.activity : undefined, summary: update.summary });
    if (task.goalId) this.fm.setGoal(task.goalId, { text: update.title, status: status === 'done' ? 'done' : 'active' });
    const state: AgentState = update.state === 'review' ? 'reading' : update.state;
    this.fm.setAgent('marlow', { active: true, paused: false, state, station: stations[update.state],
      activity: update.activity, taskId: task.id, repoId: repo?.id ?? null });
    if (update.log) this.fm.agentLog('marlow', update.state === 'error' ? 'error' : 'text', update.log);
    if (update.summary) this.fm.agentLog('marlow', 'result', update.summary);
    this.fm.bus.feed('task', update.activity, { agentId: 'marlow' });
    this.fm.setStatus({ auth: 'ok', message: guidance });
    return { taskId: task.id, goalId: task.goalId, state: update.state };
  }

  async stop(): Promise<void> { clearInterval(this.timer); }
  async submitGoal(): Promise<void> { throw new ClientError(guidance); }
  onUserMessage(): void {}
  onDecisionSettled(): void {}
  onTaskAction(): void {}
  onAgentAction(): void {}
}
