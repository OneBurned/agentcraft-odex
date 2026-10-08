import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopChat, chatActivity, pipeRequest, readBinding, textChunks, type ChatBinding } from '../src/codex-desktop.js';
import { tempDir, rmrf } from './helpers.js';
import { PersonaSpeech } from '../src/personas.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmrf(dir); });
const binding: ChatBinding = { threadId: '01a10d94-9b8c-7aa3-9f2e-436175ba01ab', hostId: 'local', title: 'QA', pipePath: '\\\\.\\pipe\\codex-browser-use-qa' };
function fixture() {
  const dir = tempDir('ac-chat-'); dirs.push(dir);
  const configFile = path.join(dir, 'binding.json'), stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(configFile, JSON.stringify(binding));
  const onText = vi.fn(), onStatus = vi.fn(), onActivity = vi.fn();
  const response = { thread: { id: binding.threadId }, turns: [{ id: 't1', status: 'completed', items: [] as any[] }] };
  const call = vi.fn(async (_b: ChatBinding, tool: string, _args: any) => tool === 'read_thread' ? response : { threadId: binding.threadId });
  const interrupt = vi.fn(async (_threadId: string, _stop: boolean) => { response.turns[0]!.status = 'interrupted'; });
  const options = { configFile, stateFile, call, onText, onStatus, onActivity, interrupt };
  return { ...options, dir, response, options, chat: new DesktopChat(options) };
}

it('adds the current Codex persona to game messages but not task delivery, and preserves legacy text without a profile', async () => {
  const f = fixture(); const file = path.join(f.dir, 'personas.json');
  const personas = new PersonaSpeech({ file, now: Date.now, emit: () => {}, warn: () => {} });
  const chat = new DesktopChat({ ...f.options, personaDescription: () => personas.description('marlow') });
  await chat.poll(); await chat.send('Первое сообщение');
  const sent = () => f.call.mock.calls.filter(c => c[1] === 'send_message_to_thread').at(-1)![2].prompt;
  expect(sent()).toBe('[Сообщение пользователя из игровой консоли AgentCraft]\nПервое сообщение');
  const config = JSON.parse(fs.readFileSync(new URL('../../tools/templates/personas.json', import.meta.url), 'utf8'));
  config.roles.marlow.description = 'Unique developer persona';
  config.roles.wren.description = 'Unrelated reviewer persona';
  fs.writeFileSync(file, JSON.stringify(config));
  await chat.send('Личное сообщение');
  expect(sent()).toContain('Unique developer persona'); expect(sent()).toContain('Личное сообщение');
  expect(sent()).not.toContain('Unrelated reviewer persona');
  expect(sent()).toContain('Не переноси характер в артефакты');
  expect(sent()).toContain('JSON verdict/summary');
  expect(sent()).not.toContain(config.roles.marlow.events.dance[0]);
  await chat.send('Рабочая задача', 'task'); expect(sent()).not.toContain('Unique developer persona');
  fs.unlinkSync(file); await chat.send('Без профиля');
  expect(sent()).toBe('[Сообщение пользователя из игровой консоли AgentCraft]\nБез профиля');
  chat.stop();
});

