import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DesktopIpc, interruptDesktop } from '../src/codex-control.js';
import { tempDir, rmrf } from './helpers.js';
import path from 'node:path';

async function serverTest(run: (pipe: string, requests: any[]) => Promise<void>, interruptResult: any = { ok: true, interruptedTurnId: 'turn' }) {
  const dir = process.platform === 'win32' ? undefined : tempDir('ac-control-');
  const pipe = dir ? path.join(dir, 's') : `\\\\.\\pipe\\ac-control-${randomUUID()}`;
  const requests: any[] = [];
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0), message = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
        buffer = buffer.subarray(size + 4); requests.push(message);
        const result = message.method === 'initialize' ? { clientId: 'game-client' }
          : message.method === 'thread-owner-discovery' ? { supportsUntrustedAppInput: true }
          : message.method === 'thread-follower-clear-queued-messages' ? { messages: [] } : interruptResult;
        const body = Buffer.from(JSON.stringify({ type: 'response', requestId: message.requestId,
          method: message.method, resultType: 'success', handledByClientId: 'desktop-owner', result }));
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        socket.write(header.subarray(0, 2)); socket.write(Buffer.concat([header.subarray(2), body]));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(pipe, resolve));
  try { await run(pipe, requests); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); if (dir) rmrf(dir); }
}

describe('desktop task control IPC', () => {
  it('discovers the bound owner and interrupts via user-stop, preserving queued messages on pause', async () => {
    await serverTest(async (pipe, requests) => {
      await interruptDesktop('bound-chat', false, { pipe });
      expect(requests.map(r => r.method)).toEqual(['initialize', 'thread-owner-discovery', 'thread-follower-interrupt-turn']);
      expect(requests[1].params).toEqual({ hostId: 'local', conversationId: 'bound-chat' });
      expect(requests[2]).toMatchObject({ targetClientId: 'desktop-owner', sourceClientId: 'game-client', version: 3,
        params: { conversationId: 'bound-chat', mode: 'user-stop' } });
    });
  });
  it('clears only the bound chat queue before Stop', async () => {
    await serverTest(async (pipe, requests) => {
      await interruptDesktop('bound-chat', true, { pipe });
      expect(requests[2]).toMatchObject({ method: 'thread-follower-clear-queued-messages', version: 1,
        targetClientId: 'desktop-owner', params: { conversationId: 'bound-chat' } });
      expect(requests[3].method).toBe('thread-follower-interrupt-turn');
    });
  });
  it('does not hide a failed Goal pause behind an accepted interruption', async () => {
    await serverTest(async pipe => {
      await expect(interruptDesktop('bound-chat', false, { pipe })).rejects.toThrow('goal could not pause');
    }, { ok: true, goalPauseError: 'goal could not pause', interruptedTurnId: 'turn' });
  });
  it('fails without opening another app-server when desktop IPC is unavailable', async () => {
    const ipc = new DesktopIpc(process.platform === 'win32' ? `\\\\.\\pipe\\missing-${randomUUID()}` : `/tmp/missing-${randomUUID()}`);
    try { await expect(ipc.owner('bound-chat')).rejects.toThrow(); }
    finally { ipc.close(); }
  });
});
