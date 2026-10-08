// Foreman core: owns all state, composes the subsystems, applies user intents and exposes the
// primitives backends (sim / claude) use to drive agents. Transport-agnostic: the WS server feeds
// it ClientMessages and subscribes to outbound protocol messages.
import fs from 'node:fs';
import { TeamRegistry, TeamError } from './team.js';
import path from 'node:path';
import { MessageBus } from './bus.js';
import { loadCast, type CastMember } from './cast.js';
import type { Config } from './config.js';
import { FOREMAN_VERSION } from './config.js';
import { consoleLogger, type Ctx, type Logger } from './context.js';
import { DecisionError, DecisionQueue, type CreateDecisionInput } from './decisions.js';
import { Memory, MemoryError } from './memory.js';
import { Notifier } from './notifier.js';
import type {
  Agent,
  AgentState,
  ClientMessage,
  Decision,
  ForemanStatus,
  Goal,
  GoalStatus,
  LogEntry,
  LogKind,
  Outbound,
  Station,
  Task,
  ObserverUpdate,
} from './protocol.js';
import { RepoError, RepoManager } from './repos.js';
import { Store } from './store.js';
import { TaskError, TaskGraph } from './taskgraph.js';
import { setUserName, userName } from './user.js';
import { truncate } from './util/text.js';
import { PersonaSpeech } from './personas.js';
import { assertProfileAvailable } from './profile-maintenance.js';

export interface Backend {
  assertAgentIdle?(id: string): boolean | void;
  assertProfileChange?(enabled?: boolean): void;
  onTeamChanged?(): void;
  readonly name: 'sim' | 'claude' | 'observer';
  onObserverUpdate?(update: ObserverUpdate): Record<string, unknown>;
  onChatMessage?(text: string, agentId?: string, reply?: boolean): Promise<Record<string, unknown>>;
  onChatControl?(action: 'pause' | 'resume' | 'stop', agentId?: string): Promise<Record<string, unknown>>;
  onStudioAction?(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Called once after the core is ready (and after restart: resume work). */
  start(): Promise<void>;
  stop(): Promise<void>;
  submitGoal(goal: Goal): Promise<void>;
  onUserMessage(to: string, text: string): void;
  /** After a decision was answered and its side effects (merge etc.) applied. */
  onDecisionSettled(d: Decision): void;
  /**
   * An approved merge conflicts with the base branch (another task merged first). Return true when
   * the backend sent the task back to its worker to merge the base and resolve it; false (or no
   * method) leaves the merge decision open with the reason, for the user to handle.
   */
  onMergeConflict?(task: Task, info: { base: string; branch: string; files: string[]; reason: string }): boolean;
  onTaskAction(task: Task, action: 'reassign' | 'cancel' | 'retry' | 'prioritize', arg?: string): void;
  onAgentAction(agentId: string, action: 'pause' | 'resume' | 'stop' | 'spawn', arg?: string): Promise<void> | void;
}

export type Reply = (msg: Outbound) => void;

export class ClientError extends Error {}

export interface ForemanOptions {
  config: Config;
  logger?: Logger;
  notifier?: Notifier;
  now?: () => number;
}

const LOG_TEXT_MAX = 2000;

export class Foreman {
  readonly config: Config;
  readonly store: Store;
  readonly ctx: Ctx;
  readonly tasks: TaskGraph;
  readonly bus: MessageBus;
  readonly memory: Memory;
  readonly decisions: DecisionQueue;
  readonly repos: RepoManager;
  readonly notifier: Notifier;
  readonly log: Logger;
  readonly cast: CastMember[];
  readonly team?: TeamRegistry;
  readonly personas?: PersonaSpeech;
  backend: Backend | undefined;
  status: ForemanStatus;

  private listeners = new Set<(m: Outbound) => void>();
  private logBuffers = new Map<string, LogEntry[]>();
  private logTimer: NodeJS.Timeout | undefined;
  private goalTimers = new Set<string>();
  private closed = false;