describe('desktop chat relay', () => {
  it('ignores a stale idle poll that finishes after a newer send', async () => {
    const f = fixture(); await f.chat.poll();
    let release!: (value: any) => void;
    f.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.chat.poll();
    await f.chat.send('New work');
    const before = f.onActivity.mock.calls.length;
    release(f.response); await pending;
    expect(f.onActivity.mock.calls).toHaveLength(before);
    f.response.turns[0]!.status = 'inProgress'; await f.chat.poll();
    expect(f.onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'working' }));
  });
  it('does not replace a confirmed pause with an older failed poll', async () => {
    const f = fixture(); await f.chat.poll();
    let reject!: (error: Error) => void;
    f.call.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = f.chat.poll();
    await f.chat.control('pause');
    reject(new Error('old timeout')); await pending;
    expect(f.onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'paused' }));
    await expect(f.chat.control('resume')).resolves.toMatchObject({ chatDelivered: true });
  });
  it('confirms a real interruption, persists pause across restart, and resumes only on request', async () => {
    const f = fixture(); f.response.turns[0]!.status = 'inProgress'; await f.chat.poll();
    expect(await f.chat.control('pause')).toMatchObject({ chatControl: 'paused' });
    expect(f.interrupt).toHaveBeenCalledWith(binding.threadId, false);
    expect(f.onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'paused' }));
    const resumed = new DesktopChat(f.options); await resumed.poll();
    expect(f.onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'paused' }));
    expect(f.call.mock.calls.filter(c => c[1] === 'send_message_to_thread')).toHaveLength(0);
    expect(await resumed.control('resume')).toMatchObject({ chatDelivered: true });
    expect(f.call.mock.calls.filter(c => c[1] === 'send_message_to_thread')).toHaveLength(1);
    await expect(resumed.control('resume')).rejects.toThrow('не поставлен на паузу');
    f.response.turns.unshift({ id: 'next', status: 'inProgress', items: [] }); await resumed.poll();
    expect(f.onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'working' }));
  });
  it('stops through the desktop and does not offer to resume a cancelled task', async () => {
    const f = fixture(); await f.chat.poll();
    expect(await f.chat.control('stop')).toMatchObject({ chatControl: 'stopped' });
    expect(f.interrupt).toHaveBeenCalledWith(binding.threadId, true);
    await f.chat.poll(); expect(f.onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'stopped' }));
    await expect(f.chat.control('resume')).rejects.toThrow('не поставлен на паузу');
  });
  it('never claims a pause on IPC failure, offline read or wrong-thread confirmation', async () => {
    const f = fixture(); await f.chat.poll();
    f.interrupt.mockRejectedValueOnce(new Error('not supported'));
    await expect(f.chat.control('pause')).rejects.toThrow('not supported');
    f.call.mockRejectedValueOnce(new Error('offline'));
    await expect(f.chat.control('pause')).rejects.toThrow('offline');
    f.response.thread.id = 'wrong';
    await expect(f.chat.control('pause')).rejects.toThrow('проверить остановку');
    expect(f.onActivity.mock.calls.some(([a]) => a.phase === 'paused')).toBe(false);
  });
  it('rejects overlapping controls/messages and ignores a poll that finishes during interruption', async () => {
    const f = fixture(); await f.chat.poll();
    let read!: (value: any) => void, stop!: () => void;
    f.call.mockImplementationOnce(() => new Promise(resolve => { read = resolve; }));
    const polling = f.chat.poll();
    f.interrupt.mockImplementationOnce(() => new Promise(resolve => { stop = resolve; }));
    const stopping = f.chat.control('pause');
    await expect(f.chat.control('stop')).rejects.toThrow('ещё обрабатывается');
    await expect(f.chat.send('new')).rejects.toThrow('ещё обрабатывается');
    read(f.response); await polling;
    expect(f.onActivity).toHaveBeenCalledTimes(1);
    stop(); await stopping;
    expect(f.onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'paused' }));
  });
  it('does not claim interruption just because IPC accepted the request', async () => {
    const f = fixture(); f.response.turns[0]!.status = 'inProgress'; await f.chat.poll();
    f.interrupt.mockImplementationOnce(async () => {});
    vi.useFakeTimers();
    try {
      const pending = expect(f.chat.control('pause')).rejects.toThrow('не подтверждена');
      await vi.runAllTimersAsync(); await pending;
      expect(f.onActivity.mock.calls.some(([a]) => a.phase === 'paused')).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('reports live activity on the first read, despite baselining the transcript', async () => {
    const f = fixture(); f.response.turns[0]!.status = 'inProgress';
    await f.chat.poll();
    expect(f.onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'working' }));
    f.response.turns[0]!.status = 'completed'; await f.chat.poll();
    expect(f.onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'completed' }));
    f.call.mockRejectedValueOnce(new Error('offline')); await f.chat.poll();
    expect(f.onActivity).toHaveBeenLastCalledWith({ key: '', phase: 'unavailable' });
    fs.unlinkSync(f.configFile); await f.chat.poll();
    expect(f.onActivity).toHaveBeenLastCalledWith({ key: '', phase: 'unavailable' });
  });
  it.each([
    [{ type: 'active', activeFlags: [] }, 'completed', 'working'],
    [{ type: 'active', activeFlags: ['waitingOnApproval'] }, 'inProgress', 'waiting'],
    [{ type: 'active', activeFlags: ['waitingOnUserInput'] }, 'inProgress', 'waiting'],
    [{ type: 'idle' }, 'completed', 'completed'],
    [{ type: 'idle' }, 'interrupted', 'interrupted'],
    [{ type: 'idle' }, 'failed', 'error'],
    [{ type: 'systemError' }, 'inProgress', 'error'],
    [{ type: 'notLoaded' }, 'completed', 'unavailable'],
    [{ type: 'idle' }, 'unknown', 'unavailable'],
  ])('uses actual thread and latest turn metadata: %j / %s', (status, turnStatus, phase) => {
    expect(chatActivity({ thread: { id: 'chat', status }, turns: [
      { id: 'new', status: turnStatus, startedAt: 123 }, { id: 'old', status: 'inProgress' },
    ] })).toEqual({ key: 'chat/new', phase, startedAt: 123000 });
  });
  it('baselines old text, forwards only public agent text and persists deduplication across restart', async () => {
    const f = fixture();
    f.response.turns[0]!.items.push({ type: 'agentMessage', id: 'old', phase: 'final', text: 'old answer' });
    await f.chat.poll(); expect(f.onText).not.toHaveBeenCalled();
    f.response.turns[0]!.items.push(
      { type: 'commandExecution', id: 'cmd', text: 'private output' },
      { type: 'reasoning', id: 'reason', text: 'private reasoning' },
      { type: 'userMessage', id: 'user', text: 'private prompt' },
      { type: 'agentMessage', id: 'new', phase: 'final', text: 'public answer' });
    await f.chat.poll(); await f.chat.poll();
    expect(f.onText.mock.calls).toEqual([['public answer', true]]);
    const resumed = new DesktopChat(f.options); await resumed.poll();
    expect(f.onText).toHaveBeenCalledTimes(1);
  });
  it.each(['final', 'final_answer'])('waits for a completed turn before forwarding a %s answer', async phase => {
    const f = fixture(); await f.chat.poll();
    f.response.turns[0]!.status = 'inProgress';
    f.response.turns[0]!.items.push({ type: 'agentMessage', id: 'final', phase, text: 'partial' });
    await f.chat.poll(); expect(f.onText).not.toHaveBeenCalled();
    f.response.turns[0]!.status = 'completed'; f.response.turns[0]!.items[0].text = 'complete answer';
    await f.chat.poll(); expect(f.onText).toHaveBeenCalledWith('complete answer', true);
    await f.chat.poll(); expect(f.onText).toHaveBeenCalledTimes(1);
  });
  it('sends to the bound thread without changing model, permissions or starting a thread', async () => {
    const f = fixture(); await f.chat.poll();
    expect(await f.chat.send('Привет\n$(do-not-run)')).toMatchObject({ chatDelivered: true, threadId: binding.threadId });
    expect(f.call.mock.calls.at(-1)).toEqual([binding, 'send_message_to_thread', { prompt: '[Сообщение пользователя из игровой консоли AgentCraft]\nПривет\n$(do-not-run)' }]);
  });
  it('fails closed without a binding or before a successful read, and rejects invalid destinations', async () => {
    const f = fixture(); await expect(f.chat.send('hi')).rejects.toThrow('ещё не готова');
    fs.writeFileSync(f.configFile, JSON.stringify({ ...binding, pipePath: '\\\\other-host\\pipe\\anything' }));
    expect(() => readBinding(f.configFile)).toThrow('Некорректная');
    fs.unlinkSync(f.configFile); await expect(f.chat.send('hi')).rejects.toThrow('не подключён');
  });
  it('does not automatically retry an uncertain send and keeps offline errors out of the transcript', async () => {
    const f = fixture(); await f.chat.poll();
    f.call.mockRejectedValueOnce(new Error('unknown delivery'));
    await expect(f.chat.send('test')).rejects.toThrow('unknown delivery');
    expect(f.call.mock.calls.filter(c => c[1] === 'send_message_to_thread')).toHaveLength(1);
    f.call.mockRejectedValueOnce(new Error('offline')); await f.chat.poll();
    await expect(f.chat.send('again')).rejects.toThrow('ещё не готова');
    expect(f.onText).not.toHaveBeenCalled();
  });
  it('rejects a mismatched response thread and overlapping sends', async () => {
    const f = fixture(); await f.chat.poll();
    let release!: (value: any) => void;
    f.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.chat.send('first');
    await expect(f.chat.send('second')).rejects.toThrow('ещё отправляется');
    release({ threadId: 'wrong' }); await expect(pending).rejects.toThrow('не подтверждена');
  });
  it('does not forward late reads after shutdown', async () => {
    const f = fixture(); await f.chat.poll();
    let release!: (value: any) => void;
    f.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.chat.poll(); f.chat.stop();
    f.response.turns[0]!.items.push({ type: 'agentMessage', id: 'late', phase: 'final', text: 'late' });
    release(f.response); await pending; expect(f.onText).not.toHaveBeenCalled();
    expect(f.onActivity).toHaveBeenCalledTimes(1);
  });
  it('splits long answers to fit the game feed', () => {
    const chunks = textChunks('строка '.repeat(200));
    expect(chunks.length).toBeGreaterThan(1); expect(chunks.every(c => c.length <= 380)).toBe(true);
    expect(chunks.join(' ').trim()).toBe('строка '.repeat(200).trim());
  });
});

it('parses fragmented native-pipe frames', async () => {
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\ac-test-${process.pid}-${Date.now()}` : path.join(tempDir('ac-pipe-'), 's');
  const server = net.createServer(socket => socket.once('data', () => {
    const p = Buffer.from(JSON.stringify({ id: 1, jsonrpc: '2.0', result: { ok: true } }));
    const h = Buffer.alloc(4); h.writeUInt32LE(p.length);
    socket.write(h.subarray(0, 2)); socket.write(Buffer.concat([h.subarray(2), p]));
  }));
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try { expect(await pipeRequest(socketPath, 'tools/list', {}, 1000)).toEqual({ ok: true }); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('times out an unresponsive desktop without retrying the request', async () => {
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\ac-timeout-${process.pid}-${Date.now()}` : path.join(tempDir('ac-pipe-'), 's');
  let requests = 0;
  const server = net.createServer(socket => { socket.on('data', () => { requests++; }); });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try { await expect(pipeRequest(socketPath, 'tools/call', {}, 100)).rejects.toThrow('не подтвердил'); expect(requests).toBe(1); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
