import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { MessagingBinding, MessageInput } from './agent-messaging.js';
import { sameDirectory } from './claude-planning.js';
import { conversation } from './claude-conversation.js';

export async function agentMessageCall(directory: string, name: string, args: unknown): Promise<Record<string, unknown>> {
  if (!['agent_message', 'agent_messages'].includes(name)) throw new Error('Неизвестный инструмент переписки.');
  const input = name === 'agent_message' ? MessageInput.parse(args) : z.object({ offset: z.number().int().nonnegative().default(0) }).strict().parse(args);
  const binding = MessagingBinding.parse(JSON.parse(fs.readFileSync(path.join(directory, 'messaging.json'), 'utf8')));
  if (!binding.workspace || !sameDirectory(directory, binding.workspace) || conversation(directory)?.sessionId !== binding.sessionId)
    throw new Error('Переписка привязана к другому рабочему пространству или сессии.');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${binding.port}/messenger`, { handshakeTimeout: 3000, maxPayload: 1024 * 1024 });
    const id = randomUUID(); let sent = false;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      clearTimeout(timer); ws.removeAllListeners(); ws.on('error', () => {}); ws.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error('Мост не ответил. Повтори с тем же requestId или проверь agent_messages.')), 15000);
    ws.once('open', () => ws.send(JSON.stringify({ v: 2, type: 'hello', protocol: 2, modVersion: 'agent-messaging', client: 'studio-messenger' })));
    ws.on('error', () => finish(new Error('Нет связи с мостом AgentCraft.')));
    ws.on('close', () => finish(new Error('Связь закрыта. Проверь квитанцию перед повтором.')));
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'snapshot' && !sent) {
        sent = true; ws.send(JSON.stringify({ v: 2, id, type: 'studio.action', action: name === 'agent_message' ? 'message.send' : 'message.list',
          payload: { ...input, token: binding.token, agentId: binding.agentId } }));
      }
      if (m.type === 'ack' && m.re === id) finish(m.ok ? undefined : new Error(m.error || 'Переписка отклонена.'), m.result);
    });
  });
}
