// Opt-in live planning against a disposable board/workspace, never the user's team or conversation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { Foreman } from '../foreman/src/foreman.ts';
import { ForemanServer } from '../foreman/src/server.ts';
import { ObserverBackend } from '../foreman/src/agents/observer.ts';
import { createAdapter } from '../foreman/src/agent-adapters.ts';
import { loadConfig } from '../foreman/src/config.ts';
import { silentLogger } from '../foreman/src/context.ts';
import { findClaude } from '../foreman/src/studio-review.ts';
import { planningCall } from '../foreman/src/claude-planning.ts';

if (process.argv.slice(2).join(' ') !== '--live') throw Error('Requires explicit --live; invokes your authenticated Claude CLI in a new test conversation.');
const executable = findClaude(); if (!executable) throw Error('Claude CLI missing');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-team-planner-live-'));
const workspace = path.join(root, 'workspace'), repo = path.join(root, 'repo');
fs.mkdirSync(workspace); fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init'); fs.writeFileSync(path.join(repo, 'README.md'), '# Planning fixture\n'); git('add', '.'); git('commit', '-m', 'fixture');
const head = git('rev-parse', 'HEAD'), sessionId = randomUUID();
for (const file of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) fs.writeFileSync(path.join(workspace, file), 'Isolated planning test. Create only the single explicitly requested draft. No code changes or execution.');
fs.writeFileSync(path.join(workspace, 'access.json'), JSON.stringify({ version: 1, repositories: [{ id: 'fixture', name: 'Fixture', path: repo }] }));
fs.writeFileSync(path.join(workspace, 'conversation.json'), JSON.stringify({ version: 1, sessionId }));
async function initializeSession() {
  const child = spawn(executable, ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--session-id', sessionId], { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.resume(); child.stdin.on('error', () => {});
  const timeout = setTimeout(() => child.kill(), 120000);
  try {
    const result = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve(output) : reject(Error(`Claude initialization exit ${code}`))); });
    child.stdin.end('This is an authorized isolated planning smoke test. Reply READY. Do not use tools.');
    const response = JSON.parse(await result); if (response.is_error || response.session_id !== sessionId) throw Error('Initialization session mismatch');
  } finally { clearTimeout(timeout); }
}
console.log('Initializing an isolated native Claude conversation.');
await initializeSession();
const config = loadConfig(['--home', path.join(root, 'home'), '--profile', 'trial', '--backend', 'observer', '--no-notify'], {});
const fm = new Foreman({ config, logger: silentLogger });
let otherSends = 0;
const backend = new ObserverBackend(fm, undefined, (c, store, events) => c.provider === 'claude' ? createAdapter(c, store, events) : ({
  start: () => events.activity('idle'), busy: () => false, dispose: async () => {}, send: async () => { otherSends++; return {}; }, control: async () => ({}),
}));
const server = new ForemanServer(fm, { host: '127.0.0.1', port: 0, validateOutbound: true, log: silentLogger });
const action = (action, payload = {}) => backend.onStudioAction(action, payload);
const until = async (condition, ms = 180000) => { const end = Date.now() + ms; while (!condition()) { if (Date.now() > end) throw Error('Live planning timed out'); await new Promise(r => setTimeout(r, 250)); } };
try {
  await fm.start(backend); const port = await server.start(); const project = await fm.repos.add(repo);
  const create = (provider, roles) => { fm.teamAction('team.create', { revision: fm.team.snapshot().revision, agent: { name: provider, provider, roles, enabled: true, visible: true, appearance: { skin: 'marlow', color: '#123456', slim: false } } }); return fm.team.snapshot().agents.at(-1).id; };
  const planner = create('claude', ['planner', 'reviewer']), developer = create('codex', ['developer']);
  await action('connection.bind', { id: planner, revision: fm.team.snapshot().revision, connection: { provider: 'claude', transport: 'claude-code', workspace, sessionId, executable } });
  await action('connection.bind', { id: developer, revision: fm.team.snapshot().revision, connection: { provider: 'codex', transport: 'codex-desktop', threadId: randomUUID(), hostId: 'local', title: 'No real conversation', pipePath: '\\\\.\\pipe\\codex-browser-use-fixture' } });
  await until(() => fm.agents().find(a => a.id === planner)?.controls?.message, 20000);
  const permit = await action('draft.grant', { agentId: planner, projects: [project.id] });
  fs.writeFileSync(path.join(workspace, 'planning.json'), JSON.stringify({ ...permit, port }), { mode: 0o600 });
  const draft = { requestId: 'live-one', project: project.id, title: 'Planning smoke draft', description: 'Document the fixture after user approval.', expected: 'User reviews this draft before any execution.', deps: [], priority: 20 };
  console.log('Sending the approved one-draft request through the selected Claude adapter.');
  await action('connection.send', { id: planner, purpose: 'message', text: `Authorized smoke test: call planning_list, then planning_create with exactly this JSON: ${JSON.stringify(draft)}. Repeat the identical planning_create once to confirm duplicate=true. Do not approve or start tasks. Reply DONE after tool success.` });
  await until(() => fm.agents().find(a => a.id === planner)?.state === 'done');
  const board = await action('get');
  if (board.items.length !== 1 || board.items[0].stage !== 'plan' || board.active || otherSends) throw Error('Unexpected execution or draft count');
  const item = board.items[0]; if (fm.tasks.require(item.id).createdBy !== planner) throw Error('Wrong draft author');
  const replay = await planningCall(workspace, 'planning_create', draft); if (!replay.duplicate || replay.item.id !== item.id) throw Error('Replay was not idempotent');
  if (git('rev-parse', 'HEAD') !== head || git('status', '--porcelain')) throw Error('Planner changed project');
  const report = { passed: true, selectedClaudeSession: true, unapprovedDrafts: 1, replayDuplicate: true, developmentStarted: false, otherAgentsInvoked: otherSends, gitUnchanged: true };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidence: path.join(root, 'result.json') }));
} finally { await server.stop(); await fm.close(); }