  constructor(opts: ForemanOptions) {
    assertProfileAvailable(opts.config.dataDir);
    this.config = opts.config;
    this.log = opts.logger ?? consoleLogger('foreman', { debug: opts.config.debug, quiet: opts.config.quiet });
    // Capture provenance before Store can quarantine an unreadable state and return an empty model.
    const stateExisted = fs.existsSync(path.join(opts.config.dataDir, 'state.json')) ||
      (fs.existsSync(opts.config.dataDir) && fs.readdirSync(opts.config.dataDir).some(name => name.startsWith('state.json.corrupt-')));
    this.store = new Store(opts.config.dataDir);
    const now = opts.now ?? Date.now;
    this.ctx = { store: this.store, emit: (m) => this.emit(m), now, log: this.log };
    this.tasks = new TaskGraph(this.ctx, id => !this.team || !!this.team.get(id)?.enabled && !this.team.get(id)?.archived);
    this.bus = new MessageBus(this.ctx);
    this.memory = new Memory(this.ctx, path.join(opts.config.dataDir, 'memory'));
    this.decisions = new DecisionQueue(this.ctx);
    this.repos = new RepoManager(this.ctx, path.join(opts.config.dataDir, 'worktrees'), { mergeStyle: opts.config.mergeStyle, signMerges: opts.config.signMerges });
    this.notifier =
      opts.notifier ??
      new Notifier({ enabled: opts.config.notify, silent: opts.config.toastSilent, log: this.log, now });
    const dynamicTeam = opts.config.backend === 'observer' && (fs.existsSync(path.join(opts.config.dataDir, 'team.json')) || !stateExisted);
    const { cast, source } = dynamicTeam ? { cast: [], source: 'team.json' } : loadCast(opts.config.projectRoot);
    this.cast = cast;
    this.log.debug(`cast from ${source}`);
    setUserName(opts.config.userName);
    this.status = { version: FOREMAN_VERSION, backend: opts.config.backend, auth: opts.config.backend === 'sim' ? 'ok' : 'unknown', userName: userName() };
    if (opts.config.backend === 'sim') this.status.message = 'Simulated team (sim backend)';
    // Existing profiles remain legacy until the explicit A4 migration. Never infer a team from cast.
    if (dynamicTeam) {
      this.team = new TeamRegistry(opts.config.dataDir);
      this.syncTeam();
    } else this.initRoster();
    if (opts.config.backend === 'observer') this.personas = new PersonaSpeech({
      file: path.join(opts.config.dataDir, 'personas.json'), now, emit: message => this.emit(message),
      knownAgent: id => this.team ? !!this.team.get(id) && !this.team.get(id)!.archived : !!this.agent(id),
      warn: message => { this.log.warn(message); this.bus.feed('system', message); },
    });
    this.decisions.onCreated((d) => this.onDecisionCreated(d));
  }

  // ---- event plumbing ---------------------------------------------------------------------

