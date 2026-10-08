import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeJsonAtomic } from './util/fsx.js';

export const TeamId = z.string().regex(/^[a-z0-9_-]{1,64}$/);
export const Provider = z.enum(['codex', 'claude']);
export const WorkRole = z.enum(['planner', 'developer', 'reviewer']);
const appearance = z.object({ skin: z.string().regex(/^[a-z0-9_-]{1,64}$/), color: z.string().regex(/^#[a-fA-F0-9]{6}$/), slim: z.boolean() }).strict();
const editable = z.object({ name: z.string().trim().min(1).max(28), provider: Provider,
  roles: z.array(WorkRole).min(1).refine(v => new Set(v).size === v.length, 'Roles must be unique'),
  enabled: z.boolean(), visible: z.boolean(), appearance }).strict();
export const TeamAgent = editable.extend({ id: TeamId, archived: z.boolean(), personaRef: z.string(),
  connectionRef: z.string().nullable(), memoryDir: z.string(), instructionsDir: z.string() }).strict();
export type TeamAgent = z.infer<typeof TeamAgent>;
const Team = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(),
  assignment: z.object({ autoSelect: z.boolean() }).strict(), agents: z.array(TeamAgent) }).strict()
  .refine(t => new Set(t.agents.map(a => a.id)).size === t.agents.length, 'Duplicate agent id')
  .refine(t => t.agents.every(a => !a.archived || (!a.enabled && !a.visible)), 'Archived agents must be disabled and hidden');
type TeamData = z.infer<typeof Team>;
export class TeamError extends Error {}

/** Profile-local references must not traverse a junction, including an existing parent. */
function rejectLink(file: string) {
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new TeamError('Team paths cannot traverse symbolic links or junctions'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
export function validateReference(root: string, ref: string) {
  if (!ref || ref.includes('\\') || ref.includes(':') || ref.startsWith('/') || ref.split('/').some(p => !p || p === '.' || p === '..'))
    throw new TeamError('Invalid team path: use a relative path inside the profile');
  let current = root;
  for (const part of ref.split('/')) {
    current = path.join(current, part);
    rejectLink(current);
  }
}

/** Synchronous compare-and-write under the single profile owner; no await between validation and commit. */
export class TeamRegistry {
  private data: TeamData;
  readonly file: string;
  constructor(private root: string) {
    this.file = path.join(root, 'team.json');
    rejectLink(this.file);
    if (fs.existsSync(this.file)) this.data = this.read();
    else {
      this.data = { version: 1, revision: 0, assignment: { autoSelect: false }, agents: [] };
      writeJsonAtomic(this.file, this.data);
    }
  }
  private read(): TeamData {
    try {
      rejectLink(this.file);
      const data = Team.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      for (const a of data.agents) for (const ref of [a.personaRef, a.connectionRef, a.memoryDir, a.instructionsDir]) if (ref !== null) validateReference(this.root, ref);
      return data;
    } catch (e) { throw new TeamError(`Cannot read team.json; original file preserved: ${(e as Error).message}`); }
  }
  snapshot(): TeamData { return structuredClone(this.data); }
  assertUnchanged(): void {
    if (!isDeepStrictEqual(this.read(), this.data)) throw new TeamError('team.json changed outside the bridge: restart before editing');
  }
  get(id: string): TeamAgent | undefined { return this.snapshot().agents.find(a => a.id === id); }
  /** Connection records are committed first; this atomic reference is the activation point. */
  connect(id: string, ref: string | null, revision: number, assertIdle: (id: string) => void): TeamData {
    if (!isDeepStrictEqual(this.read(), this.data)) throw new TeamError('team.json changed outside the bridge: restart before editing');
    if (revision !== this.data.revision) throw new TeamError('Team revision conflict: reload team.get');
    const next = this.snapshot();
    const agent = next.agents.find(a => a.id === id && !a.archived);
    if (!agent) throw new TeamError('Unknown or archived agent');
    assertIdle(id);
    if (ref) validateReference(this.root, ref);
    agent.connectionRef = ref; next.revision++;
    writeJsonAtomic(this.file, next); this.data = next;
    return this.snapshot();
  }
  change(action: string, raw: Record<string, unknown>, assertIdle: (id: string) => void): TeamData {
    let request;
    try { request = z.object({ revision: z.number().int().nonnegative(), id: TeamId.optional(),
      agent: editable.optional(), patch: editable.partial().optional(), visible: z.boolean().optional() }).strict().parse(raw); } catch (e) { throw new TeamError(`Invalid team operation: ${(e as Error).message}`); }
    const disk = this.read();
    if (!isDeepStrictEqual(disk, this.data)) throw new TeamError('team.json changed outside the bridge: restart the bridge before editing');
    if (request.revision !== this.data.revision)
      throw new TeamError('Team revision conflict: reload team.get and retry your changes');
    const next = this.snapshot();
    if (action === 'create') {
      if (!request.agent) throw new TeamError('Missing agent');
      const input = request.agent;
      let id: string;
      do { id = `agent_${randomUUID().replaceAll('-', '')}`; } while (next.agents.some(a => a.id === id));
      next.agents.push({ ...input, id, archived: false, connectionRef: null,
        personaRef: `agents/${id}/persona.json`, memoryDir: `agents/${id}/memory`, instructionsDir: `agents/${id}/instructions` });
    } else {
      const a = next.agents.find(a => a.id === request.id);
      if (!a) throw new TeamError('Unknown agent');
      assertIdle(a.id);
      if (action === 'restore') {
        if (!a.archived) throw new TeamError('Agent is not archived');
        a.archived = false; a.enabled = false; a.visible = request.visible ?? true;
      } else {
        if (a.archived) throw new TeamError('Restore the archived agent before editing');
        if (action === 'update') {
          if (!request.patch) throw new TeamError('Missing patch');
          if (request.patch.provider && request.patch.provider !== a.provider) a.connectionRef = null;
          Object.assign(a, request.patch);
        } else if (action === 'disable') a.enabled = false;
        else if (action === 'archive') { a.archived = true; a.enabled = false; a.visible = false; }
        else throw new TeamError('Unknown team operation');
      }
    }
    next.revision++;
    Team.parse(next);
    for (const a of next.agents) for (const ref of [a.personaRef, a.connectionRef, a.memoryDir, a.instructionsDir]) if (ref !== null) validateReference(this.root, ref);
    writeJsonAtomic(this.file, next);
    this.data = next;
    return this.snapshot();
  }
}
