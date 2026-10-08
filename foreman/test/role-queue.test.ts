import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { Foreman } from '../src/foreman.js';
import { RoleQueue } from '../src/role-queue.js';
import type { AgentRuntime } from '../src/agent-runtime.js';
import { silentLogger } from '../src/context.js';
import { testConfig, tempDir, rmrf } from './helpers.js';
import { workArguments } from '../src/claude-dialog.js';
import { writeJsonAtomic } from '../src/util/fsx.js';

const dirs: string[] = [], cores: Foreman[] = [], queues: RoleQueue[] = [];
afterEach(async () => { for (const q of queues.splice(0)) await q.stop(); for (const f of cores.splice(0)) await f.close(); for (const d of dirs.splice(0)) rmrf(d); });
function repo(root: string, name: string) {
  const cwd = path.join(root, name); fs.mkdirSync(cwd);
  git(cwd, 'init'); fs.writeFileSync(path.join(cwd, 'file.txt'), 'initial'); commit(cwd); return cwd;
}
function git(cwd: string, ...args: string[]) { return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(cwd: string) { git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'change'); return git(cwd, 'rev-parse', 'HEAD'); }
async function fixture() {
  const root = tempDir('role-queue-'); dirs.push(root);
  const cwd = repo(root, 'one'), other = repo(root, 'two');
  const fm = new Foreman({ config: testConfig(path.join(root, 'home'), ['--backend', 'observer']), logger: silentLogger }); cores.push(fm);
  const project = await fm.repos.add(cwd), project2 = await fm.repos.add(other);
  const ids: string[] = [];
  for (const name of ['Dev1', 'Dev2', 'Review1']) {
    fm.teamAction('team.create', { revision: fm.team!.snapshot().revision, agent: { name, provider: name === 'Dev2' ? 'claude' : 'codex', roles: ['developer', 'reviewer'], enabled: true, visible: true, appearance: { skin: 'marlow', color: '#123456', slim: false } } });
    ids.push(fm.team!.snapshot().agents.at(-1)!.id);
  }
  const busy = new Set<string>(), keys = new Map(ids.map(id => [id, id]));
  const calls: { id: string; text: string; work: any }[] = [];
  const runtime = { idle: (id: string) => !busy.has(id), workUnavailable: (id: string) => busy.has(id) ? 'Агент занят' : undefined,
    connectionKey: (id: string) => keys.get(id)!,
    sendWork: vi.fn(async (id: string, text: string, work: any) => { calls.push({ id, text, work }); busy.add(id); return { chatDelivered: true }; }),
    control: vi.fn(async (id: string, action: string) => { if (action === 'resume') busy.add(id); else busy.delete(id); return { agentId: id, chatControl: action }; }),
  };
  const q = new RoleQueue(fm, runtime as unknown as AgentRuntime); queues.push(q);
  const action = (a: string, p: any = {}) => q.action(a, p);
  async function create(p: any = {}) {
    await action('create', { title: 'Task', description: 'Implement', expected: 'Tested', repoId: project.id, developerId: ids[0], reviewerId: ids[2], ...p });
    const i = q.data.items.at(-1)!; await action('approve', { id: i.id }); return i;
  }
  function change(target = cwd) { fs.appendFileSync(path.join(target, 'file.txt'), '\nchange'); return commit(target); }
  async function done(i: typeof q.data.items[number]) {
    const a = i.attempt!; change(fm.repos.require(fm.tasks.require(i.id).repoId!).path);
    const p = { id: i.id, run: a.run, agentId: a.agentId, status: 'done', summary: 'Implemented', checks: 'test suite', ci: 'pass' };
    await action('report', p); busy.delete(a.agentId); await q.tick(); return p;
  }
  return { root, cwd, other, project, project2, fm, ids, busy, keys, calls, runtime, q, action, create, change, done };
}

