import { ClientError, type Foreman } from '../foreman.js';
import { LegacyObserverBackend } from './legacy-observer.js';
import { AgentRuntime } from '../agent-runtime.js';
import { TeamStudio } from '../studio.js';
import type { AdapterFactory } from '../agent-adapters.js';
import type { ChatControl } from '../codex-desktop.js';
import type { ObserverUpdate } from '../protocol.js';
import { readJson, writeJsonAtomic } from '../util/fsx.js';
import path from 'node:path';
export { REST_DELAY_MS } from './legacy-observer.js';

/** New teams use per-agent runtimes; migrated pairs retain their queue until the role queue is ready. */
export class ObserverBackend extends LegacyObserverBackend {
  private runtime?: AgentRuntime;
  private teamStudio?: TeamStudio;
  private enablingQueue = false;
  constructor(fm: Foreman, chatFile?: string, private factory?: AdapterFactory) { super(fm, chatFile); }
  override async start() {
    if (!this.fm.team || this.fm.migratedPair) return super.start();
    this.runtime = new AgentRuntime(this.fm, this.factory);
    this.teamStudio = new TeamStudio(this.fm, this.runtime);
    this.runtime.start();
    this.teamStudio.start();
    this.fm.setStatus({ auth: 'unknown', message: 'Состояние подключения показано отдельно у каждого агента.' });
  }
  override onTeamChanged() { if (this.fm.migratedPair) super.onTeamChanged(); else { this.runtime?.reconcile(); this.teamStudio?.messaging.provision(); } }
  assertAgentIdle(id: string) { this.teamStudio?.queue.assertIdle(id); return this.runtime?.assertIdle(id); }
  override onObserverUpdate(update: ObserverUpdate) {
    if (!this.fm.team || this.fm.migratedPair) return super.onObserverUpdate(update);
    try { return this.runtime!.observe(update); } catch (e) { throw new ClientError((e as Error).message); }
  }
  override async onChatMessage(text: string, agentId?: string, reply = false) {
    if (!this.fm.team || this.fm.migratedPair) return super.onChatMessage(text, agentId, reply);
    if (!agentId) throw new ClientError('Выбери агента по ID.');
    try { return await this.runtime!.send(agentId, text); } catch (e) { throw new ClientError((e as Error).message); }
  }
  override async onChatControl(action: ChatControl, agentId?: string) {
    if (!this.fm.team || this.fm.migratedPair) return super.onChatControl(action, agentId);
    if (!agentId) throw new ClientError('Выбери агента по ID.');
    try { return await this.teamStudio!.queue.control(agentId, action); } catch (e) { throw new ClientError((e as Error).message); }
  }
  override async onStudioAction(action: string, payload: Record<string, unknown>) {
    if (this.enablingQueue) throw new ClientError('Переход очереди ещё выполняется.');
    if (action === 'queue.enable' && this.fm.migratedPair) {
      const legacy: any = this.fm.store.data.backend.studio;
      if (legacy.active || legacy.dialog?.pending || legacy.items?.some((i: any) => ['coding', 'review'].includes(i.stage)))
        throw new ClientError('Заверши текущую работу и незаконченный разговор перед переходом на новую очередь.');
      if (legacy.personalPaused?.length || Object.keys(legacy.suspended ?? {}).length || legacy.items?.some((i: any) => i.stage === 'question'))
        throw new ClientError('Разреши вопросы старой очереди и сними личные паузы перед переходом. История и места сохраняются.');
      this.assertProfileChange(false);
      this.enablingQueue = true;
      try {
        await super.stop();
        const root = this.fm.config.dataDir;
        // Preserve the exact cursor; activation never imports a fresh conversation.
        const cursor = readJson(path.join(root, 'codex-chat-state.json'));
        if (cursor) writeJsonAtomic(path.join(root, 'agents/marlow/codex-chat-state.json'), cursor);
        this.runtime = new AgentRuntime(this.fm, this.factory);
        this.teamStudio = new TeamStudio(this.fm, this.runtime);
        this.teamStudio.queue.importLegacy(legacy);
        this.runtime.start(); this.teamStudio.start();
        return this.teamStudio.action('get', {});
      } finally { this.enablingQueue = false; }
    }
    if (!this.fm.team || this.fm.migratedPair) {
      const result = await super.onStudioAction(action, payload);
      return this.fm.migratedPair ? { ...result, canEnableRoleQueue: true } : result;
    }
    try { return await this.teamStudio!.action(action, payload); } catch (e) { throw new ClientError((e as Error).message); }
  }
  override onDecisionSettled(d: import('../protocol.js').Decision) {
    if (this.teamStudio) { this.teamStudio.queue.onDecision(d); this.teamStudio.messaging.onDecision(d); }
    else super.onDecisionSettled(d);
  }
  override async stop() { if (this.teamStudio) { await this.teamStudio.stop(); await this.runtime?.stop(); } else await super.stop(); }
}
