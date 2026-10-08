import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeDeveloper } from '../src/agents/claude/developer.js';
import { ClaudeProcess } from '../src/agents/claude/process.js';
import { toolPermission } from '../src/agents/claude/permissions.js';
import { ClaudeAdapter, type AgentAdapter } from '../src/agent-adapters.js';
import { ObserverBackend } from '../src/agents/observer.js';
import { Foreman } from '../src/foreman.js';
import { silentLogger } from '../src/context.js';
import { findClaude } from '../src/studio-review.js';
import { PERMISSION_OPTIONS, parseClientMessage, type Outbound } from '../src/protocol.js';
import { readJson, writeJsonAtomic } from '../src/util/fsx.js';
import { type ProcEntry } from '../src/util/proc.js';
import { processTable } from '../src/util/proc.js';
import type { AgentConnections } from '../src/agent-connections.js';
import { tempDir, rmrf, testConfig, until } from './helpers.js';

const dirs: string[] = [], cores: Foreman[] = [], processes: ClaudeProcess[] = [];
const dir = () => { const d = tempDir('claude-developer-'); dirs.push(d); return d; };
afterEach(async () => {
  for (const f of cores.splice(0)) await f.close();
  for (const p of processes.splice(0)) await p.stop();
  for (const d of dirs.splice(0)) rmrf(d);
});
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' }).toString().trim();
function repo() {
  const cwd = dir(); git(cwd, 'init', '-q'); fs.writeFileSync(path.join(cwd, 'file.txt'), 'base'); commit(cwd); return cwd;
}
function commit(cwd: string) { git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'result'); }
function workspace(cwd: string) {
  const w = dir(); writeJsonAtomic(path.join(w, 'access.json'), { version: 1, repositories: [{ id: 'test', name: 'Test', path: cwd, github: 'example/test' }] });
  writeJsonAtomic(path.join(w, 'conversation.json'), { version: 1, sessionId: randomUUID() });
  for (const name of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) fs.writeFileSync(path.join(w, name), 'Review project');
  return w;
}
function sdk(body: (o: Options, prompt: string) => Promise<string> = async o => {
  const properties = (o.outputFormat as any).schema.properties;
  return JSON.stringify({ id: properties.id.const, run: properties.run.const, agentId: properties.agentId.const, status: 'done', summary: 'ok', checks: 'fixture', ci: 'pass' });
}): typeof query {
  return vi.fn(({ options, prompt }) => {
    const iterator = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: options.sessionId ?? options.resume };
      const result = await body(options, prompt as string);
      yield { type: 'result', subtype: 'success', is_error: false, result, session_id: options.sessionId ?? options.resume };
    })();
    return Object.assign(iterator, { close() {} });
  }) as unknown as typeof query;
}
function developer(queryFn = sdk()) {
  const cwd = repo(), w = workspace(cwd), file = path.join(dir(), 'session.json');
  const permission = vi.fn(() => vi.fn(async () => ({ behavior: 'allow' as const })));
  const d = new ClaudeDeveloper({ agentId: 'test_dev', workspace: w, file, executable: () => process.execPath,
    assertCurrent() {}, permission, queryFn });
  const work = { role: 'developer' as const, cwd, taskId: 't1', run: randomUUID() };
  return { d, cwd, w, file, work, permission, queryFn };
}
it('uses an SDK session in the authorized project and resumes only the same task attempt', async () => {
  const x = developer(); const run = () => x.d.run('Task', new AbortController().signal, { text: 'Task', context: '', retry: false, work: x.work });
  expect(JSON.parse(await run()).summary).toBe('ok'); await run(); x.work.run = randomUUID(); await run();
  const calls = vi.mocked(x.queryFn).mock.calls.map(c => c[0].options!);
  expect(calls[0]!.cwd).toBe(fs.realpathSync(x.cwd)); expect(calls[0]!.allowedTools).toBeUndefined();
  expect(calls[0]!.settingSources).toEqual([]); expect(calls[0]!.permissionMode).toBe('default');
  expect((calls[0]!.outputFormat as any).schema.$schema).toBeUndefined();
  expect(calls[0]!.strictMcpConfig).toBe(true);
  expect(calls[0]!.env?.GIT_ALLOW_PROTOCOL).toBe('agentcraft-none');
  expect(calls[1]!.resume).toBe(calls[0]!.sessionId); expect(calls[2]!.sessionId).not.toBe(calls[0]!.sessionId);
  const hook = calls[0]!.hooks!.PreToolUse![0]!.hooks[0]!;
  expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'file.txt' } } as any, 'use1', { signal: new AbortController().signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
  expect(x.permission.mock.results[0]!.value).toHaveBeenCalled();
});
it('refuses a foreign checkout and missing attempt before invoking SDK', async () => {
  const x = developer();
  await expect(x.d.run('Task', new AbortController().signal, { text: '', context: '', retry: false, work: { ...x.work, cwd: dir() } })).rejects.toThrow('не разрешён');
  await expect(x.d.run('Task', new AbortController().signal)).rejects.toThrow('согласованной');
  expect(x.queryFn).not.toHaveBeenCalled();
});
it('rejects a forged run in the SDK result instead of publishing a completion', async () => {
  const x = developer(sdk(async () => JSON.stringify({ id: 't1', run: randomUUID(), agentId: 'test_dev', status: 'done', summary: 'bad', checks: 'test', ci: 'pass' })));
  await expect(x.d.run('Task', new AbortController().signal, { text: '', context: '', retry: false, work: x.work })).rejects.toThrow();
});
it('rejects SDK process launch in another directory and retains failed turns without a success report', async () => {
  const x = developer(sdk(async o => {
    expect(() => o.spawnClaudeCodeProcess!({ command: process.execPath, args: [], cwd: dir(), env: {} } as any)).toThrow('другом каталоге');
    throw new Error('SDK failure');
  }));
  await expect(x.d.run('Task', new AbortController().signal, { text: '', context: '', retry: false, work: x.work })).rejects.toThrow('SDK failure');
  expect(x.d.isRunning()).toBe(false);
});

