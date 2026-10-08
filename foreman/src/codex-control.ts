// Narrow Windows desktop IPC adapter, verified against Codex 26.930.4958.
// This connects to the existing desktop owner; it never starts/resumes an app-server process.
import net from 'node:net';
import { randomUUID } from 'node:crypto';

export class DesktopIpc {
  private socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private clientId = 'initializing-client';
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private ready: Promise<void>;
  constructor(pipe = '\\\\.\\pipe\\codex-ipc', private timeoutMs = 15000) {
    this.socket = net.createConnection(pipe);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Нет соединения с управлением Codex.')); this.close(); }, timeoutMs);
      this.socket.once('connect', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', error => { clearTimeout(timer); reject(error); });
      this.socket.once('close', () => { clearTimeout(timer); reject(new Error('Соединение Codex закрыто.')); });
    });
    this.socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (!size || size > 16 * 1024 * 1024) { this.close(); return; }
        if (this.buffer.length < size + 4) return;
        let message: any;
        try { message = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8')); }
        catch { this.close(); return; }
        this.buffer = this.buffer.subarray(size + 4);
        if (message.type === 'client-discovery-request') {
          this.write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
        } else if (message.type === 'response') {
          const p = this.pending.get(message.requestId);
          if (!p) continue;
          clearTimeout(p.timer); this.pending.delete(message.requestId);
          message.resultType === 'success' ? p.resolve(message) : p.reject(new Error(message.error || 'Codex отклонил команду.'));
        }
      }
    });
    this.socket.on('error', () => this.failPending());
    this.socket.on('close', () => this.failPending());
  }
  private write(message: unknown) {
    const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
    header.writeUInt32LE(body.length); this.socket.write(Buffer.concat([header, body]));
  }
  async request(method: string, params: unknown, version: number, targetClientId?: string): Promise<any> {
    await this.ready;
    if (this.socket.destroyed) throw new Error('Соединение Codex закрыто.');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Codex не подтвердил команду. Проверь состояние чата.'));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.write({ type: 'request', requestId, sourceClientId: this.clientId, method, params, version,
        targetClientId, timeoutMs: this.timeoutMs });
    });
  }
  async owner(threadId: string): Promise<string> {
    const init = await this.request('initialize', { clientType: 'agentcraft' }, 0);
    if (typeof init.result?.clientId !== 'string') throw new Error('Неизвестный ответ управления Codex.');
    this.clientId = init.result.clientId;
    const owner = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1);
    if (typeof owner.handledByClientId !== 'string') throw new Error('Не найден владелец открытого чата Codex.');
    return owner.handledByClientId;
  }
  private failPending() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Связь с управлением Codex прервалась. Проверь чат.')); }
    this.pending.clear();
  }
  close() { this.socket.destroy(); this.failPending(); }
}

export async function interruptDesktop(threadId: string, stop: boolean, options: { pipe?: string; timeoutMs?: number } = {}): Promise<void> {
  const ipc = new DesktopIpc(options.pipe, options.timeoutMs);
  try {
    const owner = await ipc.owner(threadId);
    if (stop) await ipc.request('thread-follower-clear-queued-messages', { conversationId: threadId }, 1, owner);
    // Same user-stop path as the app: interrupts work and pauses an active persistent Goal.
    const response = await ipc.request('thread-follower-interrupt-turn', { conversationId: threadId, mode: 'user-stop' }, 3, owner);
    const result = response.result;
    if (result?.ok !== true || result.goalPauseError) throw new Error(result?.goalPauseError || 'Остановка Codex не подтверждена.');
  } finally { ipc.close(); }
}
