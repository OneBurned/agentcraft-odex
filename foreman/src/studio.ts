import { z } from 'zod';
import type { Foreman } from './foreman.js';
import { TeamId } from './team.js';
import { AgentRuntime } from './agent-runtime.js';
// Existing profiles retain the old queue until explicit A4 migration.
export { Studio } from './legacy-studio.js';
const selected = z.object({ id: TeamId });

export class TeamStudio {
  constructor(private fm: Foreman, readonly runtime: AgentRuntime) {}
  async action(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const idle = (id: string) => this.fm.assertTeamAgentIdle(id);
    if (action === 'get') return { team: this.fm.team!.snapshot(), profiles: this.fm.agents(), mode: 'planning', items: [],
      notice: 'Подключения адресуются по ID агента. Автоматическая очередь команды — отдельный этап.' };
    if (action === 'connection.get') return this.runtime.view(selected.parse(payload).id);
    let team;
    if (action === 'connection.bind') team = this.runtime.connections.bind(payload, idle);
    else if (action === 'connection.unbind' || action === 'connection.importCodex') {
      const { id, revision } = selected.extend({ revision: z.number().int().nonnegative() }).strict().parse(payload);
      team = action === 'connection.unbind' ? this.runtime.connections.unbind(id, revision, idle)
        : this.runtime.connections.importCodex(id, revision, idle);
    } else if (action === 'connection.send') {
      const { id, text, purpose } = selected.extend({ text: z.string().trim().min(1).max(12000), purpose: z.enum(['message', 'task']).default('message') }).strict().parse(payload);
      return this.runtime.send(id, text, purpose);
    } else if (action === 'connection.control') {
      const { id, control } = selected.extend({ control: z.enum(['pause', 'resume', 'stop']) }).strict().parse(payload);
      return this.runtime.control(id, control);
    } else throw new Error('Действие ещё не доступно для настраиваемой команды. Используй team.* или connection.*.');
    this.fm.syncTeam();
    return { team };
  }
}