async function core() {
  const f = new Foreman({ config: testConfig(dir(), ['--backend', 'observer']), logger: silentLogger }); cores.push(f); return f;
}
it('policy allows local edits, denies push, and routes outside writes through a game permission decision', async () => {
  const f = await core(), cwd = repo();
  f.teamAction('team.create', { revision: f.team!.snapshot().revision, agent: { name: 'Developer', provider: 'claude', roles: ['developer'], enabled: true, visible: true, appearance: { skin: 'wren', color: '#123456', slim: false } } });
  const id = f.team!.snapshot().agents[0]!.id, turn = new AbortController(), phase = vi.fn();
  const permission = toolPermission(f, id, 'worker', cwd, { signal: turn.signal }, 'agentcraft', phase);
  const opts = () => ({ signal: turn.signal, toolUseID: randomUUID(), requestId: randomUUID() });
  expect(await permission('Write', { file_path: path.join(cwd, 'safe.txt') }, opts())).toMatchObject({ behavior: 'allow' });
  expect(await permission('Bash', { command: 'git push origin HEAD' }, opts())).toMatchObject({ behavior: 'deny' });
  const pending = permission('Write', { file_path: path.resolve(cwd, '../..', 'outside.txt') }, opts());
  await until(() => f.decisions.open().length > 0);
  const d = f.decisions.open()[0]!; expect(d.agentId).toBe(id); expect(d.kind).toBe('permission');
  const parsed = parseClientMessage({ v: 2, id: 'answer', type: 'decision.answer', decisionId: d.id, option: PERMISSION_OPTIONS[0] });
  if (!parsed.ok) throw new Error('Invalid test request');
  const out: Outbound[] = []; await f.handle(parsed.msg, m => out.push(m));
  expect(out.some(m => m.type === 'error')).toBe(false);
  expect(await pending).toMatchObject({ behavior: 'allow' }); expect(phase.mock.calls).toEqual([[true], [false]]);
  const cancelled = permission('Write', { file_path: path.resolve(cwd, '../..', 'other.txt') }, opts()); turn.abort();
  expect(await cancelled).toMatchObject({ behavior: 'deny' }); expect(f.decisions.open()).toHaveLength(0);
});

