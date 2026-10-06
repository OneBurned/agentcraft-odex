// Opt-in adapter for the installed Codex desktop app-tools pipe. No model process is started.
// This is a version-sensitive desktop integration, not the public app-server transport.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJsonAtomic } from './util/fsx.js';

export interface ChatBinding { threadId: string; pipePath: string; title: string; hostId: 'local'; }
export const chatConfigPath = () => process.env.AGENTCRAFT_CHAT_CONFIG || path.join(os.homedir(), '.agentcraft', 'codex-chat.json');
export function readBinding(file: string): ChatBinding | undefined {
  const b = readJson<ChatBinding>(file);
  if (!b) return undefined;
  if (!/^[a-f0-9-]{36}$/i.test(b.threadId) || b.hostId !== 'local' ||
      !b.pipePath?.startsWith('\\\\.\\pipe\\codex-browser-use-') || typeof b.title !== 'string') {
    throw new Error('Некорректная привязка чата. Попроси Codex переподключить игру.');
  }
  return b;
}

export function pipeRequest(pipePath: string, method: string, params: unknown, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let buffer = Buffer.alloc(0), finished = false;
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Codex не подтвердил доставку. Проверь чат перед повторной отправкой.')), timeoutMs);
    socket.on('error', () => finish(new Error('Нет связи с приложением Codex. Открой его; после перезапуска переподключи чат.')));
    socket.on('close', () => finish(new Error('Связь с Codex прервалась; проверь чат перед повторной отправкой.')));
    socket.on('connect', () => {
      const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
      const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
      socket.write(Buffer.concat([header, payload]));
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length > 8 * 1024 * 1024) { finish(new Error('Ответ Codex слишком большой.')); return; }
      if (buffer.length < length + 4) return;
      try {
        const reply = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
        if (reply.error) finish(new Error(reply.error.message));
        else if (reply.id !== 1 || !('result' in reply)) finish(new Error('Неизвестный ответ приложения Codex.'));
        else finish(undefined, reply.result);
      } catch { finish(new Error('Не удалось прочитать ответ Codex.')); }
    });
  });
}

export type AppCall = (binding: ChatBinding, tool: 'read_thread' | 'send_message_to_thread', args: Record<string, unknown>) => Promise<any>;
export const appCall: AppCall = async (binding, tool, args) => {
  const result = await pipeRequest(binding.pipePath, 'tools/call', {
    namespace: 'codex_app', tool, arguments: { ...args, threadId: binding.threadId, hostId: binding.hostId },
    callerSource: 'codex', threadId: binding.threadId, hostId: binding.hostId,
    callId: `agentcraft-${randomUUID()}`, turnId: `mcp-turn-${randomUUID()}`,
  });
  const text = result.contentItems?.filter((x: any) => x.type === 'inputText').map((x: any) => x.text).join('\n');
  if (!result.success) throw new Error(text || 'Приложение Codex отклонило запрос.');
  try { return JSON.parse(text); } catch { throw new Error('Формат ответа Codex изменился; требуется обновление моста.'); }
};

export function textChunks(text: string, size = 380): string[] {
  const result: string[] = [];
  while (text.length) {
    let end = Math.min(size, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > end / 2) end = space;
    }
    result.push(text.slice(0, end)); text = text.slice(end).trimStart();
  }
  return result;
}

interface ChatState { threadId: string; seen: string[]; }
export class DesktopChat {
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopped = false;
  private online = false;
  private lastStatus = '';
  private state: ChatState;
  private sending = false;
  constructor(private options: {
    configFile: string; stateFile: string; call?: AppCall;
    onText: (text: string, final: boolean) => void;
    onStatus: (message: string) => void;
  }) {
    try { this.state = readJson<ChatState>(options.stateFile) ?? { threadId: '', seen: [] }; }
    catch { this.state = { threadId: '', seen: [] }; }
  }
  private status(text: string) {
    if (text === this.lastStatus || this.stopped) return;
    this.lastStatus = text; this.options.onStatus(text);
  }
  start() {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 5000); this.timer.unref();
  }
  stop() { this.stopped = true; clearInterval(this.timer); }
  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const binding = readBinding(this.options.configFile);
      if (!binding) { this.online = false; this.status('Чат Codex не подключён. Попроси Codex подключить этот чат к игре.'); return; }
      const data = await (this.options.call ?? appCall)(binding, 'read_thread', {
        turnLimit: 3, includeOutputs: false, maxOutputCharsPerItem: 20000,
      });
      if (this.stopped) return;
      if (data.thread?.id !== binding.threadId || !Array.isArray(data.turns)) throw new Error('Codex вернул другой чат или неизвестный формат.');
      const baseline = this.state.threadId !== binding.threadId;
      if (baseline) this.state = { threadId: binding.threadId, seen: [] };
      for (const turn of [...data.turns].reverse()) {
        for (const item of turn.items ?? []) {
          // Never export commands, tool results, reasoning, user messages or permission prompts.
          if (item.type !== 'agentMessage' || !['commentary', 'final'].includes(item.phase) || typeof item.text !== 'string') continue;
          if (item.phase === 'final' && turn.status === 'inProgress') continue;
          const key = `${turn.id}/${item.id}`;
          if (this.state.seen.includes(key)) continue;
          this.state.seen.push(key);
          if (!baseline) this.options.onText(item.text, item.phase === 'final');
        }
      }
      this.state.seen = this.state.seen.slice(-1500);
      writeJsonAtomic(this.options.stateFile, this.state);
      this.online = true;
      this.status(`Чат Codex: ${binding.title}. Пиши задачу в консоли; Enter — отправить.`);
    } catch (e) { this.online = false; this.status((e as Error).message); }
    finally { this.polling = false; }
  }
  async send(text: string): Promise<Record<string, unknown>> {
    if (this.stopped) throw new Error('Мост остановлен.');
    const binding = readBinding(this.options.configFile);
    if (!binding) throw new Error('Чат не подключён. Попроси Codex: «Подключи этот чат к игре».');
    if (!this.online) throw new Error('Связь с чатом ещё не готова. Открой Codex и дождись подключения.');
    if (this.state.threadId !== binding.threadId) throw new Error('Чат переключается; дождись подключения.');
    if (this.sending) throw new Error('Предыдущее сообщение ещё отправляется.');
    if (!text.trim() || text.length > 12000) throw new Error('Сообщение должно содержать от 1 до 12000 символов.');
    this.sending = true;
    try {
      const result = await (this.options.call ?? appCall)(binding, 'send_message_to_thread', {
        prompt: `[Сообщение пользователя из игровой консоли AgentCraft]\n${text}`,
      });
      if (result.threadId !== binding.threadId) throw new Error('Доставка не подтверждена. Проверь чат перед повторной отправкой.');
      return { chatDelivered: true, threadId: binding.threadId, chatTitle: binding.title };
    } finally { this.sending = false; }
  }
}
