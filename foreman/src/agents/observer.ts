import { ClientError, type Foreman } from '../foreman.js';
import { LegacyObserverBackend } from './legacy-observer.js';
import { AgentRuntime } from '../agent-runtime.js';
import { TeamStudio } from '../studio.js';
import type { AdapterFactory } from '../agent-adapters.js';
import type { ChatControl } from '../codex-desktop.js';
import type { ObserverUpdate } from '../protocol.js';
export { REST_DELAY_MS } from './legacy-observer.js';

/** Dynamic profiles never instantiate the legacy two-person queue or global chat binding. */
export class ObserverBackend extends LegacyObserverBackend {
  private runtime?: AgentRuntime;
  private teamStudio?: TeamStudio;
  constructor(fm: Foreman, chatFile?: string, private factory?: AdapterFactory) { super(fm, chatFile); }
  override async start() {
    if (!this.fm.team) return super.start();
    this.runtime = new AgentRuntime(this.fm, this.factory);
    this.teamStudio = new TeamStudio(this.fm, this.runtime);
    this.runtime.start();
    this.fm.setStatus({ auth: 'unknown', message: 'Состояние подключения показано отдельно у каждого агента.' });
  }
  onTeamChanged() { this.runtime?.reconcile(); }
  assertAgentIdle(id: string) { this.runtime?.assertIdle(id); }
  override onObserverUpdate(update: ObserverUpdate) {
    if (!this.fm.team) return super.onObserverUpdate(update);
    try { return this.runtime!.observe(update); } catch (e) { throw new ClientError((e as Error).message); }
  }
  override async onChatMessage(text: string, agentId?: string, reply = false) {
    if (!this.fm.team) return super.onChatMessage(text, agentId, reply);
    if (!agentId) throw new ClientError('Выбери агента по ID.');
    try { return await this.runtime!.send(agentId, text); } catch (e) { throw new ClientError((e as Error).message); }
  }
  override async onChatControl(action: ChatControl, agentId?: string) {
    if (!this.fm.team) return super.onChatControl(action, agentId);
    if (!agentId) throw new ClientError('Выбери агента по ID.');
    try { return await this.runtime!.control(agentId, action); } catch (e) { throw new ClientError((e as Error).message); }
  }
  override async onStudioAction(action: string, payload: Record<string, unknown>) {
    if (!this.fm.team) return super.onStudioAction(action, payload);
    try { return await this.teamStudio!.action(action, payload); } catch (e) { throw new ClientError((e as Error).message); }
  }
  override async stop() { if (this.fm.team) await this.runtime?.stop(); else await super.stop(); }
}
