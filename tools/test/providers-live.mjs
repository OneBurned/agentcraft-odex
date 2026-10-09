// Opt-in acceptance against a clean, already installed trial bridge. Calls real models.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { ForemanClient } from '../lib/foremanclient.mjs';

const [installationArg, trialArg, claude, codex, live] = process.argv.slice(2);
if (!installationArg || !trialArg || !claude || !codex || live !== '--live') throw Error('providers-live <trial installation> <new evidence directory> <claude.exe> <codex.exe> --live');
const installation = path.resolve(installationArg), trial = path.resolve(trialArg);
const profile = path.join(installation, 'data/portable');
const owner = JSON.parse(await fs.readFile(path.join(profile, 'portable.json')));
const installed = JSON.parse(await fs.readFile(path.join(installation, 'installation.json')));
assert(installed.game, 'Require a managed trial installation');
await fs.mkdir(trial);
assert.equal((await fs.realpath(trial)).toLowerCase(), realpathSync(trial).toLowerCase(), 'Use a trial directory outside redirected AppData.');
const listeningPids = execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-NetTCPConnection -State Listen -LocalPort 7878).OwningProcess'], { windowsHide: true, encoding: 'utf8' }).trim().split(/\s+/).map(Number);
assert(listeningPids.length && listeningPids.every(pid => pid === owner.pid), 'Port belongs to another bridge');
const fm = await ForemanClient.connect({ port: 7878 });
const action = async (action, payload = {}) => (await fm.send('studio.action', { action, payload }, { timeoutMs: 30000 })).result;
const records = [];
const evidence = { passed: false, installedBridge: true, cases: [], records };
const save = () => fs.writeFile(path.join(trial, 'result.json'), JSON.stringify(evidence, null, 2));
async function initClaude(workspace, sessionId) {
  const child = spawn(claude, ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--session-id', sessionId], { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.resume(); child.stdin.on('error', () => {});
  const timeout = setTimeout(() => child.kill(), 120000);
  try {
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', c => c === 0 ? resolve() : reject(Error(`Claude initialization exit ${c}`))); });
    child.stdin.end('Authorized isolated AgentCraft acceptance test. Reply READY only; do not use tools.');
    await done; const result = JSON.parse(output); assert(!result.is_error); assert.equal(result.session_id, sessionId);
  } finally { clearTimeout(timeout); }
}
async function exchange(id, text) {
  const before = (await action('connection.get', { id })).history.filter(x => x.role === 'assistant').length;
  await action('connection.send', { id, purpose: 'message', text });
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    const view = await action('connection.get', { id });
    if (['error', 'unavailable'].includes(view.phase)) throw Error(`${id}: ${view.notice}`);
    const replies = view.history.filter(x => x.role === 'assistant');
    if (view.phase === 'completed' && replies.length > before) return replies.at(-1).text;
    await new Promise(r => setTimeout(r, 750));
  }
  throw Error(`Model reply timed out for ${id}`);
}
try {
  assert.equal((await action('team.get')).agents.length, 0, 'Refuse an existing team');
  const repo = (await action('get')).repos[0]; assert(repo, 'Setup must register trial project');
  for (const [index, provider] of ['claude', 'claude', 'codex'].entries()) {
    const workspace = provider === 'claude' ? path.join(trial, `claude-${index}`) : repo.path;
    const sessionId = randomUUID();
    if (provider === 'claude') {
      await fs.mkdir(workspace);
      for (const file of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) await fs.writeFile(path.join(workspace, file), 'Isolated acceptance fixture. Use only this conversation. Do not change project files.');
      await fs.writeFile(path.join(workspace, 'access.json'), JSON.stringify({ version: 1, repositories: [{ id: 'fixture', name: 'Fixture', path: repo.path }] }));
      await fs.writeFile(path.join(workspace, 'conversation.json'), JSON.stringify({ version: 1, sessionId }));
      console.log(`Initialize isolated Claude ${index + 1}.`); await initClaude(workspace, sessionId);
    }
    let team = await action('team.get');
    team = await action('team.create', { revision: team.revision, agent: { name: `QA ${provider} ${index + 1}`, provider, roles: ['planner', 'reviewer'], enabled: true, visible: true, appearance: { skin: index ? 'wren' : 'marlow', color: '#123456', slim: false } } });
    const id = team.agents.at(-1).id;
    await action('connection.bind', { id, revision: team.revision, connection: provider === 'claude'
      ? { provider, transport: 'claude-code', workspace, sessionId, executable: claude }
      : { provider, transport: 'codex-cli', workspace, sessionId, executable: codex, sandbox: 'read-only' } });
    records.push({ id, provider, workspace, sessionId, marker: `QA-${randomUUID()}` }); await save();
    await fm.waitForState(s => s.agents.get(id)?.controls?.message, { timeoutMs: 45000, what: `${provider} ready` });
    console.log(`Bound live ${provider} ${index + 1}.`);
  }
  // Distinct markers verify address routing and native continuation without personal content.
  for (const a of records) {
    assert((await exchange(a.id, `Remember our acceptance marker ${a.marker}. Reply with exactly that marker. Do not use tools.`)).includes(a.marker));
    evidence.cases.push({ id: a.id, firstLiveReply: true }); await save();
    console.log(`First real reply: ${a.provider}.`);
  }
  for (const a of records) {
    const reply = await exchange(a.id, 'Reply with our acceptance marker from the previous message. Do not use tools.');
    assert(reply.includes(a.marker));
    const view = await action('connection.get', { id: a.id });
    for (const other of records.filter(x => x.id !== a.id)) assert(!JSON.stringify(view.history).includes(other.marker));
    evidence.cases.push({ id: a.id, nativeContinuation: true, otherMarkersAbsent: true }); await save();
    console.log(`Native continuation and isolation: ${a.provider}.`);
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'portable.json'))).pid, owner.pid);
  evidence.passed = true; await save(); console.log(`Live provider evidence: ${path.join(trial, 'result.json')}`);
} catch (error) { evidence.failure = error.message; await save(); throw error; }
finally { fm.close(); }