it('dispatches explicit assignments, exact commit ranges and returns corrections to the same developer', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start');
  expect(x.calls[0]?.id).toBe(x.ids[0]); expect(i.stage).toBe('coding');
  const p = await x.done(i); expect(i.stage).toBe('review'); expect(x.calls[1]?.id).toBe(x.ids[2]);
  expect(x.calls[1]?.text).toContain(JSON.stringify(i.ranges));
  const run = i.attempt!.run, head = i.head;
  await x.action('review.report', { id: i.id, run, agentId: x.ids[2], head, verdict: 'changes', summary: 'Fix X' });
  x.busy.delete(x.ids[2]!); await x.q.tick();
  expect(i.attempt?.agentId).toBe(x.ids[0]); expect(x.calls[2]?.text).toContain('Fix X');
  expect(await x.action('report', p)).toEqual({ duplicate: true });
  await x.done(i); expect(i.ranges).toHaveLength(2);
  await x.action('review.report', { id: i.id, run: i.attempt!.run, agentId: x.ids[2], head: i.head, verdict: 'pass', summary: 'Good' });
  expect(i.stage).toBe('done'); expect(x.fm.tasks.require(i.id).status).toBe('done');
});
it('selects first free enabled agents in roster order and never chooses the developer as reviewer', async () => {
  const x = await fixture(); x.fm.team!.setAssignment(true, x.fm.team!.snapshot().revision); x.busy.add(x.ids[0]!);
  const i = await x.create({ developerId: null, reviewerId: null }); await x.action('start');
  expect(i.developerId).toBe(x.ids[1]); expect(i.reviewerId).toBe(x.ids[2]);
});
it('rejects self-review before task creation', async () => {
  const x = await fixture(); await expect(x.create({ reviewerId: x.ids[0] })).rejects.toThrow('разными'); expect(x.q.data.items).toHaveLength(0);
});
it('waits with a board reason when automatic assignment is off or a reviewer is unavailable', async () => {
  const x = await fixture(), i = await x.create({ developerId: null }); await x.action('start');
  expect(i.reason).toContain('Назначь'); expect(x.calls).toHaveLength(0);
  await x.action('assign', { id: i.id, developerId: x.ids[0], reviewerId: x.ids[2] });
  // already dispatched by assign; a separate queued task waits behind the active task
  expect(i.stage).toBe('coding');
  const y = await fixture(); y.busy.add(y.ids[2]!); const j = await y.create(); await y.action('start');
  expect(j.reason).toContain('Ожидаю ревьюера'); expect(y.fm.tasks.require(j.id).blockedReason).toBe(j.reason); expect(y.calls).toHaveLength(0);
});
it('no-review finishes after a checked commit and never invokes the reviewer', async () => {
  const x = await fixture(); x.busy.add(x.ids[2]!); const i = await x.create({ noReview: true, reviewerId: null });
  await x.action('start'); await x.done(i); expect(i.stage).toBe('done'); expect(x.calls).toHaveLength(1); expect(i.lock).toBeUndefined();
});
it('rejects done without checks, a new commit, or a clean working copy', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start');
  const p = { id: i.id, run: i.attempt!.run, agentId: x.ids[0], status: 'done', summary: 'ok' };
  await expect(x.action('report', p)).rejects.toThrow('проверки');
  await expect(x.action('report', { ...p, checks: 'test', ci: 'pass' })).rejects.toThrow('коммита');
  fs.writeFileSync(path.join(x.cwd, 'untracked'), 'dirty');
  await expect(x.action('report', { ...p, checks: 'test', ci: 'pass' })).rejects.toThrow(); expect(i.stage).toBe('coding');
});
it('rejects wrong executor, stale run, changed connection and conflicting duplicate', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start'); x.change();
  const p = { id: i.id, run: i.attempt!.run, agentId: x.ids[0], status: 'done', summary: 'ok', checks: 'test', ci: 'pass' };
  await expect(x.action('report', { ...p, agentId: x.ids[1] })).rejects.toThrow('отклонён');
  x.keys.set(x.ids[0]!, 'new'); await expect(x.action('report', p)).rejects.toThrow('изменилось'); x.keys.set(x.ids[0]!, x.ids[0]!);
  await x.action('report', p); await expect(x.action('report', { ...p, summary: 'changed' })).rejects.toThrow('Другой результат');
});
it('a changed HEAD invalidates the review result', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start'); await x.done(i);
  const p = { id: i.id, run: i.attempt!.run, agentId: x.ids[2], head: i.head, verdict: 'pass', summary: 'ok' };
  x.change(); await expect(x.action('review.report', p)).rejects.toThrow('HEAD'); expect(i.stage).toBe('question');
});
it('does not start review or another project while the reporting provider still runs', async () => {
  const x = await fixture(), i = await x.create(); await x.create({ repoId: x.project2.id, developerId: x.ids[1], noReview: true, reviewerId: null });
  await x.action('start'); x.change();
  await x.action('report', { id: i.id, run: i.attempt!.run, agentId: x.ids[0], status: 'done', summary: 'ok', checks: 'tests', ci: 'pass' });
  await x.q.tick(); expect(x.calls).toHaveLength(1);
});
it('a question blocks its project while another project can use a different developer', async () => {
  const x = await fixture(), i = await x.create({ noReview: true, reviewerId: null });
  const same = await x.create({ developerId: x.ids[1], noReview: true, reviewerId: null });
  const other = await x.create({ repoId: x.project2.id, developerId: x.ids[1], noReview: true, reviewerId: null });
  await x.action('start');
  await x.action('report', { id: i.id, run: i.attempt!.run, agentId: x.ids[0], status: 'question', summary: 'Which design?' });
  x.busy.delete(x.ids[0]!);
  x.fm.setAgent(x.ids[0]!, { state: 'done', station: 'lounge' });
  await x.q.tick(); expect(same.reason).toContain(i.id); expect(other.stage).toBe('coding'); expect(i.stage).toBe('question');
  expect(x.fm.agent(x.ids[0]!)?.station).toBe('user');
});
it('pause/resume/stop go to the actual owner and queue controls do not stop unrelated agents', async () => {
  const x = await fixture(), i = await x.create({ developerId: x.ids[1] }); await x.action('start');
  await x.action('pause'); expect(x.runtime.control).not.toHaveBeenCalled();
  let confirm!: () => void; x.runtime.control.mockImplementationOnce(() => new Promise(resolve => { confirm = () => resolve({ agentId: x.ids[1]!, chatControl: 'pause' }); }));
  const pending = x.q.control(x.ids[1]!, 'pause'); await new Promise(resolve => setTimeout(resolve, 0)); expect(i.attempt?.paused).toBeUndefined();
  confirm(); await pending; expect(i.attempt?.paused).toBe(true);
  await x.q.control(x.ids[1]!, 'resume'); expect(i.attempt?.paused).toBe(false);
  await x.q.control(x.ids[1]!, 'stop'); expect(i.stage).toBe('question'); expect(x.q.data.mode).toBe('paused');
});
it('failed stop retains ownership, phase and project lock', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start');
  x.runtime.control.mockRejectedValueOnce(new Error('unconfirmed'));
  await expect(x.q.control(x.ids[0]!, 'stop')).rejects.toThrow('unconfirmed'); expect(i.stage).toBe('coding'); expect(i.lock).toBeTruthy();
});
it('bridge restart never resends a running task, even when queue start is pressed', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start');
  await x.q.stop(); const q = new RoleQueue(x.fm, x.runtime as unknown as AgentRuntime); queues.push(q);
  expect(q.data.mode).toBe('paused'); expect(i.stage).toBe('question'); await q.action('start', {}); expect(x.calls).toHaveLength(1);
  await q.action('retry', { id: i.id, answer: 'Checked and stopped' }); expect(x.calls).toHaveLength(2); expect(i.stage).toBe('coding');
});
it('retry requires an answer before touching the provider', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start'); await x.q.control(x.ids[0]!, 'stop');
  x.runtime.control.mockClear(); await expect(x.action('retry', { id: i.id })).rejects.toThrow('ответ'); expect(x.runtime.control).not.toHaveBeenCalled();
});
it('only developer work enables native Claude editing tools, and only for an authorized project', async () => {
  const x = await fixture(), workspace = path.join(x.root, 'workspace'); fs.mkdirSync(workspace);
  writeJsonAtomic(path.join(workspace, 'access.json'), { version: 1, repositories: [{ id: 'one', name: 'One', path: x.cwd, github: 'example/one' }] });
  const w = { directory: workspace, args: [], instructions: '' };
  expect(workArguments(undefined, w).tools).toBe(''); expect(workArguments({ role: 'reviewer', cwd: x.cwd }, w).tools).toBe('');
  expect(workArguments({ role: 'developer', cwd: x.cwd }, w).tools).toContain('Edit');
  expect(() => workArguments({ role: 'developer', cwd: x.other }, w)).toThrow('не разрешён');
});

