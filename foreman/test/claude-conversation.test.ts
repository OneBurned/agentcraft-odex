import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireConversation, conversation, conversationLease, leaseNotice, publicMessages, returnConversation } from '../src/claude-conversation.js';
const dirs: string[] = [];
function fixture() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-conversation-test-')); dirs.push(d); return d; }
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
it.each(['game', 'review', 'terminal'] as const)('guides recovery of abandoned %s locks without reclaiming them', owner => {
  const d = fixture(); const file = path.join(d, 'conversation-lock.json');
  const contents = JSON.stringify({ token: randomUUID(), owner, pid: 2000001, childPid: 2000002 });
  fs.writeFileSync(file, contents);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  expect(leaseNotice(d)).toContain('Return-Klava-To-Game.cmd');
  expect(kill).toHaveBeenCalledWith(2000001, 0); expect(kill).toHaveBeenCalledWith(2000002, 0);
  expect(fs.readFileSync(file, 'utf8')).toBe(contents);
  expect(() => acquireConversation(d, 'game')).toThrow('Return-Klava-To-Game.cmd');
  expect(fs.readFileSync(file, 'utf8')).toBe(contents);
  returnConversation(d, true); expect(conversationLease(d)).toBeUndefined();
  expect(leaseNotice(d)).toBeUndefined();
});
it.each(['game', 'review'] as const)('keeps %s busy while its owner or child lives or cannot be inspected', owner => {
  const d = fixture(); const file = path.join(d, 'conversation-lock.json');
  fs.writeFileSync(file, JSON.stringify({ token: randomUUID(), owner, pid: 2000001, childPid: 2000002 }));
  const kill = vi.spyOn(process, 'kill');
  for (const livePid of [2000001, 2000002]) {
    kill.mockImplementation(pid => {
      if (pid === livePid) return true;
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    expect(leaseNotice(d)).toBe('Клава ещё занята. Дождись завершения ответа или ревью.');
    expect(() => returnConversation(d, true)).toThrow('ещё работает');
    expect(conversationLease(d)).toBeDefined();
  }
  kill.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  expect(leaseNotice(d)).toContain('ещё занята');
  expect(() => returnConversation(d, true)).toThrow('ещё работает');
});
it('fails closed for invalid bindings and never chooses a random recent conversation', () => {
  const d = fixture(); expect(conversation(d)).toBeUndefined();
  fs.writeFileSync(path.join(d, 'conversation.json'), JSON.stringify({ version: 1, sessionId: '../../wrong' }));
  expect(() => conversation(d)).toThrow();
  const sessionId = randomUUID(); fs.writeFileSync(path.join(d, 'conversation.json'), JSON.stringify({ version: 1, sessionId }));
  expect(conversation(d)?.sessionId).toBe(sessionId);
});
it('allows exactly one writer and does not let return terminate a live owner', () => {
  const d = fixture(); const lease = acquireConversation(d, 'terminal');
  expect(() => acquireConversation(d, 'game')).toThrow('терминале');
  expect(() => returnConversation(d, true)).toThrow('ещё работает');
  lease.release(); const next = acquireConversation(d, 'game');
  lease.release(); expect(conversationLease(d)?.owner).toBe('game'); next.release();
});
it('keeps the Desktop handoff until the operator confirms the session is closed', () => {
  const d = fixture(); acquireConversation(d, 'desktop');
  expect(() => returnConversation(d, false)).toThrow('подтверди');
  expect(() => acquireConversation(d, 'game')).toThrow('Code');
  returnConversation(d, true); expect(conversationLease(d)).toBeUndefined();
});
it('only projects conversation text, excluding reasoning, tools, local commands and subagents', () => {
  const row = (id: string, type: 'user' | 'assistant', content: unknown, parent_tool_use_id: string | null = null) => ({ uuid: id, type, message: { content }, session_id: randomUUID(), parent_tool_use_id, parent_agent_id: null });
  expect(publicMessages([
    row('1', 'user', 'Привет'), row('2', 'assistant', [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Ответ' }, { type: 'tool_use', input: 'secret' }]),
    row('3', 'user', [{ type: 'tool_result', content: 'raw diagnostic' }]), row('4', 'assistant', 'subagent', 'tool1'), row('5', 'user', '<local-command-stdout>diagnostic</local-command-stdout>'),
  ])).toEqual([{ id: '1', role: 'user', text: 'Привет' }, { id: '2', role: 'assistant', text: 'Ответ' }]);
});
