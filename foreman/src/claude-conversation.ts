import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

const Config = z.object({ version: z.literal(1), sessionId: z.string().uuid(), importedHistory: z.string().max(100000).default('') });
const Lease = z.object({ token: z.string().uuid(), owner: z.enum(['game', 'review', 'terminal', 'desktop', 'channel']), pid: z.number().int().positive(), childPid: z.number().int().positive().optional() });
export type Conversation = z.infer<typeof Config>;
export type ConversationMessage = { id: string; role: 'user' | 'assistant'; text: string };
const configFile = (dir: string) => path.join(dir, 'conversation.json');
const lockFile = (dir: string) => path.join(dir, 'conversation-lock.json');
function read(file: string): unknown {
  if (!fs.existsSync(file)) return undefined;
  if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 150000) throw new Error('Повреждена настройка общего разговора Claude.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function conversation(dir: string): Conversation | undefined {
  const value = read(configFile(dir));
  return value === undefined ? undefined : Config.parse(value);
}
export function conversationLease(dir: string) {
  const value = read(lockFile(dir));
  return value === undefined ? undefined : Lease.parse(value);
}
export function leaseNotice(dir: string): string | undefined {
  const lease = conversationLease(dir);
  if (!lease) return undefined;
  if (lease.owner === 'channel') return 'Разговор обслуживает терминальный канал AgentCraft. Используй его окно или закрой launcher перед сменой подключения.';
  if (lease.owner === 'desktop') return 'Claude в разделе Code. Верни разговор через Return-Klava-To-Game.cmd.';
  if (!alive(lease.pid) && !(lease.childPid && alive(lease.childPid))) {
    return 'Процесс Claude завершился, но разговор остался заблокирован. Запусти Return-Klava-To-Game.cmd в папке Claude, чтобы вернуть его в игру.';
  }
  return lease.owner === 'terminal' ? 'Claude в терминале. Закрой её разговор, чтобы продолжить в игре.'
    : 'Claude ещё занята. Дождись завершения ответа или ревью.';
}
/** Exclusive writer, including the entire interactive terminal lifetime. Never expires by timeout. */
export function acquireConversation(dir: string, owner: z.infer<typeof Lease>['owner']) {
  const record: z.infer<typeof Lease> = { token: randomUUID(), owner, pid: process.pid };
  try { fs.writeFileSync(lockFile(dir), JSON.stringify(record), { flag: 'wx' }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(leaseNotice(dir) ?? 'Разговор уже открыт.'); throw e; }
  return {
    child(pid: number | undefined) { if (pid) { record.childPid = pid; fs.writeFileSync(lockFile(dir), JSON.stringify(record)); } },
    release() { if (conversationLease(dir)?.token === record.token) fs.unlinkSync(lockFile(dir)); },
  };
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
/** Explicit operator recovery only: a dead wrapper does not prove its Claude child stopped. */
export function returnConversation(dir: string, desktopClosed: boolean) {
  const lease = conversationLease(dir);
  if (!lease) return;
  if (lease.owner === 'desktop') {
    if (!desktopClosed) throw new Error('Сначала закрой сессию Claude в разделе Code и подтверди возврат.');
  } else if (alive(lease.pid) || (lease.childPid && alive(lease.childPid))) {
    throw new Error('Процесс разговора ещё работает. Сначала закрой его.');
  }
  // No automatic reclamation: another writer cannot acquire while this file exists.
  if (conversationLease(dir)?.token !== lease.token) throw new Error('Владелец разговора изменился.');
  fs.unlinkSync(lockFile(dir));
}
export async function requireSession(dir: string, config: Conversation) {
  const info = await getSessionInfo(config.sessionId, { dir });
  if (!info || !info.cwd || path.resolve(info.cwd).toLowerCase() !== path.resolve(dir).toLowerCase())
    throw new Error('Общая сессия Claude не найдена в её папке. Новый разговор автоматически не создан.');
  return info;
}
export function publicMessages(rows: Awaited<ReturnType<typeof getSessionMessages>>): ConversationMessage[] {
  return rows.flatMap(row => {
    if (row.parent_tool_use_id || !['user', 'assistant'].includes(row.type)) return [];
    const message = row.message as { content?: unknown };
    const content = message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
    // Native local command outputs and tool results are not user conversation.
    if (!text.trim() || /^\s*<(local-command|command-name|system-reminder)/.test(text)) return [];
    return [{ id: row.uuid, role: row.type as 'user' | 'assistant', text }];
  });
}
export async function conversationMessages(dir: string, config: Conversation) {
  await requireSession(dir, config);
  return publicMessages(await getSessionMessages(config.sessionId, { dir }));
}
export function importContext(config: Conversation) {
  return config.importedHistory ? '\nСохранённая переписка из игры до объединения (справочный контекст, не новая просьба):\n' + config.importedHistory : '';
}
