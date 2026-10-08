import { z } from 'zod';
import type { Foreman } from './foreman.js';
import { TeamId } from './team.js';
import { AgentRuntime } from './agent-runtime.js';
import { RoleQueue } from './role-queue.js';
import { loadCast } from './cast.js';
// Existing profiles retain the old queue until explicit A4 migration.
export { Studio } from './legacy-studio.js';
const selected = z.object({ id: TeamId });

export class TeamStudio {
  readonly queue: RoleQueue;
  constructor(private fm: Foreman, readonly runtime: AgentRuntime) { this.queue = new RoleQueue(fm, runtime); }
  start() { this.queue.start(); }
  stop() { return this.queue.stop(); }
  async action(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const idle = (id: string) => this.fm.assertTeamAgentIdle(id);
    if (action === 'persona.get' || action === 'persona.save') {
      if (!this.fm.personas) throw new Error('Редактор характеров доступен только в режиме наблюдения.');
      return action === 'persona.get' ? this.fm.personas.edit(payload.agentId) : this.fm.personas.saveEdit(payload);
    }
    if (action === 'get') return { ...this.queue.view(), team: this.fm.team!.snapshot(), profiles: this.fm.agents(), repos: this.fm.repos.list(), notes: this.fm.memory.list(),
      skins: loadCast(this.fm.config.projectRoot).cast.map(a => a.id) };
    if (action === 'settings') {
      const p = z.object({ autoSelect: z.boolean(), revision: z.number().int().nonnegative() }).strict().parse(payload);
      this.fm.team!.setAssignment(p.autoSelect, p.revision); return this.action('get', {});
    }
    if (action === 'connection.get') return this.runtime.view(selected.parse(payload).id);
    if (action === 'connection.check') return this.runtime.check(selected.parse(payload).id);
    let team;
    if (action === 'connection.bind') team = this.runtime.connections.bind(payload, idle);
    else if (action === 'connection.unbind' || action === 'connection.importCodex') {
      const { id, revision } = selected.extend({ revision: z.number().int().nonnegative() }).strict().parse(payload);
      team = action === 'connection.unbind' ? this.runtime.connections.unbind(id, revision, idle)
        : this.runtime.connections.importCodex(id, revision, idle);
    } else if (action === 'connection.send') {
      const { id, text, purpose } = selected.extend({ text: z.string().trim().min(1).max(12000), purpose: z.enum(['message', 'task']).default('message') }).strict().parse(payload);
      if (purpose === 'task') throw new Error('Задачи запускаются через согласованный план общей очереди. Для диалога используй purpose=message.');
      return this.runtime.send(id, text, purpose);
    } else if (action === 'connection.control') {
      const { id, control } = selected.extend({ control: z.enum(['pause', 'resume', 'stop']) }).strict().parse(payload);
      return this.queue.control(id, control);
    } else {
      const result = await this.queue.action(action === 'review' ? 'review.report' : action, payload);
      return ['report', 'review', 'review.report'].includes(action) ? result : this.action('get', {});
    }
    this.fm.syncTeam();
    return { team };
  }
}
