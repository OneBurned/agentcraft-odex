import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ChatBindingSchema, appToolRequest, connectorBinding } from '../src/codex-binding.js';

const env = { CODEX_THREAD_ID: randomUUID(), CODEX_APP_TOOLS_PIPE_PATH: '\\\\.\\pipe\\codex-app-tools-test' };
const host = `remote-ssh-codex-managed:${randomUUID()}`;
it('keeps the Windows caller separate from the selected remote target for both tools', () => {
  const b = connectorBinding({ thread: randomUUID(), host }, env);
  for (const tool of ['read_thread', 'send_message_to_thread'] as const) {
    const r = appToolRequest(b, tool, { threadId: 'wrong', hostId: 'local' });
    expect(r.arguments).toEqual({ threadId: b.threadId, hostId: host });
    expect(r).toMatchObject({ threadId: env.CODEX_THREAD_ID, hostId: 'local' });
  }
  expect(appToolRequest({ ...b, provider: 'codex', transport: 'codex-desktop' } as typeof b, 'read_thread', {}).arguments.hostId).toBe(host);
});
it('preserves old local bindings and rejects malformed or ambiguous remote selection', () => {
  const b = connectorBinding({}, env);
  const { callerThreadId, ...legacy } = b;
  legacy.pipePath = '\\\\.\\pipe\\codex-browser-use-test';
  expect(ChatBindingSchema.parse(legacy).hostId).toBe('local');
  expect(() => connectorBinding({ host }, env)).toThrow('both');
  expect(() => connectorBinding({ thread: randomUUID() }, env)).toThrow('both');
  expect(() => connectorBinding({ thread: randomUUID(), host: 'gosha' }, env)).toThrow();
  expect(() => connectorBinding({}, {})).toThrow('Windows');
  expect(() => ChatBindingSchema.parse({ ...legacy, hostId: host })).toThrow('caller');
  expect(() => ChatBindingSchema.parse({ ...b, pipePath: '\\\\other\\pipe\\codex-app-tools-test' })).toThrow();
});
