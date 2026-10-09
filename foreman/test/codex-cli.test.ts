import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexCliProcess, CodexCliAdapter, type CliConnection, type SpawnCli } from '../src/codex-cli.js';
import { AgentConnections } from '../src/agent-connections.js';
import { TeamRegistry } from '../src/team.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { Foreman } from '../src/foreman.js';
import { CodexAdapter } from '../src/agent-adapters.js';
import { silentLogger } from '../src/context.js';
import { tempDir, rmrf, until, testConfig } from './helpers.js';

const dirs: string[] = [], adapters: CodexCliAdapter[] = [];
const dir = () => { const d = tempDir('codex-cli-test-'); dirs.push(d); return d; };
afterEach(async () => { for (const a of adapters.splice(0)) await a.dispose(); for (const d of dirs.splice(0)) rmrf(d); });
function connection(): CliConnection {
  return { version: 1, provider: 'codex', transport: 'codex-cli', agentId: 'coder', sessionId: randomUUID(),
    workspace: dir(), executable: process.execPath, sandbox: 'read-only' };
}
class Child extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); stdin = new PassThrough();
  exitCode: number | null = null; signalCode: string | null = null; pid = 123456;
  prompt = '';
  constructor() { super(); this.stdin.on('data', b => this.prompt += b.toString()); }
  event(value: object) { this.stdout.write(JSON.stringify(value) + '\n'); }
  close(code = 0) { this.exitCode = code; this.emit('close', code); }
  process() { return this as unknown as ChildProcess; }
}
function processes(auth = true) {
  const calls: { args: string[]; options: SpawnOptions; child: Child }[] = [];
  let exitsOnKill = true;
  const launch: SpawnCli = (_exe, args, options) => {
    const child = new Child(); calls.push({ args, options, child });
    if (args[0] === '--version' || args.includes('--help') || args[0] === 'login') queueMicrotask(() => {
      child.stdout.write(args[0] === '--version' ? 'codex-cli 0.162.0-alpha.2' : args[0] === 'login' ? '' : '--json --sandbox --cd SESSION_ID');
      child.close(args[0] === 'login' && !auth ? 1 : 0);
    });
    return child.process();
  };
  const kill = vi.fn(async (process: ChildProcess) => { if (exitsOnKill) (process as unknown as Child).close(1); });
  return { calls, launch, kill, setExits: (value: boolean) => { exitsOnKill = value; }, last: () => calls.at(-1)!.child };
}
function success(child: Child, id: string, text: string) {
  child.event({ type: 'thread.started', thread_id: id });
  child.event({ type: 'item.completed', item: { type: 'agent_message', id: 'answer', text } });
  child.event({ type: 'turn.completed' }); child.close();
}
function fixture(auth = true, personaDescription?: () => string | undefined) {
  const root = dir(), team = new TeamRegistry(root), store = new AgentConnections(root, team);
  team.change('create', { revision: 0, agent: { name: 'Coder', provider: 'codex', roles: ['developer'], enabled: true, visible: true,
    appearance: { skin: 'marlow', color: '#112233', slim: false } } }, () => {});
  const c = { ...connection(), agentId: team.snapshot().agents[0]!.id };
  store.bind({ id: c.agentId, revision: 1, connection: c }, () => {});
  const fake = processes(auth), runner = new CodexCliProcess(c, fake.launch, fake.kill, 20);
  const text = vi.fn(), activity = vi.fn();
  const a = new CodexCliAdapter(c, store, { text, activity, history: vi.fn(), personaDescription }, runner, () => false);
  adapters.push(a);
  return { a, c, store, fake, runner, text, activity, root, team };
}
it('loads CLI persona for game replies and preserves neutral task purpose across pause/resume', async () => {
  let style = 'Distinct personality';
  const f = fixture(true, () => style); await f.a.check();
  const thread = randomUUID();
  await f.a.send('Hello', 'message'); await until(() => f.runner.busy());
  expect(f.fake.last().prompt).toContain(style); expect(f.fake.last().prompt).toContain('артефакты');
  success(f.fake.last(), thread, 'Hello back'); await until(() => !f.a.busy());
  style = 'Updated personality';
  await f.a.send('Hello again', 'message'); await until(() => f.runner.busy());
  expect(f.fake.last().prompt).toContain(style);
  success(f.fake.last(), thread, 'Second reply'); await until(() => !f.a.busy());
  await f.a.send('Review the change', 'task'); await until(() => f.runner.busy());
  expect(f.fake.last().prompt).not.toContain(style);
  await f.a.control('pause');
  await f.a.control('resume'); await until(() => f.runner.busy());
  expect(f.fake.last().prompt).not.toContain(style); expect(f.fake.last().prompt).toContain('артефакты');
  await f.a.control('stop');
});
it.each([false, true])('preserves sandbox startup failure when a later turn failure is %s', async turnFailed => {
  const f = fixture(); await f.a.check(); await f.a.send('work', 'task'); await until(() => f.runner.busy());
  const child = f.fake.last(), id = randomUUID();
  child.event({ type: 'thread.started', thread_id: id });
  child.event({ type: 'item.completed', item: { type: 'command_execution', exit_code: -1,
    aggregated_output: 'Failed to create unified exec process: helper_unknown_error: setup refresh had errors', command: 'private command' } });
  if (turnFailed) { child.event({ type: 'turn.failed', error: { message: 'private upstream detail' } }); child.close(1); }
  else success(child, id, 'Misleading success');
  await until(() => !f.a.busy());
  expect(f.activity.mock.calls.at(-1)).toEqual(['error', expect.stringContaining('Песочница Codex CLI')]);
  expect(JSON.stringify(f.activity.mock.calls)).not.toContain('private command');
  expect(f.text).not.toHaveBeenCalled();
  expect(f.fake.calls.at(-1)!.args).toContain('read-only');
});
it('does not classify an ordinary failing command as a sandbox failure', async () => {
  const f = fixture(); await f.a.check(); await f.a.send('work', 'task'); await until(() => f.runner.busy());
  const child = f.fake.last(), id = randomUUID();
  child.event({ type: 'thread.started', thread_id: id });
  child.event({ type: 'item.completed', item: { type: 'command_execution', exit_code: 1, aggregated_output: 'Test failed' } });
  success(child, id, 'Tests failed'); await until(() => !f.a.busy());
  expect(f.text).toHaveBeenCalledWith('Tests failed', true);
});
it('checks version/capabilities/login without starting a turn or touching the project', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.c.workspace, 'sentinel'), 'unchanged');
  expect(await f.a.check()).toEqual({ version: '0.162.0-alpha.2' });
  expect(f.fake.calls.map(c => c.args)).toEqual([['--version'], ['exec', '--help'], ['exec', 'resume', '--help'], ['login', 'status']]);
  for (const call of f.fake.calls) { expect(call.options.cwd).toBe(os.tmpdir()); expect(call.options.shell).toBe(false); expect(call.child.prompt).toBe(''); }
  expect(fs.readdirSync(f.c.workspace)).toEqual(['sentinel']);
  expect(fs.readFileSync(path.join(f.c.workspace, 'sentinel'), 'utf8')).toBe('unchanged');
  expect(fs.existsSync(f.store.file(`agents/${f.c.agentId}/codex-cli-${f.c.sessionId}.json`))).toBe(false);
  expect(f.text).not.toHaveBeenCalled();
});
it('refuses an unauthenticated CLI without exposing raw diagnostics or starting work', async () => {
  const f = fixture(false);
  await expect(f.a.check()).rejects.toThrow('codex login');
  await expect(f.a.send('edit', 'task')).rejects.toThrow('не готов');
  expect(f.fake.calls).toHaveLength(4); expect(f.text).not.toHaveBeenCalled();
});
it('routes two CLI agents to independent native threads and resumes only the exact saved ID', async () => {
  const one = fixture(), two = fixture();
  await one.a.check(); await two.a.check();
  const id1 = randomUUID(), id2 = randomUUID();
  await one.a.send('alpha', 'task'); await two.a.send('beta', 'message');
  await until(() => one.runner.busy() && two.runner.busy());
  expect(one.fake.last().prompt).toContain('alpha'); expect(two.fake.last().prompt).toContain('beta');
  success(one.fake.last(), id1, 'answer one'); success(two.fake.last(), id2, 'answer two');
  await until(() => !one.a.busy() && !two.a.busy());
  expect(one.text).toHaveBeenCalledWith('answer one', true); expect(two.text).toHaveBeenCalledWith('answer two', true);
  await one.a.send('follow-up', 'message'); await until(() => one.runner.busy());
  const args = one.fake.calls.at(-1)!.args;
  expect(args).toContain(id1); expect(args).not.toContain(id2); expect(args).not.toContain('--last');
  expect(args.slice(-4)).toEqual(['resume', '--json', id1, '-']);
  expect(args).toContain('approval_policy="never"'); expect(args).toContain('read-only');
  success(one.fake.last(), id1, 'follow-up answer'); await until(() => !one.a.busy());
});
it('waits for process close, rejects late output and allows retrying an unconfirmed stop', async () => {
  const f = fixture(); await f.a.check(); await f.a.send('work', 'task'); await until(() => f.runner.busy());
  const child = f.fake.last(); child.event({ type: 'thread.started', thread_id: randomUUID() });
  f.fake.setExits(false);
  await expect(f.a.control('stop')).rejects.toThrow('ещё не завершился');
  expect(f.a.busy()).toBe(true); expect(f.activity.mock.calls.at(-1)![0]).toBe('unavailable');
  child.event({ type: 'item.completed', item: { type: 'agent_message', id: 'late', text: 'late answer' } });
  await expect(f.a.send('second task', 'task')).rejects.toThrow('не готов');
  f.fake.setExits(true); await expect(f.a.control('stop')).resolves.toMatchObject({ chatControl: 'stopped' });
  expect(f.a.busy()).toBe(false); expect(f.text).not.toHaveBeenCalled();
  await expect(f.a.control('resume')).rejects.toThrow('Нет приостановленного');
});
it('pauses one process, resumes its interrupted thread and never stops its neighbor', async () => {
  const a = fixture(), b = fixture(); await a.a.check(); await b.a.check();
  await a.a.send('task A', 'task'); await b.a.send('task B', 'task'); await until(() => a.runner.busy() && b.runner.busy());
  const thread = randomUUID(); a.fake.last().event({ type: 'thread.started', thread_id: thread });
  await a.a.control('pause'); expect(b.runner.busy()).toBe(true); expect(b.fake.kill).not.toHaveBeenCalled();
  await a.a.control('resume'); await until(() => a.runner.busy());
  expect(a.fake.calls.at(-1)!.args).toContain(thread); expect(a.fake.last().prompt).toContain('Продолжи прерванный');
  await a.a.control('stop'); await b.a.control('stop');
});
it('does not accept failure, malformed events, reasoning or a different resumed session as success', async () => {
  for (const mode of ['failure', 'wrong session', 'malformed', 'missing session', 'oversized']) {
    const c = connection(), fake = processes(), runner = new CodexCliProcess(c, fake.launch, fake.kill, 20), thread = randomUUID();
    const result = runner.run('task', thread, new AbortController().signal, () => {}, () => {});
    const assertion = expect(result).rejects.toThrow();
    const child = fake.last();
    child.event({ type: 'item.completed', item: { type: 'reasoning', id: 'private', text: 'hidden' } });
    if (mode === 'failure') { child.event({ type: 'turn.failed', error: { message: 'secret from upstream' } }); child.close(1); }
    else if (mode === 'wrong session') child.event({ type: 'thread.started', thread_id: randomUUID() });
    else if (mode === 'malformed') child.stdout.write('not json\n');
    else if (mode === 'oversized') child.event({ type: 'item.completed', item: { type: 'agent_message', id: 'large', text: 'я'.repeat(500001) } });
    else { child.event({ type: 'turn.completed' }); child.close(); }
    await assertion; expect(runner.busy()).toBe(false);
  }
});
it('keeps the native thread across adapter restart without automatically resending a pending request', async () => {
  const f = fixture(); await f.a.check(); await f.a.send('work', 'task'); await until(() => f.runner.busy());
  const thread = randomUUID(); f.fake.last().event({ type: 'thread.started', thread_id: thread });
  await f.a.control('pause'); await f.a.dispose();
  const fake = processes(); const a = new CodexCliAdapter(f.c, f.store, { activity: vi.fn(), text: vi.fn(), history: vi.fn() },
    new CodexCliProcess(f.c, fake.launch, fake.kill, 20), () => false); adapters.push(a);
  await a.check(); expect(fake.calls).toHaveLength(4);
  await a.control('resume'); await until(() => fake.calls.length === 5);
  expect(fake.calls.at(-1)!.args).toContain(thread); await a.control('stop');
});
it('reserves a CLI session for one agent and rejects credentials and shell wrappers in bindings', () => {
  const f = fixture();
  f.team.change('create', { revision: f.team.snapshot().revision, agent: { name: 'Other', provider: 'codex', roles: ['developer'], enabled: true,
    visible: true, appearance: { skin: 'marlow', color: '#123456', slim: false } } }, () => {});
  const id = f.team.snapshot().agents.at(-1)!.id;
  expect(() => f.store.bind({ id, revision: f.team.snapshot().revision, connection: f.c }, () => {})).toThrow('уже назначен');
  for (const patch of [{ token: 'secret' }, { executable: path.join(f.root, 'codex.cmd') }, { sandbox: 'danger-full-access' }])
    expect(() => f.store.bind({ id, revision: f.team.snapshot().revision, connection: { ...f.c, sessionId: randomUUID(), ...patch } }, () => {})).toThrow();
});
it('publishes per-agent controls and histories through the A3 runtime after process completion', async () => {
  const f = new Foreman({ config: testConfig(dir(), ['--backend', 'observer']), logger: silentLogger });
  const fake = new Map<string, ReturnType<typeof processes>>();
  const runtime = new AgentRuntime(f, (c, store, events) => {
    if (c.transport !== 'codex-cli') throw new Error('Unexpected transport');
    const p = processes(); fake.set(c.agentId, p);
    return new CodexCliAdapter(c, store, events, new CodexCliProcess(c, p.launch, p.kill, 20), () => false);
  });
  try {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      f.teamAction('team.create', { revision: f.team!.snapshot().revision, agent: { name: 'Same name', provider: 'codex', roles: ['developer'], enabled: true,
        visible: true, appearance: { skin: 'marlow', color: '#123456', slim: false } } });
      const id = f.team!.snapshot().agents.at(-1)!.id; ids.push(id);
      runtime.connections.bind({ id, revision: f.team!.snapshot().revision, connection: { ...connection(), agentId: id } }, () => {});
    }
    runtime.start(); await until(() => ids.every(id => f.agent(id)?.controls?.message));
    await runtime.send(ids[0]!, 'first'); await runtime.send(ids[1]!, 'second');
    await until(() => ids.every(id => fake.get(id)!.calls.length === 5));
    success(fake.get(ids[0]!)!.last(), randomUUID(), 'first answer');
    await until(() => f.agent(ids[0]!)?.controls?.message === true);
    expect(runtime.view(ids[0]!).history.map(row => row.text)).toEqual(['first', 'first answer']);
    expect(runtime.view(ids[1]!).phase).toBe('working');
    expect(() => runtime.assertIdle(ids[1]!)).toThrow('занят');
    await runtime.control(ids[1]!, 'stop');
    expect(runtime.view(ids[1]!).history.map(row => row.text)).toEqual(['second']);
    expect(runtime.view(ids[1]!).phase).toBe('stopped');
    await runtime.check(ids[1]!); expect(fake.get(ids[1]!)!.calls).toHaveLength(9);
  } finally { await runtime.stop(); await f.close(); }
});
it('portable trial: desktop and CLI Codex coexist with independent histories and stop targets', async () => {
  const f = new Foreman({ config: testConfig(dir(), ['--backend', 'observer']), logger: silentLogger });
  const cli = processes(), threadId = randomUUID(), interrupted: string[] = [], sent: string[] = [];
  let working = false, turn = randomUUID();
  const runtime = new AgentRuntime(f, (c, store, events) => {
    if (c.transport === 'codex-cli') return new CodexCliAdapter(c, store, events, new CodexCliProcess(c, cli.launch, cli.kill, 20), () => false);
    if (c.transport !== 'codex-desktop') throw Error('Unexpected transport');
    return new CodexAdapter(c, store, events, {
      call: async (binding, tool) => {
        expect(binding.threadId).toBe(threadId);
        if (tool === 'send_message_to_thread') { sent.push(binding.threadId); working = true; turn = randomUUID(); return { threadId }; }
        return { thread: { id: threadId, status: { type: working ? 'active' : 'idle' } }, turns: [{ id: turn, status: working ? 'inProgress' : 'completed', items: [] }] };
      }, interrupt: async id => { interrupted.push(id); working = false; },
    });
  });
  try {
    const ids: string[] = [];
    for (const transport of ['codex-desktop', 'codex-cli'] as const) {
      f.teamAction('team.create', { revision: f.team!.snapshot().revision, agent: { name: 'Same name', provider: 'codex', roles: ['developer'], enabled: true,
        visible: true, appearance: { skin: 'marlow', color: '#123456', slim: false } } });
      const id = f.team!.snapshot().agents.at(-1)!.id; ids.push(id);
      const c = transport === 'codex-cli' ? { ...connection(), agentId: id } : { provider: 'codex', transport, threadId, hostId: 'local', title: 'Fixture', pipePath: '\\\\.\\pipe\\codex-browser-use-trial' };
      runtime.connections.bind({ id, revision: f.team!.snapshot().revision, connection: c }, () => {});
    }
    runtime.start(); await until(() => ids.every(id => f.agent(id)?.controls?.message));
    await runtime.send(ids[0]!, 'Desktop only'); await runtime.send(ids[1]!, 'CLI only');
    await until(() => cli.calls.length === 5); expect(sent).toEqual([threadId]);
    success(cli.last(), randomUUID(), 'CLI answer'); await until(() => runtime.view(ids[1]!).phase === 'completed');
    expect(runtime.view(ids[1]!).history.map(row => row.text)).toEqual(['CLI only', 'CLI answer']);
    expect(JSON.stringify(runtime.view(ids[0]!).history)).not.toContain('CLI answer');
    await runtime.send(ids[1]!, 'CLI still running'); await until(() => cli.calls.length === 6);
    await runtime.control(ids[0]!, 'stop'); expect(interrupted).toEqual([threadId]); expect(cli.kill).not.toHaveBeenCalled();
    expect(runtime.view(ids[1]!).phase).toBe('working');
    await runtime.control(ids[1]!, 'stop'); expect(cli.kill).toHaveBeenCalledOnce(); expect(interrupted).toHaveLength(1);
  } finally { await runtime.stop(); await f.close(); }
});
it('does not spawn after cancellation before the run microtask', async () => {
  const f = fixture(); await f.a.check();
  const send = f.a.send('cancel before launch', 'task');
  const stop = f.a.control('stop'); await send; await stop;
  expect(f.fake.calls).toHaveLength(4); expect(f.text).not.toHaveBeenCalled();
});
it('refuses to claim or kill a surviving process after bridge restart', async () => {
  const f = fixture(), file = f.store.file(`agents/${f.c.agentId}/codex-cli-${f.c.sessionId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sessionId: f.c.sessionId, threadId: randomUUID(), pending: 'interrupted task', pid: 42 }));
  const fake = processes(); let live = true;
  const a = new CodexCliAdapter(f.c, f.store, { activity: vi.fn(), text: vi.fn(), history: vi.fn() },
    new CodexCliProcess(f.c, fake.launch, fake.kill, 20), () => live); adapters.push(a);
  await expect(a.check()).rejects.toThrow('предыдущего моста');
  await expect(a.control('stop')).rejects.toThrow('предыдущего моста');
  expect(a.busy()).toBe(true); expect(fake.calls).toHaveLength(0); expect(fake.kill).not.toHaveBeenCalled();
  live = false; await a.check(); await a.control('stop'); expect(a.busy()).toBe(false);
});
it('decodes split UTF-8 JSONL and publishes only public agent messages after clean exit', async () => {
  const c = connection(), fake = processes(), runner = new CodexCliProcess(c, fake.launch, fake.kill, 20);
  const result = runner.run('hello', undefined, new AbortController().signal, () => {}, () => {});
  const child = fake.last(); child.event({ type: 'thread.started', thread_id: randomUUID() });
  child.event({ type: 'item.completed', item: { type: 'reasoning', id: 'private', text: 'private reasoning' } });
  const bytes = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', id: 'answer', text: 'Привет' } }) + '\n');
  for (const byte of bytes) child.stdout.write(Buffer.of(byte));
  child.event({ type: 'turn.completed' });
  let done = false; void result.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
  child.close(); expect(await result).toEqual(['Привет']);
});
it('confirms stopping a real local child process without invoking a model', async () => {
  const c = connection(); let nativeId = '', pid = 0;
  const launch: SpawnCli = (_exe, _args, options) => spawn(process.execPath, ['-e',
    `console.log(JSON.stringify({type:'thread.started',thread_id:'${randomUUID()}'})); setInterval(()=>{},1000);`], options);
  const runner = new CodexCliProcess(c, launch);
  const result = runner.run('fixture only', undefined, new AbortController().signal, id => { nativeId = id; }, value => { pid = value; });
  const assertion = expect(result).rejects.toThrow('остановлен');
  try {
    await until(() => !!nativeId);
    await runner.stop(); await assertion;
    expect(runner.busy()).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await runner.stop(); }
});
