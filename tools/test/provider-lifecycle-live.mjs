// Continue the opt-in live trial created by providers-live.mjs; never target a personal profile.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ForemanClient } from '../lib/foremanclient.mjs';
const [installArg, evidenceArg, mode, optIn] = process.argv.slice(2);
if (!installArg || !evidenceArg || !['planning', 'controls', 'persistence', 'role-pair'].includes(mode) || optIn !== '--live') throw Error('provider-lifecycle-live <trial installation> <providers evidence> <planning|controls|persistence|role-pair> --live');
const install = path.resolve(installArg), evidenceDir = path.resolve(evidenceArg);
const trialRoot = await fs.realpath(path.dirname(path.dirname(install)));
const insideTrial = async candidate => {
  const relative = path.relative(trialRoot, await fs.realpath(candidate));
  assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Path must stay in this disposable trial');
};
await insideTrial(install); await insideTrial(evidenceDir);
const profile = path.join(install, 'data/portable');
const initial = JSON.parse(await fs.readFile(path.join(evidenceDir, 'result.json')));
assert(initial.passed && initial.installedBridge, 'Require successful providers-live evidence');
const records = initial.records;
assert.equal(records.length, 3);
for (const record of records) await insideTrial(record.workspace);
const owner = JSON.parse(await fs.readFile(path.join(profile, 'portable.json')));
const pids = execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-NetTCPConnection -State Listen -LocalPort 7878).OwningProcess'], { windowsHide: true, encoding: 'utf8' }).trim().split(/\s+/).map(Number);
assert(pids.length && pids.every(p => p === owner.pid), 'Wrong bridge');
let fm = await ForemanClient.connect({ port: 7878 });
const action = async (action, payload = {}) => (await fm.send('studio.action', { action, payload }, { timeoutMs: 30000 })).result;
const view = id => action('connection.get', { id });
const until = async (fn, ms = 180000) => { const end = Date.now() + ms; while (!await fn()) { if (Date.now() > end) throw Error('Live acceptance timed out'); await new Promise(r => setTimeout(r, 500)); } };
const result = { mode, passed: false, cases: [] };
const save = () => fs.writeFile(path.join(evidenceDir, `${mode}-result.json`), JSON.stringify(result, null, 2));
const say = async (id, text) => {
  const n = (await view(id)).history.filter(x => x.role === 'assistant').length;
  await action('connection.send', { id, text });
  await until(async () => { const v = await view(id); if (['error', 'unavailable'].includes(v.phase)) throw Error(v.notice); return v.phase === 'completed' && v.history.filter(x => x.role === 'assistant').length > n; });
  return (await view(id)).history.filter(x => x.role === 'assistant').at(-1).text;
};
// Match the shipped .cmd wrappers' process-local policy; do not change system policy.
const bridge = command => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(install, `${command}-Bridge.ps1`)], { windowsHide: true, stdio: 'ignore', timeout: 30000 });
try {
  const team = await action('team.get');
  assert.equal(team.agents.length, records.length, 'Refuse agents outside this trial');
  for (const a of records) assert(team.agents.some(x => x.id === a.id), 'Missing trial agent');
  const initialBoard = await action('get');
  assert(!initialBoard.active, 'Refuse an active queue');
  for (const repo of initialBoard.repos) await insideTrial(repo.path);
  if (mode === 'planning') {
    const a = records.find(x => x.provider === 'claude'), other = records.find(x => x.provider === 'claude' && x.id !== a.id);
    const marker = `PERSISTED-${a.marker}`;
    await say(a.id, `Explicit acceptance request: use remember to save exactly this note: ${marker}. Then use memory_read to verify it. Reply MEMORY-SAVED. Do not change project files.`);
    assert((await fs.readFile(path.join(a.workspace, 'MEMORY.md'), 'utf8')).includes(marker));
    assert(!(await fs.readFile(path.join(other.workspace, 'MEMORY.md'), 'utf8')).includes(marker));
    result.cases.push({ memoryWrittenByModel: true, otherMemoryUnchanged: true }); await save();
    await action('plan');
    const board = await action('get'), repo = board.repos[0];
    const beforeHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.path, encoding: 'utf8', windowsHide: true });
    const permit = await action('draft.grant', { agentId: a.id, projects: [repo.id] });
    await fs.writeFile(path.join(a.workspace, 'planning.json'), JSON.stringify({ ...permit, port: 7878 }), { flag: 'wx' });
    const draft = { requestId: 'installed-live-draft', project: repo.id, title: 'QA installed planner draft', description: 'Document the fixture after user approval.', expected: 'Only an unapproved draft; no execution.', priority: 10, deps: [] };
    await say(a.id, `Explicit acceptance request: use planning_list, then planning_create with ${JSON.stringify(draft)}. Repeat the identical creation once to verify duplicate=true. Do not approve or start tasks. Reply DONE.`);
    const after = await action('get');
    assert.equal(after.items.length, board.items.length + 1); assert.equal(after.items.at(-1).stage, 'plan'); assert(!after.active);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.path, encoding: 'utf8', windowsHide: true }), beforeHead);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo.path, encoding: 'utf8', windowsHide: true }), '');
    result.cases.push({ installedClaudePlanner: true, unapprovedDraft: true, projectUnchanged: true });
  }
  if (mode === 'controls') {
    for (const a of [records.find(x => x.provider === 'claude'), records.find(x => x.provider === 'codex')]) {
      const others = await Promise.all(records.filter(x => x.id !== a.id).map(async x => ({ id: x.id, history: JSON.stringify((await view(x.id)).history) })));
      await action('connection.send', { id: a.id, text: 'Acceptance test of pause/stop. Without tools, write a numbered list of 500 short distinct testing ideas. Continue until interrupted.' });
      await until(() => fm.state.agents.get(a.id)?.controls?.pause, 15000);
      await action('connection.control', { id: a.id, control: 'pause' });
      await until(async () => (await view(a.id)).phase === 'paused', 15000);
      assert(fm.state.agents.get(a.id)?.controls?.resume);
      await action('connection.control', { id: a.id, control: 'resume' });
      await until(() => fm.state.agents.get(a.id)?.controls?.stop, 15000);
      await action('connection.control', { id: a.id, control: 'stop' });
      await until(async () => (await view(a.id)).phase === 'stopped', 15000);
      for (const o of others) assert.equal(JSON.stringify((await view(o.id)).history), o.history);
      assert((await say(a.id, 'Reply exactly READY-AFTER-STOP. Do not use tools.')).includes('READY-AFTER-STOP'));
      result.cases.push({ provider: a.provider, pauseConfirmed: true, resumeConfirmed: true, stopConfirmed: true, otherHistoriesUnchanged: true, replyAfterStop: true }); await save();
      console.log(`Real pause/resume/stop: ${a.provider}.`);
    }
  }
  if (mode === 'persistence') {
    const a = records.find(x => x.provider === 'claude');
    const before = JSON.stringify((await view(a.id)).history), memory = await fs.readFile(path.join(a.workspace, 'MEMORY.md'), 'utf8');
    let t = await action('team.get'); await action('team.archive', { id: a.id, revision: t.revision });
    assert(!fm.state.agents.has(a.id));
    fm.close(); bridge('Stop'); bridge('Start'); fm = await ForemanClient.connect({ port: 7878 });
    t = await action('team.get'); assert(t.agents.find(x => x.id === a.id).archived);
    await action('team.restore', { id: a.id, revision: t.revision });
    t = await action('team.get'); assert.equal(t.agents.find(x => x.id === a.id).enabled, false);
    await action('team.update', { id: a.id, revision: t.revision, patch: { enabled: true } });
    await until(() => fm.state.agents.get(a.id)?.controls?.message, 30000);
    assert.equal(JSON.stringify((await view(a.id)).history), before);
    assert.equal(await fs.readFile(path.join(a.workspace, 'MEMORY.md'), 'utf8'), memory);
    assert((await say(a.id, 'Use memory_read and repeat the PERSISTED acceptance marker stored there. Do not change it.')).includes(`PERSISTED-${a.marker}`));
    result.cases.push({ archiveHidden: true, restart: true, restoreDisabled: true, sameAgentId: true, historyPreserved: true, memoryPreservedAndReadByModel: true });
  }
  if (mode === 'role-pair') {
    const developer = records.find(x => x.provider === 'codex'), reviewer = records.filter(x => x.provider === 'claude')[1];
    let t = await action('team.get');
    await action('team.update', { id: developer.id, revision: t.revision, patch: { roles: ['developer', 'reviewer', 'planner'] } });
    t = await action('team.get');
    const c = (await view(developer.id)).connection;
    await action('connection.bind', { id: developer.id, revision: t.revision, connection: { ...c, sandbox: 'workspace-write' } });
    await until(() => fm.state.agents.get(developer.id)?.controls?.message, 30000);
    const board = await action('get'), repo = board.repos[0];
    await insideTrial(repo.path);
    assert(board.items.every(x => x.stage === 'plan' || x.stage === 'done'), 'Refuse pre-existing runnable or interrupted tasks');
    const next = await action('create', { title: 'QA real Codex developer and Claude reviewer',
      description: 'In this disposable acceptance project only, create sum.mjs exporting sum(a,b) for numbers, and sum.test.mjs using node:test/assert to test positive numbers, negative numbers and zero. Run node --test sum.test.mjs. Commit both files using git -c user.name=Trial -c user.email=trial@example.invalid -c commit.gpgsign=false commit. Do not push, install packages or touch other folders. Return the required final JSON report; do not invoke the helper CLI.',
      expected: 'Both files committed, tests pass; independent reviewer checks the exact commit.', repoId: repo.id, developerId: developer.id, reviewerId: reviewer.id, noReview: false });
    const taskId = next.items.at(-1).id; result.taskId = taskId; await save();
    await action('approve', { id: taskId }); await action('start');
    try {
      await until(async () => {
        const item = (await action('get')).items.find(x => x.id === taskId);
        if (item.stage === 'question') throw Error(item.blockedReason || item.reason || 'Role queue needs attention');
        if (item.stage === 'done') { result.cases.push({ codexDeveloperClaudeReviewer: true, head: item.head, ci: item.ci, review: item.review }); return true; }
        return false;
      }, 300000);
    } finally { await action('pause'); }
  }
  result.passed = true; await save(); console.log(`Live ${mode}: passed.`);
} catch (e) { result.failure = e.message; await save(); throw e; }
finally { fm.close(); }
