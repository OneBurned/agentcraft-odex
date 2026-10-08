import { ClientError, type Foreman } from '../foreman.js';
import { LegacyObserverBackend } from './legacy-observer.js';
import { AgentRuntime } from '../agent-runtime.js';
import { TeamStudio } from '../studio.js';
import type { AdapterFactory } from '../agent-adapters.js';
import type { ChatControl } from '../codex-desktop.js';
import type { ObserverUpdate } from '../protocol.js';
export { REST_DELAY_MS } from './legacy-observer.js';

/** New teams use per-agent runtimes; migrated pairs retain their queue until the role queue is ready. */
export class ObserverBackend extends LegacyObserverBackend {
  private runtime?: AgentRuntime;
  private teamStudio?: TeamStudio;
  constructor(fm: Foreman, chatFile?: string, private factory?: AdapterFactory) { super(fm, chatFile); }
  override async start() {
    if (!this.fm.team || this.fm.migratedPair) return super.start();
    this.runtime = new AgentRuntime(this.fm, this.factory);
    this.teamStudio = new TeamStudio(this.fm, this.runtime);
    this.runtime.start();
    this.fm.setStatus({ auth: 'unknown', message: 'Состояние подключения показано отдельно у каждого агента.' });
  }
  override onTeamChanged() { if (this.fm.migratedPair) super.onTeamChanged(); else this.runtime?.reconcile(); }
  assertAgentIdle(id: string) { return this.runtime?.assertIdle(id); }
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
    try { return await this.runtime!.control(agentId, action); } catch (e) { throw new ClientError((e as Error).message); }
  }
  override async onStudioAction(action: string, payload: Record<string, unknown>) {
    if (!this.fm.team || this.fm.migratedPair) return super.onStudioAction(action, payload);
    try { return await this.teamStudio!.action(action, payload); } catch (e) { throw new ClientError((e as Error).message); }
  }
  override async stop() { if (this.fm.team && !this.fm.migratedPair) await this.runtime?.stop(); else await super.stop(); }
}