it('keeps stop unconfirmed on missing process data or live descendants; restart recovery never kills a reused PID', async () => {
  const file = path.join(dir(), 'process.json'), spawnedAt = Date.now();
  const root: ProcEntry = { pid: 900001, ppid: 1, created: 'root', createdMs: spawnedAt };
  const kid: ProcEntry = { pid: 900002, ppid: root.pid, created: 'kid', createdMs: spawnedAt };
  writeJsonAtomic(file, { pid: root.pid, spawnedAt, tree: [kid] });
  const table = vi.fn(async (): Promise<ProcEntry[] | undefined> => undefined), kill = vi.fn(async () => [] as number[]), close = vi.fn();
  const p = new ClaudeProcess(file, table, kill);
  await expect(p.stop(close)).rejects.toThrow('проверить'); expect(close).not.toHaveBeenCalled(); expect(p.busy()).toBe(true);
  table.mockResolvedValue([root, kid]); await expect(p.stop(close)).rejects.toThrow('ещё работают'); expect(p.busy()).toBe(true);
  table.mockResolvedValue([{ ...root, created: 'new-root', createdMs: spawnedAt + 20000 }, { ...kid, created: 'new-kid', createdMs: spawnedAt + 20000 }]);
  kill.mockClear(); const recovered = new ClaudeProcess(file, table, kill); await recovered.stop();
  expect(kill).not.toHaveBeenCalled(); expect(recovered.busy()).toBe(false); expect(readJson(file)).toBeNull();
});
it('confirms exit of a real CLI process and its child before releasing the receipt', async () => {
  const p = new ClaudeProcess(path.join(dir(), 'process.json')); processes.push(p);
  const child = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(c.pid); setInterval(()=>{},1000);`],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
  p.attach(child);
  const kid = await new Promise<number>((resolve, reject) => { child.stdout!.once('data', b => resolve(Number(b.toString().trim()))); child.once('error', reject); });
  await p.stop(); expect(p.busy()).toBe(false); expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(() => process.kill(kid, 0)).toThrow();
}, 45000);

it.each(['pause', 'stop', 'unconfirmed'] as const)('adapter %s waits for the SDK process tree and preserves the run on pause', async mode => {
  const cwd = repo(), w = workspace(cwd), storage = dir(), childIds: number[] = [];
  let readable = mode !== 'unconfirmed', session = '';
  const p = new ClaudeProcess(path.join(storage, 'process.json'), () => readable ? processTable() : Promise.resolve(undefined)); processes.push(p);
  const queryFn = vi.fn(({ options: o }) => {
    session = o!.resume ?? o!.sessionId!;
    let finish = () => {};
    const iterator = (async function* () {
      const ended = new Promise<void>(resolve => { finish = resolve; });
      const child = o!.spawnClaudeCodeProcess!({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env: process.env } as any);
      childIds.push(child.pid!);
      yield { type: 'system', subtype: 'init', session_id: session };
      await ended;
    })();
    return Object.assign(iterator, { close: () => finish() });
  }) as unknown as typeof query;
  const d = new ClaudeDeveloper({ agentId: 'test_dev', workspace: w, file: path.join(storage, 'dev.json'), executable: () => process.execPath,
    assertCurrent() {}, permission: () => async () => ({ behavior: 'allow' }), queryFn, process: p });
  const events = { activity: vi.fn(), text: vi.fn(), history: vi.fn() };
  const store = { file: (s: string) => path.join(storage, s), assertCurrent() {} } as unknown as AgentConnections;
  const a = new ClaudeAdapter({ version: 1, agentId: 'test_dev', provider: 'claude', transport: 'claude-code', workspace: w, sessionId: randomUUID() }, store, events,
    { history: async () => [], run: async () => '', stop: async () => {} }, d);
  try {
    await a.poll(); await a.execute('Task', { role: 'developer', cwd, taskId: 't1', run: randomUUID() });
    await until(() => childIds.length === 1);
    const originalSession = session;
    if (!readable) {
      await expect(a.control('pause')).rejects.toThrow('проверить');
      expect(events.activity.mock.calls.at(-1)?.[0]).toBe('unavailable'); expect(a.busy()).toBe(true);
      expect(() => process.kill(childIds[0]!, 0)).not.toThrow(); readable = true;
    }
    await a.control(mode === 'pause' ? 'pause' : 'stop');
    expect(() => process.kill(childIds[0]!, 0)).toThrow(); expect(a.busy()).toBe(false);
    expect(events.activity.mock.calls.at(-1)?.[0]).toBe(mode === 'pause' ? 'paused' : 'stopped');
    if (mode === 'pause') {
      await a.control('resume'); await until(() => childIds.length === 2);
      expect(session).toBe(originalSession); await a.control('stop');
      expect(() => process.kill(childIds[1]!, 0)).toThrow();
    }
    expect(events.text).not.toHaveBeenCalled();
  } finally { readable = true; await a.dispose(); }
}, 60000);

async function queueScenario(real = false) {
  const f = await core(), cwd = repo(), w = workspace(cwd), adapters: AgentAdapter[] = [];
  let developerId = '', reviewerId = '', reviewPrompt = '', liveError = '', finalResult = '';
  fs.writeFileSync(path.join(cwd, 'check.cjs'), `require('node:assert/strict').equal(require('node:fs').readFileSync('test-result.txt','utf8'),'tested');`); commit(cwd);
  const liveQuery: typeof query = args => {
    args.options!.stderr = value => { const error = value.match(/(?:error|invalid|unknown)[^\r\n]{0,350}/i); if (error) liveError = error[0]; };
    const q = query(args);
    const iterator = (async function* () {
      for await (const m of q) {
        yield m;
      }
    })();
    return Object.assign(iterator, { close: () => q.close() }) as ReturnType<typeof query>;
  };
  const queryFn = real ? liveQuery : sdk(async (o, prompt) => {
    expect(o.cwd).toBe(fs.realpathSync(cwd));
    const report = JSON.parse(/JSON без Markdown: (\{[^\n]+?\})\./.exec(prompt)![1]!);
    fs.writeFileSync(path.join(cwd, 'test-result.txt'), 'tested');
    expect(fs.readFileSync(path.join(cwd, 'test-result.txt'), 'utf8')).toBe('tested'); commit(cwd);
    return JSON.stringify({ ...report, summary: 'Implemented', checks: 'file content assertion', ci: 'pass' });
  });
  const backend = new ObserverBackend(f, undefined, (c, store, events) => {
    if (c.provider === 'claude') {
      const activity = events.activity, text = events.text;
      events.activity = (phase, notice) => { if (phase === 'error' || phase === 'unavailable') liveError ||= notice ?? phase; activity(phase, notice); };
      events.text = (value, final) => { if (final) finalResult = value; text(value, final); };
      const d = new ClaudeDeveloper({ agentId: c.agentId, workspace: w, file: path.join(dir(), 'dev.json'),
        executable: () => real ? findClaude() : process.execPath, assertCurrent: () => { store.assertCurrent(c); }, permission: events.permission!, queryFn });
      const a = new ClaudeAdapter(c, store, events, { history: async () => [], run: async () => 'chat', stop: async () => {} }, d);
      adapters.push(a); return a;
    }
    return { start: () => events.activity('idle'), dispose: async () => {}, busy: () => false,
      send: async text => { reviewPrompt = text; return {}; }, control: async () => ({}) };
  });
  await f.start(backend);
  for (const provider of ['claude', 'codex'] as const) {
    f.teamAction('team.create', { revision: f.team!.snapshot().revision, agent: { name: provider, provider, roles: [provider === 'claude' ? 'developer' : 'reviewer'], enabled: true, visible: true, appearance: { skin: 'wren', color: '#123456', slim: false } } });
    const id = f.team!.snapshot().agents.at(-1)!.id;
    const connection = provider === 'claude' ? { provider, transport: 'claude-code', workspace: w, sessionId: (readJson<any>(path.join(w, 'conversation.json'))).sessionId }
      : { provider, transport: 'codex-desktop', threadId: randomUUID(), hostId: 'local', title: 'Test', pipePath: '\\\\.\\pipe\\codex-browser-use-test' };
    await backend.onStudioAction('connection.bind', { id, revision: f.team!.snapshot().revision, connection });
    if (provider === 'claude') developerId = id; else reviewerId = id;
  }
  await until(() => f.agent(developerId)?.controls?.message === true);
  const project = await f.repos.add(cwd);
  await backend.onStudioAction('create', { title: 'SDK task', description: `Create test-result.txt with exactly tested (no newline). Run the supplied check.cjs with node, then git add test-result.txt and git commit -m 'Add tested result'. Node executable: ${process.execPath}. Do not change check.cjs. Return the final JSON report as requested, no helper needed.`, expected: 'Tested and committed', repoId: project.id, developerId, reviewerId });
  const i = (f.store.data.backend.roleQueue as any).items[0];
  await backend.onStudioAction('approve', { id: i.id }); await backend.onStudioAction('start', {});
  await until(() => {
    if (liveError) throw new Error('SDK: ' + liveError);
    if (i.stage === 'question') throw new Error(i.reason + ' SDK: ' + liveError + ' Result: ' + finalResult.slice(0, 800));
    const d = f.decisions.open()[0]; if (d) throw new Error('Live probe needs explicit permission: ' + d.tool);
    return i.attempt?.phase === 'reviewer';
  }, real ? 180000 : 20000);
  expect(i.developerId).toBe(developerId); expect(i.attempt.agentId).toBe(reviewerId);
  expect(reviewPrompt).toContain(JSON.stringify(i.ranges)); expect(git(cwd, 'status', '--porcelain')).toBe('');
  await backend.onStudioAction('review.report', { id: i.id, run: i.attempt.run, agentId: reviewerId, head: i.head, verdict: 'pass', summary: 'Reviewed' });
  expect(i.stage).toBe('done'); expect(fs.existsSync(path.join(cwd, 'test-result.txt'))).toBe(true);
  execFileSync(process.execPath, ['check.cjs'], { cwd, windowsHide: true, stdio: 'pipe' });
}
it('Claude developer commits in the checkout, reports its run through runtime, then another agent reviews', () => queueScenario());
it.skipIf(process.env.AGENTCRAFT_TEST_REAL_CLAUDE !== '1')('LIVE: real Claude SDK writes, tests, commits and reports; reviewer transport is simulated', () => queueScenario(true), 240000);
