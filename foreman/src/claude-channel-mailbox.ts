import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from './util/fsx.js';

const uuid = z.string().uuid();
export const ChannelIdentity = z.object({ agentId: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  sessionId: uuid, profile: z.string().refine(path.isAbsolute) }).strict();
export type ChannelIdentity = z.infer<typeof ChannelIdentity>;
export const ChannelOwner = ChannelIdentity.extend({ token: uuid, generation: uuid, pid: z.number().int().positive(),
  childPid: z.number().int().positive().optional(), updated: z.number(),
  phase: z.enum(['starting', 'running', 'stopped', 'error']), error: z.string().max(2000).optional() }).strict();
export type ChannelOwner = z.infer<typeof ChannelOwner>;
export const ChannelRequest = z.object({ id: uuid, token: uuid, generation: uuid, sessionId: uuid,
  text: z.string().min(1).max(110000), display: z.string().min(1).max(96000), created: z.number() }).strict();
export type ChannelRequest = z.infer<typeof ChannelRequest>;
export const ChannelReply = z.object({ id: uuid, text: z.string().min(1).max(100000) }).strict();
export const ChannelControl = z.object({ id: uuid, token: uuid, generation: uuid, action: z.enum(['stop', 'start']) }).strict();
export const ChannelReceipt = z.object({ id: uuid, ok: z.boolean(), error: z.string().optional() }).strict();
const Ready = z.object({ token: uuid, generation: uuid, updated: z.number() }).strict();

/** Local files only. The launcher owns lifecycle; MCP owns claims/replies; bridge owns requests.
 * Claims are fsynced before notify: ambiguous deliveries are never replayed automatically. */
export class ChannelMailbox {
  readonly root: string;
  constructor(workspace: string) { this.root = path.join(workspace, '.agentcraft-channel'); }
  file(group: string, id: string) { uuid.parse(id); return path.join(this.root, group, `${id}.json`); }
  read<T>(file: string, schema: z.ZodType<T>): T | undefined {
    if (!fs.existsSync(file)) return undefined;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1200000) throw new Error('Повреждён файл канала Claude.');
    return schema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  owner() { return this.read(path.join(this.root, 'owner.json'), ChannelOwner); }
  writeOwner(owner: ChannelOwner) { writeJsonAtomic(path.join(this.root, 'owner.json'), ChannelOwner.parse(owner)); }
  matches(owner: ChannelOwner, identity: ChannelIdentity) {
    return owner.agentId === identity.agentId && owner.sessionId === identity.sessionId &&
      fs.realpathSync(owner.profile) === fs.realpathSync(identity.profile);
  }
  ready(owner: ChannelOwner, now = Date.now()) {
    const r = this.read(path.join(this.root, 'ready.json'), Ready);
    return owner.phase === 'running' && now - owner.updated < 10000 && !!r &&
      r.token === owner.token && r.generation === owner.generation && now - r.updated < 10000;
  }
  heartbeat(owner: ChannelOwner) { writeJsonAtomic(path.join(this.root, 'ready.json'),
    { token: owner.token, generation: owner.generation, updated: Date.now() }); }
  list(group: 'requests' | 'controls') {
    const dir = path.join(this.root, group);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => uuid.safeParse(f.replace(/\.json$/, '')).success && f.endsWith('.json'))
      .map(f => f.slice(0, -5)) : [];
  }
  request(id: string) { return this.read(this.file('requests', id), ChannelRequest); }
  reply(id: string) { return this.read(this.file('replies', id), ChannelReply); }
  enqueue(request: ChannelRequest) {
    const value = ChannelRequest.parse(request), old = this.request(value.id);
    if (old && JSON.stringify(old) !== JSON.stringify(value)) throw new Error('ID сообщения уже использован с другим содержимым.');
    if (!old) writeJsonAtomic(this.file('requests', value.id), value);
  }
  claim(id: string) {
    const file = this.file('claims', id); fs.mkdirSync(path.dirname(file), { recursive: true });
    let fd: number;
    try { fd = fs.openSync(file, 'wx'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
    try { fs.writeSync(fd, JSON.stringify({ id, claimed: Date.now() })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return true;
  }
  claimed(id: string) { return fs.existsSync(this.file('claims', id)); }
  acceptReply(id: string, text: string, owner: ChannelOwner) {
    const reply = ChannelReply.parse({ id, text }), request = this.request(id);
    if (!request || !this.claimed(id) || request.token !== owner.token || request.generation !== owner.generation || request.sessionId !== owner.sessionId)
      throw new Error('Ответ не относится к активному сообщению этого канала.');
    if (fs.existsSync(this.file('cancelled', id))) throw new Error('Сообщение остановлено.');
    const old = this.reply(id);
    if (old && old.text !== text) throw new Error('Ответ уже сохранён; повтор с другим текстом отклонён.');
    if (!old) writeJsonAtomic(this.file('replies', id), reply);
    return { accepted: true, duplicate: !!old };
  }
  cancel(id: string) { writeJsonAtomic(this.file('cancelled', id), { id }); }
  cancelled(id: string) { return fs.existsSync(this.file('cancelled', id)); }
}
