import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { WorkspaceConfig } from './claude-workspace.js';

export const DraftInput = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  project: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(3000),
  expected: z.string().trim().min(1).max(1500),
  deps: z.array(z.string().regex(/^t[0-9]+$/)).max(50).default([]),
  priority: z.number().int().min(0).max(100).default(0),
}).strict();
export const PlanningBinding = z.object({ version: z.literal(1), workspace: z.string().refine(path.isAbsolute),
  profile: z.string().refine(path.isAbsolute), port: z.number().int().min(1).max(65535), token: z.string().uuid() }).strict();
export const sameDirectory = (a: string, b: string) => {
  const real = (p: string) => { const value = fs.realpathSync(p); return process.platform === 'win32' ? value.toLowerCase() : value; };
  return real(a) === real(b);
};

/** Operator-created binding, never an endpoint/path supplied by the model. */
export function planningBinding(directory: string) {
  try { return PlanningBinding.parse(JSON.parse(fs.readFileSync(path.join(directory, 'planning.json'), 'utf8'))); }
  catch { throw new Error('Планирование Клавы не подключено. Нужна настройка моста оператором.'); }
}
export function authorizePlanning(profile: string, port: number, token: unknown) {
  const binding = planningBinding(profile);
  if (typeof token !== 'string' || Buffer.byteLength(token) !== Buffer.byteLength(binding.token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(binding.token)) || binding.port !== port || !sameDirectory(binding.profile, profile))
    throw new Error('Доступ к планированию отклонён.');
  const pointer = JSON.parse(fs.readFileSync(path.join(profile, 'claude-workspace.json'), 'utf8'));
  if (!sameDirectory(pointer.directory, binding.workspace)) throw new Error('Подключено другое рабочее пространство.');
  const peer = planningBinding(binding.workspace);
  if (peer.token !== binding.token || peer.port !== port || !sameDirectory(peer.profile, profile) || !sameDirectory(peer.workspace, binding.workspace))
    throw new Error('Привязка планирования изменилась.');
  return WorkspaceConfig.parse(JSON.parse(fs.readFileSync(path.join(binding.workspace, 'access.json'), 'utf8')));
}

export async function planningCall(directory: string, name: string, args: unknown): Promise<Record<string, unknown>> {
  // Validate before connecting; no generic action or arbitrary transport arguments.
  const payload = name === 'planning_create' ? DraftInput.parse(args) : z.object({ offset: z.number().int().min(0).default(0) }).strict().parse(args);
  const binding = planningBinding(directory);
  if (!sameDirectory(directory, binding.workspace)) throw new Error('Рабочее пространство планирования не совпадает.');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${binding.port}`, { handshakeTimeout: 3000, maxPayload: 8 * 1024 * 1024 });
    const id = randomUUID(); let sent = false;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      clearTimeout(timer); ws.removeAllListeners(); ws.on('error', () => {}); ws.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error('Мост не ответил. Повтори создание с тем же requestId: дубликат не появится.')), 15000);
    ws.once('open', () => ws.send(JSON.stringify({ v: 1, type: 'hello', protocol: 1, modVersion: 'klava-planning', client: 'klava' })));
    ws.on('error', () => finish(new Error('Нет связи с мостом AgentCraft. Запусти подключённый профиль.')));
    ws.on('close', () => finish(new Error('Связь с мостом закрыта. Повтори запрос с тем же requestId.')));
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'snapshot' && !sent) {
        sent = true; ws.send(JSON.stringify({ v: 1, id, type: 'studio.action', action: name === 'planning_create' ? 'draft.create' : 'draft.list', payload: { ...payload, token: binding.token } }));
      }
      if (m.type === 'ack' && m.re === id) finish(m.ok ? undefined : new Error(m.error || 'Черновик не создан.'), m.result);
    });
  });
}
