// Explicit portable integration check: node tools/test/studio-package.mjs <package directory>.
// Uses a separate port/home and no desktop binding; never sends a message to the user's chat.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { ForemanClient } from '../lib/foremanclient.mjs';
import { randomUUID } from 'node:crypto';
import { Client } from '../../foreman/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../foreman/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const pkg = path.resolve(process.argv[2]);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcraft-package-check-'));
const home = path.join(temp, 'data'); const repo = path.join(temp, 'repo'); const port = 17878;
const workspace = path.join(temp, 'workspace'), claudeHome = path.join(temp, 'claude');
const sessionId = randomUUID(); let parent = null, transcript;
async function nativeMessage(role, text) {
  const uuid = randomUUID(); await fs.appendFile(transcript, JSON.stringify({ type: role, uuid, parentUuid: parent, sessionId, cwd: workspace, timestamp: new Date().toISOString(), message: { role, content: [{ type: 'text', text }] } }) + '\n'); parent = uuid; return uuid;
}
let child, client, currentProfile = 'smoke';
async function launch(profile = 'smoke') {
  currentProfile = profile;
  child = spawn(path.join(pkg, 'runtime/node.exe'), [path.join(pkg, 'foreman/src/observer-main.mjs'), '--home', home, '--profile', currentProfile, '--port', String(port), '--repo', repo],
    { windowsHide: true, stdio: 'ignore', env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, AGENTCRAFT_CHAT_CONFIG: path.join(temp, 'no-binding.json') } });
  client = await ForemanClient.connect({ port, timeoutMs: 15000 });
  let owner;
  for (let n = 0; n < 100 && !owner; n++) {
    try { owner = JSON.parse(await fs.readFile(path.join(home, currentProfile, 'portable.json'), 'utf8')); }
    catch { if (child.exitCode !== null) throw new Error('Isolated bridge exited'); await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(owner, 'Isolated bridge initialization must finish');
  assert.equal(owner.pid, child.pid, 'Must use only the isolated test bridge');
}
async function stop() {
  client?.close(); client = undefined;
  const owner = JSON.parse(await fs.readFile(path.join(home, currentProfile, 'portable.json'), 'utf8'));
  const exited = new Promise(resolve => child.once('exit', resolve));
  await fs.writeFile(path.join(home, currentProfile, 'portable-stop.json'), JSON.stringify(owner));
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Bridge did not stop')), 10000).unref())]);
  child = undefined;
}
try {
  await fs.mkdir(repo);
  execFileSync('git', ['init', '-q', repo], { windowsHide: true });
  await fs.writeFile(path.join(repo, 'README.txt'), 'Smoke fixture');
  execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'Fixture'], { cwd: repo, windowsHide: true });
  await fs.mkdir(workspace); await fs.mkdir(path.join(home, 'smoke'), { recursive: true });
  for (const name of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) await fs.writeFile(path.join(workspace, name), 'Smoke fixture');
  await fs.writeFile(path.join(workspace, 'access.json'), JSON.stringify({ version: 1, repositories: [{ id: 'fixture', name: 'Fixture', path: repo, github: 'Fixture/Fixture' }] }));
  await fs.writeFile(path.join(workspace, 'conversation.json'), JSON.stringify({ version: 1, sessionId }));
  await fs.writeFile(path.join(home, 'smoke', 'claude-workspace.json'), JSON.stringify({ directory: workspace }));
  const project = path.join(claudeHome, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-')); await fs.mkdir(project, { recursive: true });
  transcript = path.join(project, sessionId + '.jsonl');
  await nativeMessage('user', 'Previous message'); const originalCursor = await nativeMessage('assistant', 'Previous reply');
  await launch('team-smoke');
  assert.equal(client.state.agents.size, 0, 'A new profile must not create demo agents');
  let team = (await client.send('studio.action', { action: 'team.get', payload: {} })).result;
  assert.equal(team.revision, 0);
  for (const provider of ['codex', 'codex', 'claude']) {
    team = (await client.send('studio.action', { action: 'team.create', payload: { revision: team.revision, agent: {
      name: 'Agent', provider, roles: ['developer', 'reviewer'], enabled: true, visible: true,
      appearance: { skin: 'marlow', color: '#123456', slim: false },
    } } })).result;
  }
  assert.equal(client.state.agents.size, 3);
  const persona = id => client.send('studio.action', { action: 'persona.get', payload: { agentId: id } }).then(a => a.result);
  const savePersona = payload => client.send('studio.action', { action: 'persona.save', payload });
  const thirdId = team.agents[2].id;
  for (const a of team.agents) {
    const { notice, ...draft } = await persona(a.id);
    assert(draft.description.includes('Нейтральный'));
    await savePersona({ ...draft, description: `Style for ${a.id}` });
  }
  assert.equal((await persona(thirdId)).description, `Style for ${thirdId}`);
  const { notice: ignored, ...stale } = await persona(thirdId);
  const { notice: otherNotice, ...otherDraft } = await persona(team.agents[1].id);
  await savePersona({ ...otherDraft, description: 'Updated second persona' });
  await assert.rejects(savePersona({ ...stale, description: 'Stale overwrite' }), /изменился/);
  const archivedId = team.agents[0].id;
  team = (await client.send('studio.action', { action: 'team.archive', payload: { revision: team.revision, id: archivedId } })).result;
  assert.equal(client.state.agents.has(archivedId), false);
  await assert.rejects(persona(archivedId), /существующего/);
  await stop(); await launch('team-smoke');
  assert.equal(client.state.agents.size, 2);
  assert.equal((await persona(thirdId)).description, `Style for ${thirdId}`, 'Persona survives restart');
  await client.send('studio.action', { action: 'team.restore', payload: { revision: team.revision, id: archivedId } });
  assert.equal(client.state.agents.get(archivedId).enabled, false);
  assert.equal((await persona(archivedId)).description, `Style for ${archivedId}`, 'Archive/restore preserves persona');
  // Real bundled adapters, isolated native SDK transcripts; no model calls or user's chats.
  team = (await client.send('studio.action', { action: 'team.get', payload: {} })).result;
  const codexBinding = { provider: 'codex', transport: 'codex-desktop', threadId: randomUUID(),
    pipePath: '\\\\.\\pipe\\codex-browser-use-missing-fixture', hostId: 'local', title: 'Fixture' };
  const bind = async (id, connection) => {
    const t = (await client.send('studio.action', { action: 'team.get', payload: {} })).result;
    return client.send('studio.action', { action: 'connection.bind', payload: { id, revision: t.revision, connection } });
  };
  await bind(archivedId, codexBinding);
  await assert.rejects(bind(team.agents[1].id, codexBinding), /уже назначен/);
  await bind(team.agents[1].id, { ...codexBinding, threadId: randomUUID() });
  const firstClaude = team.agents[2].id;
  await bind(firstClaude, { provider: 'claude', transport: 'claude-code', workspace, sessionId });
  team = (await client.send('studio.action', { action: 'team.get', payload: {} })).result;
  team = (await client.send('studio.action', { action: 'team.create', payload: { revision: team.revision, agent: {
    name: 'Second Claude', provider: 'claude', roles: ['reviewer'], enabled: true, visible: true,
    appearance: { skin: 'wren', color: '#654321', slim: false },
  } } })).result;
  const secondClaude = team.agents.at(-1).id, secondWorkspace = path.join(temp, 'second-workspace'), secondSession = randomUUID();
  await fs.cp(workspace, secondWorkspace, { recursive: true });
  await fs.writeFile(path.join(secondWorkspace, 'conversation.json'), JSON.stringify({ version: 1, sessionId: secondSession }));
  const secondProject = path.join(claudeHome, 'projects', secondWorkspace.replace(/[^a-zA-Z0-9]/g, '-'));
  await fs.mkdir(secondProject, { recursive: true });
  const secondTranscript = path.join(secondProject, secondSession + '.jsonl'); let secondParent = null;
  async function secondMessage(role, text) {
    const uuid = randomUUID(); await fs.appendFile(secondTranscript, JSON.stringify({ type: role, uuid, parentUuid: secondParent,
      sessionId: secondSession, cwd: secondWorkspace, timestamp: new Date().toISOString(), message: { role, content: [{ type: 'text', text }] } }) + '\n'); secondParent = uuid;
  }
  await secondMessage('user', 'Second previous message'); await secondMessage('assistant', 'Second previous reply');
  await bind(secondClaude, { provider: 'claude', transport: 'claude-code', workspace: secondWorkspace, sessionId: secondSession });
  await client.waitForState(s => [firstClaude, secondClaude].every(id => s.agents.get(id)?.controls?.message), { timeoutMs: 12000 });
  await nativeMessage('user', 'First new input'); await nativeMessage('assistant', 'First isolated answer');
  await secondMessage('user', 'Second new input'); await secondMessage('assistant', 'Second isolated answer');
  await client.waitForState(s => s.feed.some(e => e.agentId === firstClaude && e.fullText === 'First isolated answer') &&
    s.feed.some(e => e.agentId === secondClaude && e.fullText === 'Second isolated answer'), { timeoutMs: 12000 });
  const firstView = (await client.send('studio.action', { action: 'connection.get', payload: { id: firstClaude } })).result;
  assert.equal(JSON.stringify(firstView.history).includes('Second isolated answer'), false);
  await stop(); await launch('team-smoke');
  await client.waitForState(s => s.agents.get(secondClaude)?.controls?.message, { timeoutMs: 12000 });
  const secondView = (await client.send('studio.action', { action: 'connection.get', payload: { id: secondClaude } })).result;
  assert(secondView.history.some(e => e.text === 'Second isolated answer'), 'Per-agent history survives bridge restart');
  // Role queue planning must work offline without sending a model task.
  const roleView = (await client.send('studio.action', { action: 'get' })).result;
  const planned = (await client.send('studio.action', { action: 'create', payload: {
    title: 'Role queue package check', description: 'Do not run a model', expected: 'Persist draft',
    repoId: roleView.repos[0].id, developerId: null, reviewerId: null, noReview: true,
  } })).result.items.at(-1);
  await client.send('studio.action', { action: 'approve', payload: { id: planned.id } });
  await client.send('studio.action', { action: 'start' });
  const waiting = (await client.send('studio.action', { action: 'get' })).result;
  assert.equal(waiting.active, undefined); assert.match(waiting.items.at(-1).blockedReason, /Назначь/);
  await stop(); await launch('team-smoke');
  const resumed = (await client.send('studio.action', { action: 'get' })).result;
  assert.equal(resumed.mode, 'paused'); assert.equal(resumed.items.at(-1).id, planned.id);
  // Legacy smoke below expects the latest native cursor at startup.
  const legacyCursor = parent;
  await stop();
  // Explicit pre-A2 profile fixture: compatibility testing must not rely on a new profile having a cast.
  await fs.writeFile(path.join(home, 'smoke', 'state.json'), JSON.stringify({ version: 1, agents: [{
    id: 'marlow', name: 'Legacy', role: 'lead', color: '#123456', skin: 'marlow',
    state: 'idle', activity: '', station: 'lounge', paused: false, active: true,
  }] }));
  await launch();
  const get = () => client.send('studio.action', { action: 'get' }).then(a => a.result);
  for (let n = 0; n < 80 && (await get()).dialog?.sessionCursor !== legacyCursor; n++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await get()).dialog.sessionCursor, legacyCursor, 'Bundled SDK must read the bound native session');
  assert.equal((await get()).version, 1);
  if (JSON.parse(await fs.readFile(path.join(pkg, 'BUILD.json'))).publicRelease) {
    assert.deepEqual((await get()).skins, ['marlow', 'juniper', 'kit', 'wren', 'rowan', 'tove'], 'Public legacy picker excludes omitted personal skins');
  }
  const created = await client.send('studio.action', { action: 'create', payload: { title: 'Проверка пакета', description: 'Не выполнять', expected: 'Черновик на доске' } });
  const id = created.result.items[0].id;
  await client.send('studio.action', { action: 'approve', payload: { id } });
  await client.send('studio.action', { action: 'note', payload: { title: 'Общая заметка', body: 'Проверка сохранения' } });
  await client.send('studio.action', { action: 'pause' });
  await stop(); await launch();
  const restored = await get();
  assert.equal(restored.mode, 'paused'); assert.equal(restored.items[0].stage, 'queued');
  assert.equal(restored.notes[0].body, 'Проверка сохранения'); assert.equal(restored.active, undefined);
  assert.equal(restored.dialog.sessionCursor, legacyCursor);
  const longReply = 'New terminal reply\n\n' + 'Подробный пункт списка\n'.repeat(80) + '\nПоследний абзац';
  await nativeMessage('user', 'New terminal message'); const nextCursor = await nativeMessage('assistant', longReply);
  for (let n = 0; n < 80 && (await get()).dialog?.sessionCursor !== nextCursor; n++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await get()).dialog.sessionCursor, nextCursor, 'New terminal history must reach the restarted game bridge');
  assert.equal(client.state.feed.filter(f => f.fullText === longReply).length, 1, 'A long reply must reach the console as one complete message with paragraphs');
  assert.equal(path.normalize(restored.helper), path.join(pkg, 'studio.mjs'));
  const helperResult = execFileSync(path.join(pkg, 'runtime/node.exe'), [path.join(pkg, 'studio.mjs'), 'get', '--port', String(port)], { windowsHide: true, encoding: 'utf8' });
  assert.equal(JSON.parse(helperResult).items[0].id, id);
  const binding = { version: 1, workspace, profile: path.join(home, 'smoke'), port, token: randomUUID() };
  for (const directory of [workspace, binding.profile]) await fs.writeFile(path.join(directory, 'planning.json'), JSON.stringify(binding));
  await client.send('studio.action', { action: 'agent', payload: { ...(await get()).profiles.find(p => p.id === 'wren'), enabled: true } });
  await client.send('studio.action', { action: 'plan' });
  const mcp = new Client({ name: 'package-planning-test', version: '1' });
  const transport = new StdioClientTransport({ command: path.join(pkg, 'runtime/node.exe'), args: [path.join(pkg, 'foreman/src/claude-workspace-server.mjs'), '--workspace', workspace], stderr: 'pipe' });
  try {
    await mcp.connect(transport);
    const tools = (await mcp.listTools()).tools;
    assert.equal(tools.find(t => t.name === 'planning_create').annotations.readOnlyHint, false);
    const args = { requestId: 'package-draft', project: 'fixture', title: 'План Клавы', description: 'Не выполнять', expected: 'Только черновик', deps: [id] };
    const call = async () => { const r = await mcp.callTool({ name: 'planning_create', arguments: args }); assert.ok(!r.isError); return JSON.parse(r.content[0].text); };
    const draft = await call(); assert.equal(draft.item.stage, 'plan'); assert.equal((await call()).item.id, draft.item.id);
    assert.equal((await get()).items.length, 2); assert.equal((await get()).active, undefined);
    await stop(); await launch();
    assert.equal((await call()).duplicate, true, 'Bundled planning deduplication must survive restart');
    assert.equal((await get()).items[1].stage, 'plan');
  } finally { await mcp.close(); }
  await stop(); console.log('Portable studio: four agents, persona editor/revision/archive/restart, distinct Codex bindings, duplicate rejection, two native Claude histories/restart, archive/restore, legacy queue/memory, helper and bundled MCP checks passed. No model calls or real chat messages sent.');
} finally {
  client?.close(); if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 });
}