  subscribe(l: (m: Outbound) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(m: Outbound): void {
    if (m.type === 'task.upsert' && m.task.goalId) this.scheduleGoalUpdate(m.task.goalId);
    for (const l of this.listeners) {
      try {
        l(m);
      } catch (e) {
        this.log.error(`listener failed: ${(e as Error).message}`);
      }
    }
  }

  // ---- roster -----------------------------------------------------------------------------

  private initRoster(): void {
    const agents = this.store.data.agents;
    for (const c of this.cast) {
      let a = agents.find((x) => x.id === c.id);
      if (!a) {
        a = {
          id: c.id,
          name: c.name,
          role: c.role,
          title: c.title,
          color: c.color,
          skin: c.id,
          state: 'idle',
          activity: c.role === 'lead' ? 'ready for a goal' : 'off shift',
          station: 'lounge',
          paused: false,
          active: c.role === 'lead',
        };
        if (c.accent) a.accent = c.accent;
        agents.push(a);
      } else {
        // cast may have been updated by the art track
        a.name = c.name;
        a.title = c.title;
        a.color = c.color;
        if (c.accent) a.accent = c.accent;
        a.role = c.role;
      }
    }
    this.store.markDirty();
  }

  get migratedPair(): boolean {
    const marker = this.store.data.backend.teamMigration as { version?: number; kind?: string } | undefined;
    return !!this.team && marker?.version === 1 && marker.kind === 'legacy-pair' && !this.store.data.backend.roleQueue;
  }

  syncTeam(): void {
    if (!this.team) return;
    const previous = this.agents();
    const next = this.team.snapshot().agents.filter(a => !a.archived).map(a => ({
      ...(previous.find(p => p.id === a.id) ?? {}),
      id: a.id, name: a.name, provider: a.provider, roles: a.roles, role: 'worker' as const,
      title: a.roles.join(', '), color: a.appearance.color, skin: a.appearance.skin, slim: a.appearance.slim,
      enabled: a.enabled, visible: a.visible, active: a.enabled, paused: previous.find(p => p.id === a.id)?.paused ?? false,
      state: previous.find(p => p.id === a.id)?.state ?? 'idle' as const, station: previous.find(p => p.id === a.id)?.station ?? 'lounge' as const, activity: a.enabled ? previous.find(p => p.id === a.id)?.activity ?? 'Не подключён' : 'Выключен',
      controls: { message: false, pause: false, resume: false, stop: false, hint: 'Подключение агента ещё не настроено' },
    }));
    this.store.data.agents = next;
    for (const a of previous) if (!next.some(n => n.id === a.id)) this.emit({ type: 'agent.remove', agentId: a.id });
    for (const a of next) this.emit({ type: 'agent.upsert', agent: a });
    if (!this.migratedPair && !next.some(a => a.id === this.store.data.replyAgentId && a.enabled)) delete this.store.data.replyAgentId;
    this.store.markDirty();
    this.backend?.onTeamChanged?.();
  }

  teamAction(action: string, payload: Record<string, unknown>): Record<string, unknown> {
    if (!this.team) throw new ClientError('Этот профиль ещё использует прежнюю команду. Сначала нужен перенос A4.');
    if (action === 'team.get') return { ...this.team.snapshot() };
    if (this.migratedPair && (action !== 'team.update' || !payload.patch || Object.keys(payload.patch as object).some(k => !['name', 'appearance', 'enabled', 'visible'].includes(k))))
      throw new ClientError('Перенесённая очередь сохраняет двух прежних исполнителей. Изменение состава и ролей станет доступно с новой очередью; внешность и имена можно менять сейчас.');
    const result = this.team.change(action.replace(/^team\./, ''), payload, id => {
      if (!this.migratedPair) return this.assertTeamAgentIdle(id);
      // The migrated studio still owns execution. Presentation edits must not depend on queue assignments.
      const enabled = (payload.patch as { enabled?: boolean }).enabled;
      if (enabled === false) {
        if (!this.backend?.assertProfileChange) throw new ClientError('Пульт ещё запускается.');
        this.backend.assertProfileChange(enabled);
      }
    });
    this.syncTeam();
    return { ...result };
  }

  assertTeamAgentIdle(id: string): void {
      let runtimeIdle;
      try { runtimeIdle = this.backend?.assertAgentIdle?.(id); } catch (e) { throw new TeamError((e as Error).message); }
      const a = this.agent(id);
      if (a && (runtimeIdle !== true && !['idle', 'done'].includes(a.state) || a.taskId && !['done', 'cancelled'].includes(this.tasks.get(a.taskId)?.status ?? '')) ||
        this.tasks.list().some(t => t.assignee === id && !['done', 'cancelled'].includes(t.status)) ||
        this.decisions.open().some(d => d.agentId === id))
        throw new TeamError('Агент занят или назначен на незавершённую задачу. Заверши или переназначь работу перед изменением.');
  }

  agents(): Agent[] {
    return this.store.data.agents;
  }

  agent(id: string): Agent | undefined {
    return this.store.data.agents.find((a) => a.id === id);
  }

  requireAgent(id: string): Agent {
    const a = this.agent(id);
    if (!a) throw new ClientError(`no agent "${id}"`);
    return a;
  }

  /** Resolve "@Kit", "kit", "Kit" -> "kit". */
  resolveAgentId(nameOrId: string): string | undefined {
    const n = nameOrId.replace(/^@/, '').trim().toLowerCase();
    const exact = this.agents().find(a => a.id === n);
    if (exact) return exact.id;
    const matches = this.agents().filter(a => a.name.toLowerCase() === n);
    return matches.length === 1 ? matches[0]!.id : undefined;
  }

  nameOf(id: string): string {
    if (id === 'user') return `${userName()}`;
    return this.agent(id)?.name ?? id;
  }

  /** Patch an agent and broadcast if anything changed. */
  setAgent(
    id: string,
    patch: Partial<Pick<Agent, 'state' | 'station' | 'activity' | 'paused' | 'active' | 'controls'>> & {
      taskId?: string | null;
      repoId?: string | null;
      worktree?: string | null;
    },
  ): Agent {
    const a = this.requireAgent(id);
    let changed = false;
    const set = <K extends 'state' | 'station' | 'activity' | 'paused' | 'active' | 'controls'>(k: K, v: Agent[K] | undefined) => {
      if (v !== undefined && a[k] !== v) {
        a[k] = v;
        changed = true;
      }
    };
    set('state', patch.state);
    set('station', patch.station);
    if (patch.activity !== undefined) set('activity', truncate(patch.activity.replace(/\s+/g, ' ').trim(), 48));
    set('paused', patch.paused);
    set('active', patch.active);
    if (patch.controls !== undefined && JSON.stringify(a.controls) !== JSON.stringify(patch.controls)) set('controls', patch.controls);
    for (const k of ['taskId', 'repoId', 'worktree'] as const) {
      const v = patch[k];
      if (v === undefined) continue;
      if (v === null) {
        if (a[k] !== undefined) {
          delete a[k];
          changed = true;
        }
      } else if (a[k] !== v) {
        a[k] = v;
        changed = true;
      }
    }
    if (changed) {
      this.store.markDirty();
      this.emit({ type: 'agent.upsert', agent: { ...a } });
    }
    return a;
  }

  /** Convenience: state + station + activity in one call. */
  act(id: string, state: AgentState, station: Station, activity: string): void {
    this.setAgent(id, { state, station, activity });
  }

  // ---- logs ---------------------------------------------------------------------------------

  /** Append a log line to an agent monitor. Batched (~30ms) into agent.log frames. */
  agentLog(agentId: string, kind: LogKind, text: string): void {
    if (this.closed) return;
    const entry: LogEntry = { ts: this.ctx.now(), kind, text: truncate(text.replace(/\r\n/g, '\n'), LOG_TEXT_MAX) };
    this.store.appendLog(agentId, [entry]);
    const buf = this.logBuffers.get(agentId) ?? [];
    buf.push(entry);
    this.logBuffers.set(agentId, buf);
    if (!this.logTimer) {
      this.logTimer = setTimeout(() => this.flushLogs(), 30);
      this.logTimer.unref?.();
    }
  }

  flushLogs(): void {
    if (this.logTimer) clearTimeout(this.logTimer);
    this.logTimer = undefined;
    for (const [agentId, entries] of this.logBuffers) {
      if (entries.length) this.emit({ type: 'agent.log', agentId, entries });
    }
    this.logBuffers.clear();
  }

  // ---- goals --------------------------------------------------------------------------------

  goals(): Goal[] {
    return this.store.data.goals;
  }

  currentGoal(): Goal | undefined {
    const g = this.store.data.goals;
    return g[g.length - 1];
  }

  goal(id: string): Goal | undefined {
    return this.store.data.goals.find((g) => g.id === id);
  }

  createGoal(text: string, repoId?: string): Goal {
    const now = this.ctx.now();
    const goal: Goal = { id: this.store.nextId('g'), text: text.trim(), progress: 0, status: 'planning', createdAt: now, updatedAt: now };
    if (repoId) goal.repoId = repoId;
    this.store.data.goals.push(goal);
    this.store.markDirty();
    this.emit({ type: 'goal.upsert', goal: { ...goal } });
    this.bus.feed('goal', `New goal: ${goal.text}`, { agentId: 'user' });
    return goal;
  }

  setGoal(id: string, patch: { status?: GoalStatus; progress?: number; text?: string }): Goal {
    const g = this.goal(id);
    if (!g) throw new ClientError(`no goal ${id}`);
    let changed = false;
    if (patch.status && g.status !== patch.status) {
      g.status = patch.status;
      changed = true;
    }
    if (patch.progress !== undefined && Math.abs(g.progress - patch.progress) > 1e-6) {
      g.progress = Math.max(0, Math.min(1, patch.progress));
      changed = true;
    }
    if (patch.text && patch.text !== g.text) {
      g.text = patch.text;
      changed = true;
    }
    if (changed) {
      g.updatedAt = this.ctx.now();
      this.store.markDirty();
      this.emit({ type: 'goal.upsert', goal: { ...g } });
    }
    return g;
  }

  private scheduleGoalUpdate(goalId: string): void {
    if (this.goalTimers.has(goalId)) return;
    this.goalTimers.add(goalId);
    queueMicrotask(() => {
      this.goalTimers.delete(goalId);
      const g = this.goal(goalId);
      if (!g) return;
      const all = this.tasks.forGoal(goalId);
      const live = all.filter((t) => t.status !== 'cancelled');
      // every task was cancelled or rejected: the goal is over (it would sit at 0% forever);
      // if the lead adds a new task to it later, it is active again
      if (g.status === 'active' && all.length && !live.length) {
        this.setGoal(goalId, { status: 'cancelled', progress: 0 });
        this.bus.feed('goal', `Goal closed: every task was cancelled or rejected (${truncate(g.text, 80)})`);
        return;
      }
      if (g.status === 'cancelled' && live.length) this.setGoal(goalId, { status: 'active' });
      // progress stays 0 while the lead is still planning (avoids a jittering ring)
      if (g.status === 'cancelled' || g.status === 'failed' || g.status === 'planning') return;
      const progress = this.tasks.progress(goalId);
      const complete = this.tasks.goalComplete(goalId);
      const wasDone = g.status === 'done';
      this.setGoal(goalId, { progress: complete ? 1 : progress, ...(complete ? { status: 'done' as const } : g.status === 'done' ? { status: 'active' as const } : {}) });
      if (complete && !wasDone) {
        this.bus.feed('goal', `Goal complete: ${g.text}`);
        this.notify('info', `Goal complete: ${truncate(g.text, 80)}`);
      }
    });
  }

  // ---- decisions ----------------------------------------------------------------------------

  createDecision(input: CreateDecisionInput): Decision {
    return this.decisions.create(input);
  }

  private onDecisionCreated(d: Decision): void {
    this.personas?.say(d.agentId, 'question');
    const who = this.nameOf(d.agentId);
    const label = d.kind === 'merge' ? 'merge review' : d.kind === 'permission' ? 'permission' : 'question';
    this.bus.feed('decision', `${who} needs you (${label}): ${d.question}`, { agentId: d.agentId, to: 'user' });
    this.notify('need_user', `${who}: ${truncate(d.question, 120)}`, d.id);
    this.notifier.needUser(`${who}: ${d.question}`);
  }

  notify(level: 'info' | 'warn' | 'need_user', text: string, decisionId?: string): void {
    const m: Outbound = {
      type: 'notify',
      level,
      text,
      ts: this.ctx.now(),
      ...(decisionId ? { decisionId } : {}),
    };
    this.emit(m);
  }

  /** Answer a decision, run kind-specific side effects, then wake the waiting agent. */
  async answerDecision(id: string, option?: string | number, text?: string): Promise<Decision> {
    let d: Decision;
    try {
      d = this.decisions.answer(id, option, text);
    } catch (e) {
      if (e instanceof DecisionError) throw new ClientError(e.message);
      throw e;
    }
    const answerText = [d.answer?.option, d.answer?.text].filter(Boolean).join(' — ');
    this.bus.feed('decision', `${userName()} answered ${this.nameOf(d.agentId)}: ${answerText}`, { agentId: 'user', to: d.agentId });
    if (d.kind === 'merge') await this.applyMergeAnswer(d);
    if (d.status === 'answered' || d.status === 'cancelled') {
      this.decisions.settle(d.id);
      try {
        this.backend?.onDecisionSettled(d);
      } catch (e) {
        this.log.error(`backend.onDecisionSettled: ${(e as Error).message}`);
      }
    }
    return d;
  }

  private async applyMergeAnswer(d: Decision): Promise<void> {
    const task = d.taskId ? this.tasks.get(d.taskId) : undefined;
    const option = d.answer?.option;
    if (option === 'Merge') {
      try {
        const res = await this.repos.merge(d, task ? { commitMessage: `${task.id}: ${task.title}${task.summary ? `\n\n${task.summary}` : ''}` } : {});
        if (task) this.tasks.setStatus(task.id, 'done', { viaMerge: true, force: task.status !== 'review' });
        this.bus.feed('merge', `Merged ${res.branch} into ${res.base} (${res.sha}, ${res.files} file${res.files === 1 ? '' : 's'})`, { agentId: d.agentId });
        this.notify('info', `Merged ${res.branch} into ${res.base}`);
      } catch (e) {
        if (e instanceof RepoError && e.code === 'empty' && task && d.repoId && d.worktree) {
          // nothing to merge (a report or investigation): the task is simply done
          await this.repos.abandon(d.repoId, d.worktree, `agentcraft: ${task.id} (no changes)`).catch((err) => this.log.warn(`abandon: ${(err as Error).message}`));
          this.tasks.setStatus(task.id, 'done', { force: true });
          this.bus.feed('merge', `Nothing to merge for ${task.id} (no file changes): closed as done`, { agentId: d.agentId });
          this.notify('info', `${task.id} had no changes: closed as done`);
          return;
        }
        const reason = e instanceof RepoError ? e.message : `merge failed: ${(e as Error).message}`;
        if (e instanceof RepoError && e.code === 'conflict' && task?.assignee && d.repoId && d.worktree && this.backend?.onMergeConflict) {
          // parallel tasks touched the same lines: the branch's worker merges the base and resolves
          // it, then the task comes back through review with a fresh merge decision
          const wt = this.repos.findWorktree(d.repoId, d.worktree);
          const info = { base: wt?.base ?? 'main', branch: wt?.branch ?? d.worktree, files: e.files, reason };
          let handled = false;
          try {
            handled = this.backend.onMergeConflict(task, info);
          } catch (err) {
            this.log.error(`backend.onMergeConflict: ${(err as Error).message}`);
          }
          if (handled) {
            this.log.info(`merge for ${d.id} conflicts with ${info.base} (${e.files.join(', ')}): sent back to ${task.assignee}`);
            this.bus.feed('merge', `${task.id} conflicts with ${info.base} in ${e.files.join(', ') || 'some files'}: ${this.nameOf(task.assignee)} merges ${info.base} and resolves it`, { agentId: task.assignee });
            this.notify('info', `${task.id} conflicts with ${info.base}: sent back to ${this.nameOf(task.assignee)} to resolve`);
            return;
          }
        }
        this.log.warn(`merge for ${d.id} refused: ${reason}`);
        const base = (d.context ?? '').replace(/\n*Merge refused: [\s\S]*$/, '');
        this.decisions.reopen(d.id, `${base}${base ? '\n\n' : ''}Merge refused: ${reason}`);
        this.bus.feed('error', `Merge refused: ${reason}`, { agentId: d.agentId });
        this.notify('warn', `Merge refused: ${truncate(reason, 160)}`, d.id);
        // broadcast the repo as it is now (e.g. dirty=true), so the mod can show why
        if (d.repoId && this.repos.get(d.repoId)) await this.repos.refresh(d.repoId).catch((err) => this.log.warn(`refresh ${d.repoId}: ${(err as Error).message}`));
      }
    } else if (option === 'Request changes') {
      if (task && task.status !== 'doing') {
        this.tasks.setStatus(task.id, 'doing', { force: true });
        if (d.answer?.text) this.tasks.update(task.id, { summary: `Changes requested: ${d.answer.text}` });
      }
    } else if (option === 'Reject') {
      if (d.repoId && d.worktree) await this.repos.abandon(d.repoId, d.worktree).catch((e) => this.log.warn(`abandon: ${(e as Error).message}`));
      if (task) {
        this.tasks.setStatus(task.id, 'cancelled', { force: true });
        for (const dep of this.tasks.dependents(task.id)) {
          if (dep.status === 'todo') this.tasks.setStatus(dep.id, 'blocked', { reason: `depends on rejected ${task.id}`, force: true });
        }
      }
      this.bus.feed('merge', `Rejected ${d.worktree ?? 'branch'} (branch kept for recovery)`, { agentId: d.agentId });
    }
  }

  // ---- foreman status -------------------------------------------------------------------------

  setStatus(patch: Partial<ForemanStatus>): void {
    const next = { ...this.status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.emit({ type: 'foreman.status', status: { ...this.status } });
  }

  // ---- snapshot -----------------------------------------------------------------------------

  snapshot(): Extract<Outbound, { type: 'snapshot' }> {
    this.flushLogs();
    const decisions = this.store.data.decisions;
    const open = decisions.filter((d) => d.status === 'open');
    const recent = decisions.filter((d) => d.status !== 'open').slice(-20);
    const goal = this.currentGoal();
    return {
      type: 'snapshot',
      ...(this.store.data.replyAgentId ? { replyAgentId: this.store.data.replyAgentId } : this.team ? {} : { replyAgentId: 'marlow' }),
      foreman: { ...this.status },
      agents: this.agents().map((a) => ({ ...a })),
      tasks: this.tasks.list().map((t) => ({ ...t, deps: [...t.deps] })),
      decisions: [...recent, ...open].sort((a, b) => a.createdAt - b.createdAt),
      repos: this.repos.list().map((r) => ({ ...r, worktrees: r.worktrees.map((w) => ({ ...w })) })),
      memory: this.memory.list(),
      ...(goal ? { goal: { ...goal } } : {}),
      goals: this.goals().map((g) => ({ ...g })),
      feed: this.store.data.feed.slice(-200),
      logs: this.agents().map((a) => ({ agentId: a.id, entries: this.store.logTail(a.id).slice(-60) })),
    };
  }

  // ---- inbound ------------------------------------------------------------------------------

  /** Apply a client intent. `reply` sends to the originating client only. */
  async handle(msg: ClientMessage, reply: Reply): Promise<void> {
    const ack = (ok: boolean, extra: { error?: string; result?: Record<string, unknown> } = {}) => {
      if (msg.id) reply({ type: 'ack', re: msg.id, ok, ...extra });
    };
    try {
      const result = await this.dispatch(msg, reply);
      ack(true, result ? { result } : {});
    } catch (e) {
      const known = e instanceof TeamError || e instanceof ClientError || e instanceof TaskError || e instanceof RepoError || e instanceof DecisionError || e instanceof MemoryError;
      const message = known ? (e as Error).message : `internal error: ${(e as Error).message}`;
      if (!known) this.log.error(`${msg.type}: ${(e as Error).stack ?? e}`);
      reply({ type: 'error', message, ...(msg.id ? { re: msg.id } : {}) });
      ack(false, { error: message });
    }
  }

  private async dispatch(msg: ClientMessage, reply: Reply): Promise<Record<string, unknown> | undefined> {
    if (msg.type === 'studio.action' && 'token' in msg.payload && !['draft.list', 'draft.create'].includes(msg.action))
      throw new ClientError('Разрешение планировщика позволяет только draft.list и draft.create.');
    if (msg.type === 'studio.action' && msg.action.startsWith('team.')) return this.teamAction(msg.action, msg.payload);
    if (this.team && !this.migratedPair && !['hello', 'repo.add', 'diff.request', 'agent.scene', 'studio.action', 'user.message', 'agent.action', 'observer.update', 'decision.answer'].includes(msg.type))
      throw new ClientError('Агент не подключён. Выполнение ролей для новой команды будет доступно после настройки подключений.');
    if (this.team && !this.migratedPair && (msg.type === 'user.message' || msg.type === 'agent.action')) {
      const id = this.resolveAgentId(msg.type === 'user.message' ? msg.to : msg.agentId);
      if (!id || !this.team.get(id)?.enabled) throw new ClientError('Выбери включённого агента по ID или уникальному имени.');
      if (msg.type === 'user.message') return this.backend?.onChatMessage?.(msg.text, id, msg.reply);
      if (!['pause', 'resume', 'stop'].includes(msg.action)) throw new ClientError('Доступны pause, resume, stop.');
      return this.backend?.onChatControl?.(msg.action as 'pause' | 'resume' | 'stop', id);
    }
    if (msg.type === 'agent.scene') {
      if (!this.personas) throw new ClientError('Реплики сцен доступны в режиме наблюдения.');
      const resting = (id: string) => {
        const a = this.requireAgent(id);
        return a.active && a.visible !== false && !a.paused && a.station === 'lounge' && ['idle', 'done'].includes(a.state)
          && !this.decisions.open().some(d => d.agentId === id);
      };
      if (!resting(msg.agentId) || (msg.event === 'peer' && (!msg.peerAgentId || msg.peerAgentId === msg.agentId || !resting(msg.peerAgentId))))
        return { spoken: false };
      return { spoken: msg.event === 'peer' ? this.personas.say(msg.agentId, msg.event, msg.peerAgentId) : this.personas.say(msg.agentId, msg.event) };
    }
    if (msg.type === 'studio.action') {
      if (!this.backend?.onStudioAction) throw new ClientError('Пульт доступен в режиме Codex.');
      return this.backend.onStudioAction(msg.action, msg.payload);
    }
    if (this.config.backend === 'observer' && msg.type === 'agent.action') {
      if (!['marlow', 'codex', 'wren', 'claude'].includes(msg.agentId.toLowerCase()) ||
        !['pause', 'resume', 'stop'].includes(msg.action) || !this.backend?.onChatControl) {
        throw new ClientError('Для Codex доступны только пауза, продолжение и остановка подключённой задачи.');
      }
      return this.backend.onChatControl(msg.action as 'pause' | 'resume' | 'stop', msg.agentId);
    }
    if (this.config.backend === 'observer' && (msg.type === 'goal.submit' || msg.type === 'user.message')) {
      if (!this.backend?.onChatMessage) throw new ClientError('Чат Codex не подключён.');
      if (msg.type === 'user.message' && !['all', 'marlow', 'codex', 'wren', 'claude'].includes(msg.to.toLowerCase())) {
        throw new ClientError('Выбери Codex или Claude.');
      }
      return this.backend.onChatMessage(msg.text, msg.type === 'user.message' && ['wren', 'claude'].includes(msg.to.toLowerCase()) ? 'wren' : 'marlow',
        msg.type === 'user.message' && msg.reply === true);
    }
    if (this.config.backend === 'observer' && msg.type === 'decision.answer' &&
      (['studio', 'role-queue'].includes(this.decisions.get(msg.decisionId)?.tool ?? '') ||
        this.team && !this.migratedPair && this.decisions.get(msg.decisionId)?.kind === 'permission')) {
      await this.answerDecision(msg.decisionId, msg.option, msg.text);
      return { decisionId: msg.decisionId };
    }
    if (this.config.backend === 'observer' && !['hello', 'observer.update', 'repo.add', 'diff.request'].includes(msg.type)) {
      throw new ClientError('Режим наблюдения: задачи, сообщения и согласования — в чате Codex. Игра только показывает ход работы.');
    }
    switch (msg.type) {
      case 'observer.update':
        if (this.backend?.name !== 'observer' || !this.backend.onObserverUpdate) throw new ClientError('observer.update requires the observer backend');
        return this.backend.onObserverUpdate(msg);
      case 'hello':
        reply(this.snapshot());
        return undefined;
      case 'goal.submit':
        return { goalId: (await this.submitGoal(msg.text, msg.repoId)).id };
      case 'user.message': {
        const { to, text } = this.routeUserMessage(msg.to, msg.text);
        this.bus.send('user', to, text);
        this.backend?.onUserMessage(to, text);
        return { to };
      }
      case 'decision.answer': {
        const d = await this.answerDecision(msg.decisionId, msg.option, msg.text);
        return { decisionId: d.id, status: d.status };
      }
      case 'task.action':
        this.taskAction(msg.taskId, msg.action, msg.arg);
        return { taskId: msg.taskId };
      case 'agent.action':
        await this.agentAction(msg.agentId, msg.action, msg.arg);
        return { agentId: msg.agentId };
      case 'diff.request': {
        try {
          const d = await this.repos.diff(msg.repoId, msg.worktree);
          reply({ type: 'diff', requestId: msg.requestId, repoId: d.repoId, worktree: d.worktree, base: d.base, branch: d.branch, files: d.files, stats: d.stats, truncated: d.truncated });
        } catch (e) {
          reply({ type: 'diff', requestId: msg.requestId, repoId: msg.repoId, worktree: msg.worktree, files: [], stats: { files: 0, additions: 0, deletions: 0 }, truncated: false, error: (e as Error).message });
        }
        return undefined;
      }
      case 'repo.add': {
        const r = await this.repos.add(msg.path);
        this.bus.feed('system', `Repo connected: ${r.name} (${r.branch})`);
        return { repoId: r.id };
      }
    }
  }

  async submitGoal(text: string, repoId?: string): Promise<Goal> {
    if (this.config.backend === 'observer') throw new ClientError('Observer mode: submit development tasks in the Codex chat.');
    const repo = repoId ? this.repos.get(repoId) : this.repos.defaultRepo();
    if (repoId && !repo) throw new ClientError(`no repo "${repoId}"`);
    if (!repo) throw new ClientError('no repo connected yet — add one with /repo add <path>');
    if (!this.backend) throw new ClientError('no backend running');
    const goal = this.createGoal(text, repo.id);
    await this.backend.submitGoal(goal);
    return goal;
  }

  routeUserMessage(to: string, text: string): { to: string; text: string } {
    let target = to;
    let body = text.trim();
    if (to === 'all') {
      const m = /^@([\w-]+)[\s,:]+([\s\S]+)$/.exec(body);
      if (m) {
        const id = this.resolveAgentId(m[1]!);
        if (!id) throw new ClientError(`no agent named "${m[1]}"`);
        target = id;
        body = m[2]!.trim();
      }
    } else {
      const id = this.resolveAgentId(to);
      if (!id) throw new ClientError(`no agent named "${to}"`);
      target = id;
    }
    return { to: target, text: body };
  }

  taskAction(taskId: string, action: 'reassign' | 'cancel' | 'retry' | 'prioritize', arg?: string): void {
    const t = this.tasks.require(taskId);
    switch (action) {
      case 'cancel':
        this.tasks.setStatus(t.id, 'cancelled', { force: true });
        for (const d of this.decisions.open().filter((d) => d.taskId === t.id)) this.decisions.cancel(d.id, 'task cancelled');
        this.bus.feed('task', `Task ${t.id} cancelled by ${userName()}: ${t.title}`, { agentId: 'user' });
        break;
      case 'retry':
        this.tasks.update(t.id, { ci: 'unknown', blockedReason: null });
        this.tasks.setStatus(t.id, 'todo', { force: true });
        this.bus.feed('task', `Task ${t.id} queued again: ${t.title}`, { agentId: 'user' });
        break;
      case 'prioritize': {
        const top = Math.max(0, ...this.tasks.list().map((x) => x.priority));
        const p = arg !== undefined && arg !== '' && Number.isFinite(Number(arg)) ? Math.trunc(Number(arg)) : top + 1;
        this.tasks.update(t.id, { priority: p });
        this.bus.feed('task', `Task ${t.id} priority -> ${p}`, { agentId: 'user' });
        break;
      }
      case 'reassign': {
        if (!arg) throw new ClientError('reassign needs an agent id');
        const id = this.resolveAgentId(arg);
        if (!id) throw new ClientError(`no agent named "${arg}"`);
        if (this.agent(id)?.role === 'lead') throw new ClientError('tasks are assigned to workers, not the lead');
        this.tasks.update(t.id, { assignee: id });
        if (t.status === 'doing') this.tasks.setStatus(t.id, 'todo', { force: true });
        this.bus.feed('task', `Task ${t.id} reassigned to ${this.nameOf(id)}`, { agentId: 'user' });
        break;
      }
    }
    this.backend?.onTaskAction(this.tasks.require(taskId), action, arg);
  }

  async agentAction(agentId: string, action: 'pause' | 'resume' | 'stop' | 'spawn', arg?: string): Promise<void> {
    const id = this.resolveAgentId(agentId);
    if (!id) throw new ClientError(`no agent named "${agentId}"`);
    if (action === 'pause') this.setAgent(id, { paused: true });
    if (action === 'resume') this.setAgent(id, { paused: false });
    if (action === 'spawn' && arg && !this.tasks.get(arg)) throw new ClientError(`no task "${arg}"`);
    if (action === 'spawn' && arg && this.agent(id)?.role === 'lead') throw new ClientError('tasks are assigned to workers, not the lead');
    if (action === 'spawn') this.setAgent(id, { active: true, paused: false });
    this.bus.feed('system', `${this.nameOf(id)}: ${action}${arg ? ` ${arg}` : ''}`, { agentId: 'user' });
    await this.backend?.onAgentAction(id, action, arg);
    // spawn @wren t3: on shift, and t3 is hers
    if (action === 'spawn' && arg) this.taskAction(arg, 'reassign', id);
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  async start(backend: Backend): Promise<void> {
    this.backend = backend;
    for (const p of this.config.repos) {
      try {
        const r = await this.repos.add(p);
        this.log.info(`repo ${r.id}: ${r.path} (${r.branch})`);
      } catch (e) {
        this.log.error(`could not add repo ${p}: ${(e as Error).message}`);
      }
    }
    for (const r of this.repos.list()) {
      if (!fs.existsSync(r.path)) {
        this.log.warn(`repo ${r.id} path is gone: ${r.path}`);
        continue;
      }
      await this.repos.refresh(r.id).catch((e) => this.log.warn(`refresh ${r.id}: ${(e as Error).message}`));
    }
    this.repos.startPolling(this.config.repoPollMs);
    await backend.start();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.repos.stopPolling();
    try {
      await this.backend?.stop();
    } catch (e) {
      this.log.error(`backend stop: ${(e as Error).message}`);
    }
    this.flushLogs();
    this.notifier.dispose();
    this.store.close();
  }
}