it('does not release a reported task while its provider still executes', async () => {
  const x = await fixture(), i = await x.create({ noReview: true }); await x.action('start'); x.change();
  await x.action('report', { id: i.id, run: i.attempt!.run, agentId: x.ids[0], status: 'done', summary: 'ok', checks: 'tests', ci: 'pass' });
  await expect(x.action('release', { id: i.id })).rejects.toThrow('ещё работает'); expect(i.lock).toBeTruthy();
});
it('ordinary completion without the explicit report becomes a question, never done or an automatic retry', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start'); x.busy.delete(x.ids[0]!); await x.q.tick();
  expect(i.stage).toBe('question'); expect(i.reason).toContain('без принятого отчёта'); expect(x.calls).toHaveLength(1);
});
it('a second changes verdict asks the user instead of looping', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start');
  for (let n = 0; n < 2; n++) {
    await x.done(i);
    await x.action('review.report', { id: i.id, run: i.attempt!.run, agentId: x.ids[2], head: i.head, verdict: 'changes', summary: 'Still needs work' });
    x.busy.delete(x.ids[2]!); await x.q.tick();
  }
  expect(i.stage).toBe('question'); expect(x.calls).toHaveLength(4);
});

it('two repository records for the same directory share the project lock', async () => {
  const x = await fixture(); x.fm.store.data.repos.push({ ...structuredClone(x.project), id: 'alias' });
  const i = await x.create({ noReview: true, reviewerId: null });
  const alias = await x.create({ repoId: 'alias', developerId: x.ids[1], noReview: true, reviewerId: null });
  await x.action('start');
  await x.action('report', { id: i.id, run: i.attempt!.run, agentId: x.ids[0], status: 'question', summary: 'Need answer' });
  x.busy.delete(x.ids[0]!); await x.q.tick();
  expect(alias.stage).toBe('queued'); expect(alias.reason).toContain(i.id); expect(x.calls).toHaveLength(1);
});
