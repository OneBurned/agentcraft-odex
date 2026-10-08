import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Foreman } from '../src/foreman.js';
import { RoleQueue } from '../src/role-queue.js';
import type { AgentRuntime } from '../src/agent-runtime.js';
import { silentLogger } from '../src/context.js';
import { testConfig, tempDir, rmrf, until } from './helpers.js';
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
    assertIdle: (id: string) => { if (busy.has(id)) throw new Error('Агент занят'); return true; },
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

it('an asynchronous SDK failure opens a question while retaining the attempt and project', async () => {
  const x = await fixture(), i = await x.create(); x.q.start(); await x.action('start');
  const attempt = i.attempt;
  (x.runtime as unknown as AgentRuntime).onFailure!(x.ids[0]!, 'SDK could not start');
  await x.q.tick();
  expect(i.stage).toBe('question'); expect(i.reason).toContain('SDK could not start');
  expect(i.attempt).toBe(attempt); expect(i.lock).toBeTruthy();
  expect(x.fm.decisions.open().some(d => d.taskId === i.id)).toBe(true);
});
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
it.each(['pass', 'changes', 'question'] as const)('review %s consumes its key once and rejects foreign keys, agents and malformed verdicts', async verdict => {
  const x = await fixture(), i = await x.create({ developerId: x.ids[1] }); await x.action('start'); await x.done(i);
  const p = { id: i.id, run: i.attempt!.run, agentId: x.ids[2], head: i.head, verdict, summary: 'Reviewed Claude changes' };
  const before = JSON.stringify(i);
  for (const patch of [{ run: randomUUID() }, { agentId: x.ids[0] }, { verdict: 'approved' }, { summary: '' }, { summary: ' '.repeat(3) }, { extra: true }])
    await expect(x.action('review.report', { ...p, ...patch })).rejects.toThrow();
  expect(JSON.stringify(i)).toBe(before);
  x.keys.set(x.ids[2]!, 'changed-review-connection');
  await expect(x.action('review.report', p)).rejects.toThrow('изменилось');
  x.keys.set(x.ids[2]!, x.ids[2]!);
  await x.action('review.report', p);
  const accepted = JSON.stringify(i);
  await expect(x.action('review.report', p)).rejects.toThrow('уже использован');
  await expect(x.action('review.report', { ...p, summary: 'Another summary' })).rejects.toThrow('уже использован');
  expect(JSON.stringify(i)).toBe(accepted);
});
it.each(['tracked', 'staged', 'untracked'] as const)('rejects %s changes during review with a question and preserves the files', async kind => {
  const x = await fixture(), i = await x.create(); await x.action('start'); await x.done(i);
  const p = { id: i.id, run: i.attempt!.run, agentId: x.ids[2], head: i.head, verdict: 'pass', summary: 'Looks good' };
  const file = path.join(x.cwd, kind === 'untracked' ? 'new-file.txt' : 'file.txt'); fs.writeFileSync(file, 'reviewer change');
  if (kind === 'staged') execFileSync('git', ['add', 'file.txt'], { cwd: x.cwd, windowsHide: true });
  await expect(x.action('review.report', p)).rejects.toThrow('несохранённые');
  expect(i.stage).toBe('question'); expect(i.reason).toContain('Ревью отклонено');
  expect(i.receipts[p.run]).toBeUndefined(); expect(fs.readFileSync(file, 'utf8')).toBe('reviewer change');
  expect(x.fm.decisions.open().some(d => d.taskId === i.id && d.agentId === x.ids[2])).toBe(true);
  await expect(x.action('review.report', p)).rejects.toThrow('не активны');
});
it('review keys are rejected after pause/stop and a new attempt never reuses the stopped key', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start'); await x.done(i);
  const p = { id: i.id, run: i.attempt!.run, agentId: x.ids[2], head: i.head, verdict: 'pass', summary: 'Old result' };
  await x.q.control(x.ids[2]!, 'pause'); await expect(x.action('review.report', p)).rejects.toThrow('не активны');
  await x.q.control(x.ids[2]!, 'resume'); await x.q.control(x.ids[2]!, 'stop');
  await expect(x.action('review.report', p)).rejects.toThrow('не активны');
  await x.action('retry', { id: i.id, answer: 'Checked previous process and Git' }); await x.action('start');
  expect(i.attempt?.run).not.toBe(p.run); await expect(x.action('review.report', p)).rejects.toThrow('не активны');
});
it('a dirty project before review is not delivered to the Codex reviewer', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start'); x.change();
  await x.action('report', { id: i.id, run: i.attempt!.run, agentId: x.ids[0], status: 'done', summary: 'Ready', checks: 'Tests', ci: 'pass' });
  fs.writeFileSync(path.join(x.cwd, 'uncommitted.txt'), 'user edit'); x.busy.delete(x.ids[0]!); await x.q.tick();
  expect(i.stage).toBe('question'); expect(x.calls).toHaveLength(1);
});
it('stopping a queue removes failure callbacks and ignores a previously captured callback', async () => {
  const x = await fixture(), i = await x.create(); x.q.start(); await x.action('start');
  const r = x.runtime as unknown as AgentRuntime, failure = r.onFailure!; await x.q.stop();
  expect(r.onFailure).toBeUndefined(); const before = JSON.stringify(x.fm.store.data.backend.roleQueue);
  failure(x.ids[0]!, 'Late Codex error'); await new Promise(resolve => setTimeout(resolve, 0));
  expect(JSON.stringify(x.fm.store.data.backend.roleQueue)).toBe(before); expect(i.stage).toBe('coding');
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
it('dialog stays read-only and directs authorized development to the SDK', async () => {
  const x = await fixture(), workspace = path.join(x.root, 'workspace'); fs.mkdirSync(workspace);
  writeJsonAtomic(path.join(workspace, 'access.json'), { version: 1, repositories: [{ id: 'one', name: 'One', path: x.cwd, github: 'example/one' }] });
  const w = { directory: workspace, args: [], instructions: '' };
  expect(workArguments(undefined, w).tools).toBe(''); expect(workArguments({ role: 'reviewer', cwd: x.cwd }, w).tools).toBe('');
  expect(() => workArguments({ role: 'developer', cwd: x.cwd }, w)).toThrow('SDK');
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

it('a completed task explains its changed HEAD lock and can release the project from the card', async () => {
  const x = await fixture(), i = await x.create({ noReview: true, reviewerId: null }); await x.action('start');
  const next = await x.create({ noReview: true, reviewerId: null });
  x.change(); const a = i.attempt!;
  await x.action('report', { id: i.id, run: a.run, agentId: a.agentId, status: 'done', summary: 'done', ci: 'pass', checks: 'tests' });
  const accepted = i.head; x.change(); x.busy.delete(a.agentId); await x.q.tick();
  expect(i.lock).toBeTruthy(); expect(i.reason).toContain('Освободить проект');
  expect(x.q.view().items[0]?.canReleaseProject).toBe(true); expect(next.reason).toContain(i.id);
  await x.action('release', { id: i.id });
  expect(i.lock).toBeUndefined(); expect(i.head).toBe(accepted); expect(next.stage).toBe('coding');
});
it('release refuses a dirty completed project and tells the user to save changes first', async () => {
  const x = await fixture(), i = await x.create({ noReview: true, reviewerId: null }); await x.action('start'); x.change();
  const a = i.attempt!;
  await x.action('report', { id: i.id, run: a.run, agentId: a.agentId, status: 'done', summary: 'done', ci: 'pass', checks: 'tests' });
  fs.appendFileSync(path.join(x.cwd, 'file.txt'), '\npending edit'); x.busy.delete(a.agentId); await x.q.tick();
  expect(i.reason).toContain('сохрани'); await expect(x.action('release', { id: i.id })).rejects.toThrow(); expect(i.lock).toBeTruthy();
  commit(x.cwd); await x.action('release', { id: i.id }); expect(i.lock).toBeUndefined();
});
it('changed review HEAD can explicitly return to development and the next review includes the new range', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start'); await x.done(i);
  const oldHead = i.head!, oldRun = i.attempt!.run, changedHead = x.change();
  await expect(x.action('review.report', { id: i.id, run: oldRun, agentId: x.ids[2], head: oldHead, verdict: 'pass', summary: 'old' })).rejects.toThrow('HEAD');
  const questionId = x.fm.decisions.open()[0]!.id, count = x.calls.length;
  await expect(x.action('retry', { id: i.id, answer: 'Checked', recovery: 'restore-head' })).rejects.toThrow('Вернуть разработчику');
  expect(i.stage).toBe('question'); expect(i.attempt).toBeUndefined(); expect(x.calls).toHaveLength(count);
  expect(x.q.view().items[0]?.canAssignReviewer).toBe(true);
  expect(x.fm.decisions.open().map(d => d.id)).toEqual([questionId]);
  await x.action('retry', { id: i.id, answer: 'Inspect the added commit', recovery: 'developer' });
  expect(i.stage).toBe('coding'); expect(i.attempt?.agentId).toBe(x.ids[0]); expect(i.attempt?.base).toBe(changedHead);
  expect(i.ranges).toContainEqual({ base: oldHead, head: changedHead }); expect(x.fm.decisions.open()).toHaveLength(0);
  await x.done(i); expect(i.ranges).toHaveLength(3); expect(x.calls.at(-1)?.text).toContain(JSON.stringify(i.ranges));
  await x.action('review.report', { id: i.id, run: i.attempt!.run, agentId: x.ids[2], head: i.head, verdict: 'pass', summary: 'Checked all ranges' });
  expect(i.stage).toBe('done');
});
it('ordinary retry is available after the user restores the originally reviewed HEAD', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start'); await x.done(i);
  const head = i.head!, run = i.attempt!.run;
  git(x.cwd, 'checkout', '-b', 'extra'); x.change();
  await expect(x.action('review.report', { id: i.id, run, agentId: x.ids[2], head, verdict: 'pass', summary: 'stale' })).rejects.toThrow('HEAD');
  git(x.cwd, 'checkout', '--detach', head); // synthetic temporary test repository; no working files discarded
  await x.action('retry', { id: i.id, answer: 'Restored original HEAD', recovery: 'restore-head' });
  expect(i.stage).toBe('review'); expect(i.attempt?.run).not.toBe(run); expect(i.head).toBe(head);
});
it.each(['disable', 'archive'])('can replace a reviewer who becomes unavailable via %s after development', async mode => {
  const x = await fixture(), i = await x.create(); await x.action('start'); await x.action('pause'); await x.done(i);
  const lock = i.lock, ranges = structuredClone(i.ranges);
  x.fm.teamAction(`team.${mode}`, { id: x.ids[2], revision: x.fm.team!.snapshot().revision });
  await x.action('start'); expect(i.stage).toBe('review'); expect(i.attempt).toBeUndefined(); expect(i.reason).toContain('выключен');
  expect(x.q.view().items[0]?.canAssignReviewer).toBe(true);
  await x.action('assign', { id: i.id, reviewerId: x.ids[1] });
  expect(i.attempt?.agentId).toBe(x.ids[1]); expect(i.lock).toBe(lock); expect(i.ranges).toEqual(ranges);
  await x.action('review.report', { id: i.id, run: i.attempt!.run, agentId: x.ids[1], head: i.head, verdict: 'pass', summary: 'replacement review' });
  expect(i.stage).toBe('done'); expect(x.calls).toHaveLength(2);
});
it('reviewer reassignment cannot bypass review, change project/developer, or select an earlier developer', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start'); await x.action('pause'); await x.done(i);
  expect(i.developerIds).toEqual([x.ids[0]]);
  // Persisted task with an earlier second author, e.g. restored from a prior development attempt.
  i.developerIds!.push(x.ids[1]!);
  await expect(x.action('assign', { id: i.id, reviewerId: x.ids[1] })).rejects.toThrow('участвовал');
  await expect(x.action('assign', { id: i.id, reviewerId: x.ids[0] })).rejects.toThrow('разными');
  await expect(x.action('assign', { id: i.id, reviewerId: x.ids[2], noReview: true })).rejects.toThrow('требование ревью');
  await expect(x.action('assign', { id: i.id, reviewerId: x.ids[2], developerId: x.ids[1] })).rejects.toThrow('явного подтверждения');
  await expect(x.action('assign', { id: i.id, reviewerId: x.ids[2], repoId: x.project2.id })).rejects.toThrow('проект');
  expect(i.reviewerId).toBe(x.ids[2]); expect(i.lock).toBeTruthy();
  x.fm.team!.setAssignment(true, x.fm.team!.snapshot().revision); x.busy.add(x.ids[2]!);
  await x.action('assign', { id: i.id, reviewerId: null }); await x.action('start');
  expect(i.attempt).toBeUndefined(); expect(i.reason).toContain('Нет свободного');
});
it('a stopped review question permits replacing its reviewer and keeps the new question with that agent', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start'); await x.done(i);
  await expect(x.action('assign', { id: i.id, reviewerId: x.ids[1] })).rejects.toThrow('текущий запуск');
  await x.q.control(x.ids[2]!, 'stop'); expect(i.attempt).toBeUndefined(); expect(i.stage).toBe('question');
  await x.action('assign', { id: i.id, reviewerId: x.ids[1] });
  expect(x.fm.decisions.open()).toHaveLength(1); expect(x.fm.decisions.open()[0]?.agentId).toBe(x.ids[1]);
  await x.action('retry', { id: i.id, answer: 'Ready for the new reviewer' }); expect(i.attempt?.agentId).toBe(x.ids[1]);
});
it('an empty decision answer is rejected without closing or duplicating the question', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start'); await x.q.control(x.ids[0]!, 'stop');
  const d = x.fm.decisions.open()[0]!;
  expect(() => x.fm.decisions.answer(d.id, 'Повторить после проверки')).toThrow('Напиши ответ');
  expect(x.fm.decisions.open().map(q => q.id)).toEqual([d.id]); expect(d.status).toBe('open');
});
async function correctionRound(x: Awaited<ReturnType<typeof fixture>>) {
  const i = await x.create(); await x.action('start'); await x.done(i); await x.action('pause');
  await x.action('review.report', { id: i.id, run: i.attempt!.run, agentId: x.ids[2], head: i.head, verdict: 'changes', summary: 'Fix the issue' });
  x.busy.delete(x.ids[2]!); return i;
}
function unavailableBetweenAttempts(x: Awaited<ReturnType<typeof fixture>>, mode: string, id: string) {
  // The core UI also guards task pointers. Model a restored/externally changed roster here;
  // the queue must recover this state regardless of how the assignment became unavailable.
  x.fm.team!.change(mode, { id, revision: x.fm.team!.snapshot().revision }, agent => {
    x.q.assertIdle(agent); x.runtime.assertIdle(agent);
  });
  x.fm.syncTeam();
}
async function attachQueueBackend(x: Awaited<ReturnType<typeof fixture>>) {
  await x.fm.start({ name: 'observer', start: async () => {}, stop: async () => {}, submitGoal: async () => {},
    assertAgentIdle: id => { x.q.assertIdle(id); return x.runtime.assertIdle(id); },
    onUserMessage: () => {}, onTaskAction: () => {}, onAgentAction: () => {}, onDecisionSettled: d => x.q.onDecision(d) });
}
it.each(['disable', 'archive'])('replaces a %s reviewer during corrections without losing project ownership or drain confirmation', async mode => {
  const x = await fixture(), i = await correctionRound(x);
  const lock = i.lock, ranges = structuredClone(i.ranges), authors = [...i.developerIds!];
  unavailableBetweenAttempts(x, mode, x.ids[2]!);
  // Removing a disabled adapter makes runtime.idle false, even though its prior stop was confirmed.
  vi.spyOn(x.runtime, 'idle').mockImplementation(id => id !== x.ids[2] && !x.busy.has(id));
  expect(x.q.view().items[0]?.canAssignReviewer).toBe(true);
  await x.action('assign', { id: i.id, reviewerId: x.ids[1] });
  expect(i.lock).toBe(lock); expect(i.ranges).toEqual(ranges); expect(i.developerIds).toEqual(authors);
  expect(x.q.data.draining).not.toContain(x.ids[2]);
  await x.action('start'); expect(i.stage).toBe('coding'); expect(i.attempt?.agentId).toBe(x.ids[0]);
  await x.done(i); expect(i.attempt?.agentId).toBe(x.ids[1]);
});
it.each(['disable', 'archive'])('explicitly replaces a %s developer after changes and keeps both authors out of review', async mode => {
  const x = await fixture(), i = await correctionRound(x); await x.q.tick();
  const lock = i.lock, ranges = structuredClone(i.ranges);
  unavailableBetweenAttempts(x, mode, x.ids[0]!);
  await x.action('start'); expect(i.attempt).toBeUndefined(); expect(i.reason).toContain('выключен');
  expect(x.q.view().items[0]?.canAssignDeveloper).toBe(true);
  await expect(x.action('assign', { id: i.id, developerId: x.ids[1] })).rejects.toThrow('подтверждения');
  const assign = { id: i.id, developerId: x.ids[1], confirmDeveloperChange: true };
  fs.appendFileSync(path.join(x.cwd, 'file.txt'), '\ndirty');
  await expect(x.action('assign', assign)).rejects.toThrow();
  expect(i.developerId).toBe(x.ids[0]); expect(i.ranges).toEqual(ranges);
  fs.writeFileSync(path.join(x.cwd, 'file.txt'), git(x.cwd, 'show', 'HEAD:file.txt'));
  x.change(); await expect(x.action('assign', assign)).rejects.toThrow('HEAD');
  git(x.cwd, 'checkout', '--detach', i.head!); // the test branch retains the extra commit
  await x.action('assign', assign); expect(i.attempt?.agentId).toBe(x.ids[1]);
  expect(i.lock).toBe(lock); expect(i.ranges).toEqual(ranges); expect(i.developerIds).toEqual([x.ids[0], x.ids[1]]);
  await x.action('pause'); await x.done(i);
  await expect(x.action('assign', { id: i.id, reviewerId: x.ids[0] })).rejects.toThrow('участвовал');
  await expect(x.action('assign', { id: i.id, reviewerId: x.ids[1] })).rejects.toThrow('разными');
});
it('changes reviewer during a developer question without changing its owner, and transfers developer only after explicit confirmation', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start'); await x.action('pause');
  await x.q.control(x.ids[0]!, 'stop'); await x.action('retry', { id: i.id, answer: 'Stopped and checked' });
  // A pre-dispatch question has no live attempt; emulate the dirty-Git gate on the next dispatch.
  fs.appendFileSync(path.join(x.cwd, 'file.txt'), '\ndirty'); await x.action('start');
  expect(i.stage).toBe('question'); expect(i.attempt).toBeUndefined();
  const question = x.fm.decisions.open()[0]!;
  await x.action('assign', { id: i.id, reviewerId: x.ids[1] });
  expect(x.fm.decisions.open()[0]?.id).toBe(question.id); expect(question.agentId).toBe(x.ids[0]);
  fs.writeFileSync(path.join(x.cwd, 'file.txt'), git(x.cwd, 'show', 'HEAD:file.txt'));
  await x.action('assign', { id: i.id, developerId: x.ids[2], confirmDeveloperChange: true });
  expect(x.fm.decisions.open()).toHaveLength(1); expect(x.fm.decisions.open()[0]?.agentId).toBe(x.ids[2]);
  expect(i.stage).toBe('question'); expect(i.lock).toBeTruthy(); expect(i.developerIds).toContain(x.ids[0]);
});
it('reopens the same question through Foreman.answerDecision when review retry rejects changed HEAD', async () => {
  const x = await fixture();
  await attachQueueBackend(x);
  const i = await x.create(); await x.action('start'); await x.done(i);
  await x.q.control(x.ids[2]!, 'stop'); const d = x.fm.decisions.open()[0]!; x.change();
  await x.fm.answerDecision(d.id, 'Повторить после проверки', 'Проверь');
  await until(() => d.status === 'open');
  expect(d.context).toContain('HEAD'); expect(d.answer).toBeUndefined();
  expect(x.fm.decisions.open().map(q => q.id)).toEqual([d.id]);
  expect(x.fm.store.data.decisions.filter(q => q.taskId === i.id)).toHaveLength(1);
  expect(i.stage).toBe('question'); expect(x.calls).toHaveLength(2);
});
it('permits explicit developer replacement for a pre-dispatch question with no project lock yet', async () => {
  const x = await fixture(), i = await x.create({ noReview: true, reviewerId: null });
  fs.appendFileSync(path.join(x.cwd, 'file.txt'), '\ndirty'); await x.action('start');
  expect(i.stage).toBe('question'); expect(i.lock).toBeUndefined();
  expect(x.q.view().items[0]?.canAssignDeveloper).toBe(true);
  fs.writeFileSync(path.join(x.cwd, 'file.txt'), git(x.cwd, 'show', 'HEAD:file.txt'));
  await x.action('assign', { id: i.id, developerId: x.ids[1], confirmDeveloperChange: true });
  expect(i.stage).toBe('question'); expect(i.developerIds).toEqual([]);
  expect(x.fm.decisions.open()[0]?.agentId).toBe(x.ids[1]); expect(x.calls).toHaveLength(0);
});
it('pause on a question reaches the real executor without setting the task pause flag', async () => {
  const x = await fixture(), i = await x.create(); await x.action('start');
  await x.action('report', { id: i.id, run: i.attempt!.run, agentId: x.ids[0], status: 'question', summary: 'Need an answer' });
  expect(i.stage).toBe('question'); const before = i.attempt!.paused;
  await x.q.control(x.ids[0]!, 'pause');
  expect(x.runtime.control).toHaveBeenCalledWith(x.ids[0], 'pause'); expect(i.attempt!.paused).toBe(before);
  await expect(x.q.control(x.ids[0]!, 'resume')).rejects.toThrow('вопрос');
});
it.each(['missing-report', 'question', 'blocked', 'stop'])('%s reserves its developer until resolution instead of dispatching a second project to the same agent', async trigger => {
  const x = await fixture();
  const a = await x.create({ noReview: true, reviewerId: null });
  const b = await x.create({ noReview: true, reviewerId: null, repoId: x.project2.id });
  await x.action('start');
  if (trigger === 'stop') await x.q.control(x.ids[0]!, 'stop');
  else if (trigger !== 'missing-report') await x.action('report', { id: a.id, run: a.attempt!.run, agentId: x.ids[0], status: trigger, summary: 'Need input' });
  x.busy.delete(x.ids[0]!); await x.q.tick();
  expect(a.stage).toBe('question'); expect(a.attempt?.agentId).toBe(x.ids[0]);
  expect(b.stage).toBe('queued'); expect(b.reason).toContain(a.id); expect(x.calls).toHaveLength(1);
  await x.action('cancel', { id: a.id });
  expect(b.stage).toBe('coding'); expect(x.calls.at(-1)?.id).toBe(x.ids[0]);
  await x.q.control(x.ids[0]!, 'pause'); expect(b.attempt?.paused).toBe(true);
  await x.q.control(x.ids[0]!, 'resume'); expect(b.attempt?.paused).toBe(false);
  await x.q.control(x.ids[0]!, 'stop'); expect(b.stage).toBe('question'); expect(a.stage).toBe('cancelled');
});
it('auto selection skips an idle adapter with an unresolved attempt in another project', async () => {
  const x = await fixture(), a = await x.create({ noReview: true, reviewerId: null });
  const b = await x.create({ noReview: true, reviewerId: null, repoId: x.project2.id, developerId: null });
  x.fm.team!.setAssignment(true, x.fm.team!.snapshot().revision);
  await x.action('start'); x.busy.delete(x.ids[0]!); await x.q.tick();
  expect(a.stage).toBe('question'); expect(b.attempt?.agentId).toBe(x.ids[1]);
});
it('legacy overlapping attempts route controls and hints to the active task and cannot stop it through an old question', async () => {
  const x = await fixture(), a = await x.create({ noReview: true, reviewerId: null });
  const b = await x.create({ noReview: true, reviewerId: null, repoId: x.project2.id });
  await x.action('start'); await x.q.control(x.ids[0]!, 'stop');
  // Reproduce the old scheduler's live overlapping state, which new dispatch now rejects.
  b.attempt = { ...a.attempt!, run: randomUUID(), base: git(x.other, 'rev-parse', 'HEAD') };
  b.stage = 'coding'; b.lock = fs.realpathSync(x.other); x.q.data.active = b.id; x.busy.add(x.ids[0]!);
  const previous = structuredClone(a);
  x.q.start(); expect((x.runtime as unknown as AgentRuntime).projectHint?.(x.ids[0]!)).toContain(b.id);
  await x.q.control(x.ids[0]!, 'pause'); expect(b.attempt.paused).toBe(true); expect(a).toEqual(previous);
  await x.q.control(x.ids[0]!, 'resume'); expect(b.attempt.paused).toBe(false);
  x.runtime.control.mockClear();
  for (const action of ['retry', 'cancel']) {
    await expect(x.action(action, { id: a.id, answer: 'Old answer' })).rejects.toThrow(b.id);
    expect(x.runtime.control).not.toHaveBeenCalled(); expect(a).toEqual(previous); expect(b.stage).toBe('coding');
  }
  await x.q.control(x.ids[0]!, 'stop'); expect(b.stage).toBe('question'); expect(a).toEqual(previous);
});
